// An ExecBackend that runs nothing, for tests that are about everything else.
//
// It lives in src/ rather than beside a test because the supervisor's tests
// need it too, and a shared double is worth more than three private ones that
// drift. It models the container as the launcher actually sees it: processes
// identified by an in-container pid, and ports that appear when a process
// starts and vanish when it is killed.

import { fail } from "../core/errors.ts";
import type { ExecBackend, ExecResult, Exposure, RemoteProcess } from "./backend.ts";

/** A process the fake pretends to be running. */
interface FakeProcess {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly ports: readonly number[];
}

/** What a test wants to make go wrong. */
export interface FakeOptions {
    /** Ports already listening before anything starts, as a previous run would leave. */
    readonly listening?: readonly number[];
    /** Answers `run`, for the probes that parse a command's output. */
    readonly runs?: (argv: readonly string[]) => ExecResult | Promise<ExecResult>;
    /** Makes `start` reject with this message instead of starting. */
    readonly failStart?: string;
    /** Makes `expose` reject, as an unreachable port would. */
    readonly failExpose?: boolean;
}

export class FakeExecBackend implements ExecBackend {
    readonly kind = "compose" as const;

    /** Every command `run` was asked for, in order, for assertions. */
    readonly commands: string[][] = [];
    /** Exposures opened and not yet closed. A lane that leaks one fails this. */
    openExposures = 0;

    #nextPid = 100;
    readonly #processes = new Map<number, FakeProcess>();
    readonly #preListening: Set<number>;
    #options: FakeOptions;

    constructor(options: FakeOptions = {}) {
        this.#options = options;
        this.#preListening = new Set(options.listening ?? []);
    }

    /** Changes what goes wrong from here on, for a retry test. */
    set(options: FakeOptions): void {
        this.#options = { ...this.#options, ...options };
    }

    async run(argv: readonly string[], _signal: AbortSignal): Promise<ExecResult> {
        this.commands.push([...argv]);
        return this.#options.runs === undefined ? { code: 0, stdout: "", stderr: "" } : await this.#options.runs(argv);
    }

    async start(
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        signal: AbortSignal
    ): Promise<RemoteProcess> {
        if (signal.aborted) fail("unreachable", "aborted before start", {});
        if (this.#options.failStart !== undefined) fail("probe-failed", this.#options.failStart, {});

        // The same two variables the real server reads, so the fake's idea of
        // which ports appear matches the real one's.
        const ports = [env.PENPOT_MCP_SERVER_PORT, env.PENPOT_MCP_WEBSOCKET_PORT]
            .filter((p): p is string => p !== undefined)
            .map(Number);

        const pid = this.#nextPid++;
        this.#processes.set(pid, { argv: [...argv], env: { ...env }, ports });
        return { pid };
    }

    async kill(pid: number): Promise<void> {
        this.#processes.delete(pid);
    }

    log(pid: number): readonly string[] {
        return this.#processes.has(pid) ? [`fake process ${pid}`] : [];
    }

    async listening(): Promise<number[]> {
        const ports = new Set(this.#preListening);
        for (const process of this.#processes.values()) {
            for (const port of process.ports) ports.add(port);
        }
        return [...ports].sort((a, b) => a - b);
    }

    async expose(port: number, _signal: AbortSignal): Promise<Exposure> {
        // Faithful to compose: exposing means proving something answers, so a
        // port nothing is serving is refused rather than quietly exposed.
        if (this.#options.failExpose === true || !(await this.listening()).includes(port)) {
            fail("unreachable", `nothing answers on ${port}`, { port });
        }

        this.openExposures += 1;
        let closed = false;
        return {
            url: `http://127.0.0.1:${port}/mcp`,
            close: async () => {
                if (closed) return;
                closed = true;
                this.openExposures -= 1;
            },
        };
    }

    /** Pids the fake still considers running, for an ownership assertion. */
    get running(): number[] {
        return [...this.#processes.keys()];
    }
}
