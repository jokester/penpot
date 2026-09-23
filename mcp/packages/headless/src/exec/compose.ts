// The Docker Compose execution backend.
//
// Every command is `docker compose exec` run with the project directory as its
// working directory, which is what the shell script did with `cd $HERE` and is
// the only spelling that works regardless of how the compose file is named.

import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";

import type { Deployment } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { parseListeningPorts } from "./procnet.ts";
import type { ExecBackend, ExecResult, Exposure, RemoteProcess, RunOptions } from "./backend.ts";

/** How long to keep proving a freshly started port is reachable, by default. */
const REACHABLE_TIMEOUT_MS = 30_000;

/** Knobs a test needs and an operator does not. */
export interface ComposeOptions {
    /** How long `expose` keeps retrying before it calls the port unreachable. */
    readonly reachableTimeoutMs?: number;
}

/** The service `manage.py` lives in, when the deployment does not name one. */
const DEFAULT_ADMIN_SERVICE = "penpot-backend";

/** How long to wait for a started process to announce its pid. */
const PID_TIMEOUT_MS = 20_000;

/** How many lines of a started process's output to keep for a failure report. */
const LOG_LINES = 50;

/** Marks the line the wrapper shell prints before it becomes the real process. */
const PID_MARKER = "mcp-headless-pid";

export class ComposeBackend implements ExecBackend {
    readonly kind = "compose" as const;

    readonly #projectDir: string;
    readonly #service: string;
    readonly #adminService: string;
    /** Exec clients by in-container pid, so killing a process also ends its client. */
    readonly #clients = new Map<number, ChildProcess>();
    readonly #logs = new Map<number, string[]>();
    readonly #reachableTimeoutMs: number;

    constructor(deployment: Deployment, options: ComposeOptions = {}) {
        if (deployment.compose === undefined) {
            fail("not-configured", "the compose backend needs projectDir and service", {});
        }
        // Relative paths in the deployment file are relative to the file.
        this.#projectDir = resolve(deployment.configDir, deployment.compose.projectDir);
        this.#service = deployment.compose.service;
        this.#adminService = deployment.compose.adminService ?? DEFAULT_ADMIN_SERVICE;
        this.#reachableTimeoutMs = options.reachableTimeoutMs ?? REACHABLE_TIMEOUT_MS;
    }

    async run(argv: readonly string[], signal: AbortSignal, options: RunOptions = {}): Promise<ExecResult> {
        const service = options.container === "admin" ? this.#adminService : this.#service;
        return await this.#collect(["exec", "-T", service, ...argv], signal, options.stdin);
    }

    /**
     * Starts a process and waits for it to say which pid it got.
     *
     * The wrapper shell prints `$$` and then `exec`s the real command, so the
     * pid it printed is the pid the command ends up with. Reading it off the
     * stream rather than out of a pidfile removes the race the shell script had
     * between writing the file and something reading it.
     */
    async start(
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        signal: AbortSignal
    ): Promise<RemoteProcess> {
        const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
        const wrapper = `echo "${PID_MARKER} $$" >&2; exec "$@"`;
        const child = this.#spawn(["exec", "-T", ...envArgs, this.#service, "sh", "-c", wrapper, PID_MARKER, ...argv]);

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

        // Keep streaming after the pid, so a lane that fails later has a log.
        child.removeAllListeners("exit");
        this.#clients.set(pid, child);
        this.#logs.set(pid, lines);
        return { pid };
    }

    /**
     * Kills the in-container process, then the client that started it.
     *
     * Both halves matter. Killing only the client leaves the process running
     * (invariant 6); killing only the process leaves an exec client attached to
     * nothing.
     */
    async kill(pid: number): Promise<void> {
        const client = this.#clients.get(pid);
        this.#clients.delete(pid);

        await this.#collect(["exec", "-T", this.#service, "kill", String(pid)], AbortSignal.timeout(10_000)).catch(
            () => undefined
        );
        client?.kill("SIGTERM");
    }

    log(pid: number): readonly string[] {
        return this.#logs.get(pid) ?? [];
    }

    async listening(): Promise<number[]> {
        const signal = AbortSignal.timeout(15_000);
        const [tcp, tcp6] = await Promise.all([
            this.run(["cat", "/proc/net/tcp"], signal),
            this.run(["cat", "/proc/net/tcp6"], signal),
        ]);

        if (tcp.code !== 0 || tcp6.code !== 0) {
            fail("probe-failed", `could not read /proc/net in ${this.#service}: ${tcp.stderr || tcp6.stderr}`.trim(), {
                service: this.#service,
            });
        }
        return parseListeningPorts(tcp.stdout, tcp6.stdout);
    }

    /**
     * Proves the port answers on loopback, and opens nothing.
     *
     * Compose publishes the range already, so there is no tunnel to own here --
     * but a port outside the published range starts a server that works
     * perfectly and that nothing can reach (invariant 3), and the honest place
     * to discover that is when the lane opens rather than at the first tool
     * call. This also replaces the shell script's readiness loop: the server
     * has only just been started, so the first few attempts are expected to
     * fail.
     */
    async expose(port: number, signal: AbortSignal): Promise<Exposure> {
        const deadline = Date.now() + this.#reachableTimeoutMs;

        for (;;) {
            if (signal.aborted) fail("unreachable", `gave up waiting for port ${port}`, { port });
            if (await reachable(port)) break;
            if (Date.now() > deadline) {
                fail("unreachable", `nothing answers on 127.0.0.1:${port} after ${this.#reachableTimeoutMs} ms`, {
                    port,
                });
            }
            await sleep(250, signal);
        }

        return { url: `http://127.0.0.1:${port}/mcp`, close: async () => undefined };
    }

    #spawn(args: readonly string[], stdin: "ignore" | "pipe" = "ignore"): ChildProcess {
        return spawn("docker", ["compose", ...args], {
            cwd: this.#projectDir,
            stdio: [stdin, "pipe", "pipe"],
        });
    }

    #collect(args: readonly string[], signal: AbortSignal, stdin?: string): Promise<ExecResult> {
        return new Promise((resolveP, rejectP) => {
            const child = this.#spawn(args, stdin === undefined ? "ignore" : "pipe");
            // Closed immediately after, so a command that reads until EOF --
            // manage.py's password prompt, for one -- does not hang.
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

/**
 * True when something on loopback answers an HTTP request on `port`.
 *
 * An HTTP exchange, not a TCP connect, and the difference is the whole point.
 * Docker's proxy accepts a connection on every published port whether or not
 * anything is behind it inside the container, so a connect to a free port in
 * the range succeeds and then resets. Measured on this host: connecting to a
 * published, unoccupied 4608 succeeded, and the GET that followed failed with
 * ECONNRESET. A connect-based check would have called every port in the range
 * reachable -- the same lie invariant 5 describes, from the other direction.
 *
 * Any response counts, status included. A bare GET to an MCP endpoint is
 * answered with a 4xx, and that is still proof that a server is behind the
 * published port.
 */
function reachable(port: number): Promise<boolean> {
    return new Promise((resolveP) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", timeout: 1000 }, (res) => {
            res.resume();
            resolveP(true);
        });
        req.on("error", () => resolveP(false));
        req.on("timeout", () => {
            req.destroy();
            resolveP(false);
        });
        req.end();
    });
}

/** Waits, unless the signal fires first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolveP) => {
        const timer = setTimeout(finish, ms);
        function finish() {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolveP();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}
