// Watching a tab for the one signal that means it is ready.
//
// The plugin WebSocket opening is the only trustworthy readiness signal
// (invariant 10). The URL stays on the workspace even when unauthenticated, a
// synthetic RPC probe can be answered by an edge proxy, and a response listener
// fires for assets. Each of those was tried and each reported a dead tab as
// healthy.
//
// Opening is necessary and not sufficient. A socket that opens and closes again
// a moment later satisfied an earlier version of this file, which is how a lane
// came to report itself connected while its server saw no plugin at all. So the
// socket has to stay open for a moment before it counts.

import type { Page } from "playwright";

import { isPluginSocket, type Wiring } from "../core/topology.ts";

/**
 * How long a socket must stay open before it counts as connected.
 *
 * Long enough to catch a socket the server closes on sight -- a duplicate
 * token, a version it will not talk to -- and short enough to be noise beside
 * the ten to twenty seconds a lane takes to open.
 */
export const SETTLE_MS = 2000;

/** Why a tab is not ready, when it is not. */
export type NotReady =
    /** No plugin socket appeared at all. */
    | "timeout"
    /** One appeared and closed again, possibly more than once. */
    | "dropped"
    /** The caller gave up first. */
    | "cancelled";

/** Whether the plugin is connected, and if not, why not. */
export type PluginReadiness =
    { readonly connected: true; readonly url: string } | { readonly connected: false; readonly reason: NotReady };

/** A watch started before navigation, because the socket opens during load. */
export interface PluginWatch {
    wait(timeoutMs: number, signal: AbortSignal): Promise<PluginReadiness>;
}

/** Knobs a test needs and an operator does not. */
export interface WatchOptions {
    /** Overrides {@link SETTLE_MS}, so a test need not wait two seconds. */
    readonly settleMs?: number;
}

/**
 * Starts listening for the plugin's socket on `page`.
 *
 * Must be called before `goto`. The plugin dials during page load, so a
 * listener attached afterwards races the thing it is watching for and loses
 * often enough to look like a timeout.
 *
 * Matching goes through the wiring rather than a port of its own, so the socket
 * looked for is always the socket injected (invariant 11).
 *
 * A socket that closes during the settle does not fail the watch: the plugin may
 * dial again, and waiting costs nothing the caller's own timeout does not
 * already bound. It is remembered, so the eventual answer can say "it tried and
 * the socket closed" rather than the much less useful "nothing happened".
 */
export function watchPluginSocket(page: Page, wiring: Wiring, options: WatchOptions = {}): PluginWatch {
    const settleMs = options.settleMs ?? SETTLE_MS;

    let settledUrl: string | null = null;
    let droppedEver = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const waiters = new Set<(readiness: PluginReadiness) => void>();

    const cancelSettle = () => {
        if (settleTimer === null) return;
        clearTimeout(settleTimer);
        settleTimer = null;
    };

    page.on("websocket", (socket) => {
        if (settledUrl !== null) return;
        if (!isPluginSocket(socket.url(), wiring)) return;

        const url = socket.url();
        cancelSettle();
        settleTimer = setTimeout(() => {
            settleTimer = null;
            settledUrl = url;
            for (const waiter of waiters) waiter({ connected: true, url });
            waiters.clear();
        }, settleMs);

        socket.on("close", () => {
            droppedEver = true;
            // Only a close during the settle unmakes the connection. After it,
            // the lane owns the socket's fate and this watch is done.
            if (settledUrl === null) cancelSettle();
        });
    });

    return {
        wait(timeoutMs: number, signal: AbortSignal): Promise<PluginReadiness> {
            if (settledUrl !== null) return Promise.resolve({ connected: true, url: settledUrl });
            if (signal.aborted) return Promise.resolve({ connected: false, reason: "cancelled" });

            return new Promise((resolve) => {
                const finish = (readiness: PluginReadiness) => {
                    clearTimeout(timer);
                    waiters.delete(onSettled);
                    signal.removeEventListener("abort", onAbort);
                    resolve(readiness);
                };

                const onSettled = (readiness: PluginReadiness) => finish(readiness);
                const onAbort = () => finish({ connected: false, reason: "cancelled" });
                const timer = setTimeout(
                    () => finish({ connected: false, reason: droppedEver ? "dropped" : "timeout" }),
                    timeoutMs
                );

                waiters.add(onSettled);
                signal.addEventListener("abort", onAbort, { once: true });
            });
        },
    };
}
