// The only interface that knows a container runtime exists.
//
// The containers are stock, they are someone else's, and they are moving from
// Docker Compose to Kubernetes. Everything the launcher needs from a runtime
// goes through here so that move is a third implementation rather than a
// rewrite.

import type { Deployment } from "../core/config.ts";

/** What a short command left behind. */
export interface ExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * A process started inside the container, identified the only way that works.
 *
 * The pid is in-container, not a host pid, and it is the whole handle: an exec
 * client dying does not stop what it started (invariant 6), so nothing else can
 * actually end the process.
 */
export interface RemoteProcess {
    readonly pid: number;
}

/**
 * A port made reachable locally, and the way to stop making it so.
 *
 * Closable even when nothing was opened. Under compose the ports are already
 * published and `expose` only proves reachability, while under kubectl with
 * `exposure: "port-forward"` it owns a child process. Keeping one shape means a
 * lane's `finally` never branches on the backend.
 */
export interface Exposure {
    readonly url: string;
    close(): Promise<void>;
}

/**
 * Which of the deployment's containers a command runs in.
 *
 * A role rather than a service name, because the two backends spell the same
 * distinction differently -- compose names a service, kubectl a selector -- and
 * the callers only know which job they want doing.
 */
export type Container = "mcp" | "admin";

/** The uncommon half of `run`'s arguments. */
export interface RunOptions {
    /** Default "mcp": the container that runs the MCP servers. */
    readonly container?: Container;
    /**
     * Written to the command's stdin, which is then closed.
     *
     * The way a secret reaches a command without going on its argv. Both the
     * host's process list and the container's show argv to anything that can
     * look, so a password passed as a flag is a password published.
     */
    readonly stdin?: string;
}

/** How the launcher reaches the container its MCP servers run in. */
export interface ExecBackend {
    readonly kind: "compose" | "kubectl";

    /** Runs a short command in the container and collects its output. */
    run(argv: readonly string[], signal: AbortSignal, options?: RunOptions): Promise<ExecResult>;

    /**
     * Starts a long-lived process there, resolving once its in-container pid is known.
     *
     * `env` must not carry secrets: a container's argv and environment are
     * readable by anything that can look, which is how a worker password leaked
     * once. The only environment a lane passes is its ports.
     */
    start(argv: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<RemoteProcess>;

    /** Ends an in-container pid. */
    kill(pid: number): Promise<void>;

    /** The lines a started process has written, newest last, for a failure report. */
    log(pid: number): readonly string[];

    /** Ports listening inside the container, IPv4 and IPv6 alike (invariant 4). */
    listening(): Promise<number[]>;

    /** Makes an in-container port reachable locally, or proves that it already is. */
    expose(port: number, signal: AbortSignal): Promise<Exposure>;
}

/** Builds the backend a deployment describes. */
export async function backendFor(deployment: Deployment): Promise<ExecBackend> {
    if (deployment.backend === "compose") {
        const { ComposeBackend } = await import("./compose.ts");
        return new ComposeBackend(deployment);
    }
    const { KubectlBackend } = await import("./kubectl.ts");
    return new KubectlBackend(deployment);
}
