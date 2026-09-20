// Watching a tab for the one signal that means it is ready.
//
// The plugin WebSocket opening is the only trustworthy readiness signal
// (invariant 10). The URL stays on the workspace even when unauthenticated, a
// synthetic RPC probe can be answered by an edge proxy, and a response listener
// fires for assets. Each of those was tried and each reported a dead tab as
// healthy.

import type { Page } from "playwright";

import { isPluginSocket, type Wiring } from "../core/topology.ts";

/** A watch started before navigation, because the socket opens during load. */
export interface PluginWatch {
    /** The socket URL once it opens, or null at the timeout. */
    wait(timeoutMs: number, signal: AbortSignal): Promise<string | null>;
    /** Whether the socket has been seen to close since it opened. */
    readonly dropped: boolean;
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
 */
export function watchPluginSocket(page: Page, wiring: Wiring): PluginWatch {
    let seen: string | null = null;
    let dropped = false;
    const waiters = new Set<(url: string) => void>();

    page.on("websocket", (socket) => {
        if (!isPluginSocket(socket.url(), wiring)) return;

        seen = socket.url();
        socket.on("close", () => (dropped = true));
        for (const waiter of waiters) waiter(socket.url());
        waiters.clear();
    });

    return {
        get dropped() {
            return dropped;
        },

        wait(timeoutMs: number, signal: AbortSignal): Promise<string | null> {
            if (seen !== null) return Promise.resolve(seen);

            return new Promise((resolve) => {
                const finish = (url: string | null) => {
                    clearTimeout(timer);
                    waiters.delete(onSocket);
                    signal.removeEventListener("abort", onAbort);
                    resolve(url);
                };
                const onSocket = (url: string) => finish(url);
                const onAbort = () => finish(null);
                const timer = setTimeout(() => finish(null), timeoutMs);

                waiters.add(onSocket);
                signal.addEventListener("abort", onAbort, { once: true });
            });
        },
    };
}
