// The Kubernetes execution backend.
//
// The same five operations as compose, against a pod instead of a service. Two
// differences run through all of them.
//
// **The pod is resolved by label, every time.** A pod's name changes on every
// restart, so a name cached at startup is a name that stops existing the first
// time the deployment rolls. The label is the stable handle; the name is looked
// up per call and remembered only for the lifetime of a process we started,
// because that pid means nothing anywhere else.
//
// **`kubectl exec` has no `-e`.** Compose passes environment with a flag; here
// it has to be in the command, so a started process is wrapped in `env K=V`.
// That puts the values on the container's argv, which is exactly why `start`
// documents that it must not carry secrets -- the lane passes two port numbers.

import { spawn, type ChildProcess } from "node:child_process";

import type { Deployment } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import type { Container, ExecBackend, ExecResult, Exposure, RemoteProcess, RunOptions } from "./backend.ts";
import { portMap, type PortMap, type PortPair } from "../core/ports.ts";
import { parseListeningPorts } from "./procnet.ts";
import { reachable, sleep } from "./reach.ts";

/** How long to keep proving a port is reachable before giving up. */
const REACHABLE_TIMEOUT_MS = 30_000;

/** How long to wait for a started process to announce its pid. */
const PID_TIMEOUT_MS = 30_000;

/** How many lines of a started process's output to keep for a failure report. */
const LOG_LINES = 50;

/** Marks the line the wrapper shell prints before it becomes the real process. */
const PID_MARKER = "mcp-headless-pid";

/** The label selector for the pod `manage.py` lives in, unless one is named. */
const DEFAULT_ADMIN_SELECTOR = "app=penpot-backend";

/** Knobs a test needs and an operator does not. */
export interface KubectlOptions {
    readonly reachableTimeoutMs?: number;
    /**
     * The binary to run. Default `kubectl`; `$KUBECTL_BIN` sets it.
     *
     * A path, not a config key, because it is a property of the machine rather
     * than of the deployment -- this cluster is reached through a wrapper that
     * pins a kubeconfig, and its path differs per checkout.
     */
    readonly kubectl?: string;
}

export class KubectlBackend implements ExecBackend {
    readonly kind = "kubectl" as const;

    /** Which binary this will run. Readable so a test can check it. */
    get binary(): string {
        return this.#binary;
    }

    readonly #namespace: string;
    readonly #selector: string;
    readonly #adminSelector: string;
    readonly #context: string | undefined;
    readonly #kubeconfig: string | undefined;
    readonly #exposure: "none" | "port-forward";
    readonly #host: string;
    readonly #binary: string;
    readonly #reachableTimeoutMs: number;
    readonly #ports: PortMap;

    /** Exec clients by in-container pid, so killing a process ends its client. */
    readonly #clients = new Map<number, ChildProcess>();
    /** The pod each pid is in. A pid alone does not say where to send the kill. */
    readonly #pods = new Map<number, string>();
    readonly #logs = new Map<number, string[]>();

    constructor(deployment: Deployment, options: KubectlOptions = {}) {
        if (deployment.kubectl === undefined) {
            fail("not-configured", "the kubectl backend needs a namespace and a selector", {});
        }
        this.#namespace = deployment.kubectl.namespace;
        this.#selector = deployment.kubectl.selector;
        this.#adminSelector = deployment.kubectl.adminSelector ?? DEFAULT_ADMIN_SELECTOR;
        this.#context = deployment.kubectl.context;
        this.#kubeconfig = deployment.kubectl.kubeconfig;
        this.#exposure = deployment.exposure;
        this.#host = deployment.host;
        this.#binary = options.kubectl ?? "kubectl";
        this.#reachableTimeoutMs = options.reachableTimeoutMs ?? REACHABLE_TIMEOUT_MS;
        this.#ports = portMap(deployment.portRange, deployment.upstreamPortRange);
    }

    async run(argv: readonly string[], signal: AbortSignal, options: RunOptions = {}): Promise<ExecResult> {
        const pod = await this.#pod(options.container ?? "mcp", signal);
        const stdin = options.stdin;
        // -i only when there is something to send: without it kubectl still
        // opens a stdin stream and a command that reads until EOF waits for
        // one that never comes.
        const args = ["exec", ...(stdin === undefined ? [] : ["-i"]), pod, "--", ...argv];
        return await this.#collect(args, signal, stdin);
    }

