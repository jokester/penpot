// One lane: an MCP server port, and the browser tab that serves it.
//
// A plain async function over nested try/finally, not an async generator. The
// value a generator added was cleanup attached to acquisition, and that comes
// from finally. A function is not pull-based, so a slow renderer cannot stall a
// lane, and there is no rule that the supervisor must remember to call return()
// or leak every resource.
//
// Cancellation is the only way out. The signal reaches every await and every
// child, and aborting unwinds the stack so each finally runs in reverse order
// of acquisition. That single discipline replaces the trap, the exec and the
// fall-through this package exists to delete.

import { fail, isLauncherError } from "../core/errors.ts";
import { allocate, assertUsable, type PortPair, type PortRange } from "../core/ports.ts";
import { workspaceUrl, type AccountRef, type DocumentRef } from "../core/target.ts";
import { wire, type Mode } from "../core/topology.ts";
import type { ExecBackend } from "../exec/backend.ts";
import type { BrowserPool } from "../browser/pool.ts";

/** How long to wait for the plugin to dial before calling the lane failed. */
const CONNECT_TIMEOUT_MS = 90_000;

/** The command the stock image runs for one document. */
const SERVER_ARGV = ["node", "index.js"] as const;

/** Where a lane is in its life. */
export type LaneState = "opening" | "connected" | "failed" | "closing" | "closed";

/**
 * A transition, and everything the TUI needs to render it.
 *
 * `closing` and `closed` are not here: they are the supervisor's, because only
 * it knows the difference between a lane ending and a lane being ended.
 */
export type LaneEvent =
    | { readonly state: "opening"; readonly detail: string }
    | { readonly state: "connected"; readonly clientUrl: string; readonly document: DocumentRef }
    | { readonly state: "failed"; readonly reason: string; readonly log: readonly string[] };

/** What to open. */
export interface LaneSpec {
    readonly id: string;
    readonly account: AccountRef;
    readonly document: DocumentRef;
    readonly mode: Mode;
    readonly headed: boolean;
    /** Absent means allocate one. Ignored when the mode runs no server. */
    readonly port?: PortPair;
    /** Channel and argument fingerprint, which decides which browser it shares. */
    readonly flavour?: string;
}

/** The I/O edges, passed in so the state machine can be driven by fakes. */
export interface LaneDeps {
    /** Absent only for modes that run no server of their own. */
    readonly backend?: ExecBackend;
    readonly pool: BrowserPool;
    readonly portRange: PortRange;
    /** The account's MCP token, for the modes that route by it. */
    readonly userToken?: string;
    readonly connectTimeoutMs?: number;
}

/**
 * Runs a lane until it is cancelled, reporting every transition on the way.
 *
 * Resolves rather than rejects when a lane fails: a failure is a state the TUI
 * renders and offers to retry, not an exception for the supervisor to
 * translate. It resolves only when the lane is over -- after `connected` it
 * parks on the signal, because a thing that emits a few events and then waits
 * is a function.
 */
export async function runLane(
    spec: LaneSpec,
    deps: LaneDeps,
    onEvent: (event: LaneEvent) => void,
    signal: AbortSignal
): Promise<void> {
    let pid: number | null = null;

    try {
        await open(spec, deps, onEvent, signal, (started) => (pid = started));
    } catch (err) {
        // A cancelled lane is not a failed one. The supervisor asked.
        if (signal.aborted) return;
        onEvent({ state: "failed", reason: reasonOf(err), log: pid === null ? [] : (deps.backend?.log(pid) ?? []) });
    }
}

/** The acquisition stack. Every resource is released by the finally that owns it. */
async function open(
    spec: LaneSpec,
    deps: LaneDeps,
    onEvent: (event: LaneEvent) => void,
    signal: AbortSignal,
    notePid: (pid: number) => void
): Promise<void> {
    if (spec.mode !== "exec") {
        fail(
            "mode-not-implemented",
            `v1 implements --mode exec only; ${spec.mode} is in the map but not the launcher (SPEC section 3b)`,
            { mode: spec.mode }
        );
    }

    const backend = deps.backend;
    if (backend === undefined) {
        fail("not-configured", `${spec.mode} needs a deployment, and none is configured`, { mode: spec.mode });
    }

    onEvent({ state: "opening", detail: "choosing a port" });
    const ports = await choosePorts(spec, deps, backend);
    const wiring = wire(spec.mode, spec.account, ports, deps.userToken);

    onEvent({ state: "opening", detail: `starting the MCP server on ${ports.http}` });
    const server = await backend.start(SERVER_ARGV, wiring.serverEnv, signal);
    notePid(server.pid);
    try {
        onEvent({ state: "opening", detail: `waiting for ${ports.http} to answer` });
        const exposure = await backend.expose(ports.http, signal);
        try {
            onEvent({ state: "opening", detail: "opening the workspace" });
            const lease = await deps.pool.lease(
                { account: spec.account.name, headed: spec.headed, flavour: spec.flavour ?? "" },
                { wiring, url: workspaceUrl(spec.account, spec.document) },
                signal
            );
            try {
                onEvent({ state: "opening", detail: "waiting for the plugin to connect" });
                const socket = await lease.waitForPlugin(deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, signal);
                if (socket === null) {
                    fail("unreachable", `the plugin did not dial ${wiring.injectWsUri} in time`, {
                        expected: wiring.injectWsUri ?? "the instance's own socket",
                    });
                }

                onEvent({ state: "connected", clientUrl: exposure.url, document: spec.document });
                await until(signal);
            } finally {
                await lease.close();
            }
        } finally {
            await exposure.close();
        }
    } finally {
        // An exec client dying does not stop what it started (invariant 6).
        await backend.kill(server.pid);
    }
}

/**
 * Settles on a port pair, checking an operator's choice as hard as its own.
 *
 * Both paths ask the container, never the host: Docker publishes the whole
 * range, so every host-side answer is wrong (invariant 5).
 */
async function choosePorts(spec: LaneSpec, deps: LaneDeps, backend: ExecBackend): Promise<PortPair> {
    const busy = await backend.listening();
    if (spec.port === undefined) return allocate(deps.portRange, busy);

    assertUsable(spec.port, deps.portRange, busy);
    return spec.port;
}

/** Parks until the lane is cancelled. */
function until(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** A message for a person, whether the throw was a refusal or a bug. */
function reasonOf(err: unknown): string {
    if (isLauncherError(err)) return err.message;
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
