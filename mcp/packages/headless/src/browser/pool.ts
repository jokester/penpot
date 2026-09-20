// Browsers, shared between lanes, one tab each.
//
// Types only for now; `launch.ts` implements them. They live here rather than
// beside the lane because the lane must not be able to name Playwright, and
// because the numbers behind the sharing belong with the interface: measured on
// this host a browser and its first tab cost 527 MB and each further tab 94 MB,
// so five lanes are one browser rather than five.

import type { Wiring } from "../core/topology.ts";

/**
 * What a browser cannot vary between its tabs.
 *
 * The profile holds one session, and headed and headless are different
 * processes, so these three are exactly the axes that force a second browser.
 * Everything else -- the document, the injected socket -- is per tab, which is
 * the measured fact the sharing rests on: three tabs in one context booted with
 * three different `penpotMcpServerURI` values.
 */
export interface BrowserKey {
    readonly account: string;
    readonly headed: boolean;
    /** Channel and argument fingerprint; two flavours cannot share a process. */
    readonly flavour: string;
}

/** What a tab is opened for. */
export interface LeaseInit {
    /** Decides the injected socket and what counts as the plugin's socket. */
    readonly wiring: Wiring;
    /** The workspace URL to open. */
    readonly url: string;
}

/**
 * One tab, held for the life of a lane.
 *
 * Readiness is a method here rather than a free function over a page because
 * the lease already knows the wiring it was opened with. Asking a tab whether
 * *its* plugin has connected cannot then be asked with someone else's ports,
 * which is invariant 11 made structural instead of remembered.
 */
export interface Lease {
    /**
     * Resolves with the plugin socket's URL once the tab dials it, or null on timeout.
     *
     * The only trustworthy readiness signal there is (invariant 10): the URL,
     * an RPC probe and a response listener all report success for a tab that
     * never connected.
     */
    waitForPlugin(timeoutMs: number, signal: AbortSignal): Promise<string | null>;
    /** Closes the tab. The browser goes when its last lease does. */
    close(): Promise<void>;
}

/** Browsers keyed by what they cannot share, leased a tab at a time. */
export interface BrowserPool {
    lease(key: BrowserKey, init: LeaseInit, signal: AbortSignal): Promise<Lease>;
    /** Closes every browser. The supervisor's last act. */
    closeAll(): Promise<void>;
}