    /**
     * Starts a process and waits for it to say which pid it got.
     *
     * The wrapper prints `$$` and then `exec`s, so the pid it printed is the
     * pid the command ends up with -- the same trick as compose, and for the
     * same reason: reading it off the stream removes the race between writing
     * a pidfile and something reading it.
     */
    async start(
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        signal: AbortSignal
    ): Promise<RemoteProcess> {
        const pod = await this.#pod("mcp", signal);
        const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
        const wrapper = `echo "${PID_MARKER} $$" >&2; exec "$@"`;
        const child = this.#spawn([
            "exec",
            pod,
            "--",
            "sh",
            "-c",
            wrapper,
            PID_MARKER,
            ...(envArgs.length === 0 ? [] : ["env", ...envArgs]),
            ...argv,
        ]);

        const lines: string[] = [];
        const pid = await new Promise<number>((resolveP, rejectP) => {
            const timer = setTimeout(() => done(new Error(`no pid within ${PID_TIMEOUT_MS} ms`)), PID_TIMEOUT_MS);
            const onAbort = () => done(new Error("aborted"));

            const done = (err: Error | null, value?: number) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                if (err === null) {
                    resolveP(value as number);
                } else {
                    child.kill("SIGTERM");
                    rejectP(err);
                }
            };

            signal.addEventListener("abort", onAbort, { once: true });
            child.on("error", (err) => done(err));
            child.on("exit", (code) => done(new Error(`exited with ${code} before printing a pid`)));

            for (const stream of [child.stdout, child.stderr]) {
                stream?.setEncoding("utf8");
                stream?.on("data", (chunk: string) => {
                    for (const line of chunk.split("\n")) {
                        if (line === "") continue;
                        lines.push(line);
                        if (lines.length > LOG_LINES) lines.shift();
                        const match = line.match(new RegExp(`${PID_MARKER} (\\d+)`));
                        if (match?.[1] !== undefined) done(null, Number(match[1]));
                    }
                });
            }
        });

        child.removeAllListeners("exit");
        this.#clients.set(pid, child);
        this.#pods.set(pid, pod);
        this.#logs.set(pid, lines);
        return { pid };
    }

    /**
     * Kills the in-pod process, in the pod it was started in, then its client.
     *
     * The recorded pod matters more here than under compose. If the pod rolled
     * while the lane was up, the pid belongs to something that no longer
     * exists; sending the kill to the *current* pod would be sending it to a
     * pid number that now means a different process.
     */
    async kill(pid: number): Promise<void> {
        const client = this.#clients.get(pid);
        const pod = this.#pods.get(pid);
        this.#clients.delete(pid);
        this.#pods.delete(pid);

        if (pod !== undefined) {
            await this.#collect(["exec", pod, "--", "kill", String(pid)], AbortSignal.timeout(15_000)).catch(
                () => undefined
            );
        }
        client?.kill("SIGTERM");
    }

    log(pid: number): readonly string[] {
        return this.#logs.get(pid) ?? [];
    }

    async listening(): Promise<number[]> {
        const signal = AbortSignal.timeout(20_000);
        const [tcp, tcp6] = await Promise.all([
            this.run(["cat", "/proc/net/tcp"], signal),
            this.run(["cat", "/proc/net/tcp6"], signal),
        ]);

        if (tcp.code !== 0 || tcp6.code !== 0) {
            fail("probe-failed", `could not read /proc/net in ${this.#selector}: ${tcp.stderr || tcp6.stderr}`.trim(), {
                selector: this.#selector,
            });
        }
        return parseListeningPorts(tcp.stdout, tcp6.stdout);
    }

    /**
     * Makes the port reachable, by whichever route the deployment says.
     *
     * `none` is the good case and the default: a hostPort or a node-local
     * Service has already made the port answer on the node's loopback, and
     * there is nothing to own. `port-forward` is for the launcher sitting
     * outside the cluster with no other route in, and it costs a child process
     * per lane -- which is why it is not the default and why closing it is not
     * optional.
     */
    async expose(ports: PortPair, signal: AbortSignal): Promise<Exposure> {
        const forward = this.#exposure === "port-forward" ? await this.#forward(ports, signal) : null;

        try {
            // Only the HTTP half is probed. The WebSocket answers no HTTP
            // request to prove itself with, and under port-forward it came up
            // in the same child as the half that did answer.
            await this.#waitReachable(ports.http, signal, forward?.said);
        } catch (err) {
            await forward?.close();
            throw err;
        }

        return {
            url: `http://${this.#host}:${ports.http}/mcp`,
            close: forward === null ? async () => undefined : forward.close,
        };
    }

    /**
     * Spawns `kubectl port-forward` and resolves once it says it is listening.
     *
     * `--address` is not optional here. Without it kubectl binds both loopback
     * families and is satisfied if *either* succeeds, so on a host where
     * something already holds 127.0.0.1 it binds `[::1]` alone, prints
     * "Forwarding from" and looks healthy -- while every connection to
     * 127.0.0.1 goes to the other thing. Measured: docker-proxy from an
     * unrelated stack held 4601 and the forward came up anyway.
     */
    async #forward(local: PortPair, signal: AbortSignal): Promise<{ close: () => Promise<void>; said: string[] }> {
        const pod = await this.#pod("mcp", signal);
        const upstream = { http: this.#ports.upstream(local.http), ws: this.#ports.upstream(local.ws) };

        // Before spawning, not after. `kubectl port-forward` dials the target
        // inside the pod's network namespace as soon as it starts, and a
        // refusal is fatal to it rather than something it retries:
        //
        //   failed to connect to localhost:4601 inside namespace "...":
        //   dial tcp4 127.0.0.1:4601: connect: connection refused
        //   error: lost connection to pod
        //
        // `start` resolves when the wrapper shell prints its pid, which is
        // before node has bound anything, so without this the forward is
        // always spawned into that window, dies, and leaves the lane waiting
        // thirty seconds on a local port nothing is behind.
        await this.#waitListening(upstream, signal);

        // Both pairs in one child, because both have to arrive. The agent
        // connects to the HTTP port and the browser dials the WebSocket, and a
        // lane with only the first forwarded opens, answers, and never becomes
        // ready -- the plugin dials a local port with nothing behind it and
        // the socket closes again.
        const child = this.#spawn([
            "port-forward",
            "--address",
            this.#host,
            pod,
            `${local.http}:${upstream.http}`,
            `${local.ws}:${upstream.ws}`,
        ]);

        // Kept for the failure message. A forward that comes up and then dies
        // -- the pod rolled, the API server hiccuped -- leaves a lane waiting
        // on a port nothing is behind, and without this the only thing anyone
        // could say about it was "nothing answers".
        const said: string[] = [];
        for (const stream of [child.stdout, child.stderr]) {
            stream?.setEncoding("utf8");
            stream?.on("data", (chunk: string) => {
                for (const line of chunk.split("\n")) if (line.trim() !== "") said.push(line.trim());
            });
        }
        child.on("exit", (code) => said.push(`port-forward exited with ${code}`));

        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            child.kill("SIGTERM");
        };

        try {
            await new Promise<void>((resolveP, rejectP) => {
                const timer = setTimeout(
                    () => done(new Error(`port-forward ${local} never started listening`)),
                    20_000
                );
                const onAbort = () => done(new Error("aborted"));

                const done = (err: Error | null) => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", onAbort);
                    err === null ? resolveP() : rejectP(err);
                };

                signal.addEventListener("abort", onAbort, { once: true });
                child.on("error", (err) => done(err));
                const onExit = (code: number | null) => done(new Error(`port-forward exited with ${code}`));
                child.on("exit", onExit);
                // Two lines, one per pair. Waiting for both means a lane is
                // never handed a forward that is only half up.
                let up = 0;
                child.stdout?.on("data", (chunk: string) => {
                    up += chunk.split("\n").filter((line) => line.includes("Forwarding from")).length;
                    if (up >= 2) {
                        child.removeListener("exit", onExit);
                        done(null);
                    }
                });
            });
        } catch (err) {
            await close();
            throw err;
        }

        return { close, said };
    }

    /** Waits until the container itself has both ports open. */
    async #waitListening(upstream: PortPair, signal: AbortSignal): Promise<void> {
        const deadline = Date.now() + this.#reachableTimeoutMs;
        const wanted = [upstream.http, upstream.ws];

        for (;;) {
            if (signal.aborted) {
                fail("unreachable", `gave up waiting for ${wanted.join(" and ")} in the pod`, { port: upstream.http });
            }
            const open = await this.listening();
            if (wanted.every((port) => open.includes(port))) return;
            if (Date.now() > deadline) {
                const missing = wanted.filter((port) => !open.includes(port));
                fail(
                    "unreachable",
                    `nothing is listening on ${missing.join(" or ")} inside the pod after ` +
                        `${this.#reachableTimeoutMs} ms`,
                    { port: missing[0] ?? upstream.http }
                );
            }
            await sleep(500, signal);
        }
    }

    async #waitReachable(port: number, signal: AbortSignal, said?: readonly string[]): Promise<void> {
        const deadline = Date.now() + this.#reachableTimeoutMs;
        for (;;) {
            if (signal.aborted) fail("unreachable", `gave up waiting for port ${port}`, { port });
            if (await reachable(this.#host, port)) return;
            if (Date.now() > deadline) {
                const why =
                    this.#exposure === "none"
                        ? `; with exposure "none" the port must already be node-local (hostPort or a node-local Service)`
                        : said === undefined || said.length === 0
                          ? ""
                          : `; port-forward said: ${said.slice(-3).join(" / ")}`;
                fail(
                    "unreachable",
                    `nothing answers on ${this.#host}:${port} after ${this.#reachableTimeoutMs} ms${why}`,
                    {
                        port,
                    }
                );
            }
            await sleep(250, signal);
        }
    }

    /** The name of a running pod matching the role's selector. */
    async #pod(role: Container, signal: AbortSignal): Promise<string> {
        const selector = role === "admin" ? this.#adminSelector : this.#selector;
        const result = await this.#collect(
            ["get", "pods", "-l", selector, "--field-selector=status.phase=Running", "-o", "name"],
            signal
        );

        if (result.code !== 0) {
            fail("unreachable", `could not list pods for ${selector}: ${result.stderr.trim().slice(0, 200)}`, {
                selector,
            });
        }

        // `-o name` prints `pod/<name>`, one per line. The first Running one is
        // the answer; the MCP deployment is Recreate with one replica, so there
        // is never a second, and taking the first is only a tiebreak in theory.
        const first = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("pod/"));

        if (first === undefined) {
            fail("unreachable", `no running pod matches ${selector} in namespace ${this.#namespace}`, { selector });
        }
        return first;
    }

    #spawn(args: readonly string[], stdin: "ignore" | "pipe" = "ignore"): ChildProcess {
        const global = [
            ...(this.#kubeconfig === undefined ? [] : ["--kubeconfig", this.#kubeconfig]),
            ...(this.#context === undefined ? [] : ["--context", this.#context]),
            "-n",
            this.#namespace,
        ];
        return spawn(this.#binary, [...global, ...args], { stdio: [stdin, "pipe", "pipe"] });
    }

    #collect(args: readonly string[], signal: AbortSignal, stdin?: string): Promise<ExecResult> {
        return new Promise((resolveP, rejectP) => {
            const child = this.#spawn(args, stdin === undefined ? "ignore" : "pipe");
            if (stdin !== undefined) child.stdin?.end(stdin);
            let stdout = "";
            let stderr = "";

            const onAbort = () => child.kill("SIGTERM");
            signal.addEventListener("abort", onAbort, { once: true });

            child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
            child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
            child.on("error", (err) => {
                signal.removeEventListener("abort", onAbort);
                rejectP(err);
            });
            child.on("close", (code) => {
                signal.removeEventListener("abort", onAbort);
                resolveP({ code: code ?? -1, stdout, stderr });
            });
        });
    }
}
