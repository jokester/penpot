// Browsers, shared between lanes, one tab each.
//
// They live here rather than beside the lane because the lane must not be able
// to name Playwright, and because the numbers behind the sharing belong with
// the interface: measured on this host a browser and its first tab cost 527 MB
// and each further tab 94 MB, so five lanes are one browser rather than five.

import type { AccountRef } from "../core/target.ts";
import type { Wiring } from "../core/topology.ts";
import type { PluginReadiness } from "./page.ts";

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
    /**
     * The X display a headed browser is on.
     *
     * Part of the key because a process is launched onto one display and cannot
     * move: two headed lanes on different screens are two browsers, however
     * much else they share.
     */
    readonly display?: string;
}

/** What a tab is opened for. */
export interface LeaseInit {
    /** Whose session, and therefore whose profile directory, the browser uses. */
    readonly account: AccountRef;
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
     * Resolves once the tab's plugin has dialled and stayed, or says why not.
     *
     * The only trustworthy readiness signal there is (invariant 10): the URL,
     * an RPC probe and a response listener all report success for a tab that
     * never connected. Opening is not enough either -- see `browser/page.ts`.
     */
    waitForPlugin(timeoutMs: number, signal: AbortSignal): Promise<PluginReadiness>;
    /** Closes the tab. The browser goes when its last lease does. */
    close(): Promise<void>;
}

/**
 * One browser process, and the tabs it can open.
 *
 * The narrow view the pool needs, so the refcounting is testable without
 * Playwright. `launch.ts` implements it.
 */
export interface BrowserSession {
    openTab(init: LeaseInit, signal: AbortSignal): Promise<Lease>;
    close(): Promise<void>;
}

/** Starts a browser for a key. Swapped for a fake in the pool's own tests. */
export type Launch = (key: BrowserKey, init: LeaseInit, signal: AbortSignal) => Promise<BrowserSession>;

/** Browsers keyed by what they cannot share, leased a tab at a time. */
export interface BrowserPool {
    lease(key: BrowserKey, init: LeaseInit, signal: AbortSignal): Promise<Lease>;
    /** Closes every browser. The supervisor's last act. */
    closeAll(): Promise<void>;
}

/**
 * Browsers created with their first lease and closed with their last.
 *
 * Worth doing rather than one browser per lane: measured here, three lanes as
 * tabs cost about 715 MB and as separate browsers about 1581 MB.
 *
 * It also dissolves invariant 8 rather than enforcing it. "One profile
 * directory per document" existed only because one browser per lane meant
 * several processes fighting over one profile lock; sharing the process removes
 * the contention and the workaround together.
 */
export class LeasingPool implements BrowserPool {
    readonly #launch: Launch;
    readonly #browsers = new Map<string, { session: BrowserSession; leases: number }>();

    constructor(launch: Launch) {
        this.#launch = launch;
    }

    async lease(key: BrowserKey, init: LeaseInit, signal: AbortSignal): Promise<Lease> {
        const id = identify(key);
        let entry = this.#browsers.get(id);

        if (entry === undefined) {
            entry = { session: await this.#launch(key, init, signal), leases: 0 };
            this.#browsers.set(id, entry);
        }

        let tab: Lease;
        try {
            tab = await entry.session.openTab(init, signal);
        } catch (err) {
            // A browser started for a tab that never opened is a leak, and the
            // lane that would have closed it does not exist.
            await this.#dropIfIdle(id);
            throw err;
        }

        entry.leases += 1;
        return this.#wrap(id, tab);
    }

    async closeAll(): Promise<void> {
        const sessions = [...this.#browsers.values()].map((entry) => entry.session);
        this.#browsers.clear();
        await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    }

    /** Browsers currently open, for an ownership assertion. */
    get open(): number {
        return this.#browsers.size;
    }

    /** Gives back the tab, and the browser too when it was the last one out. */
    #wrap(id: string, tab: Lease): Lease {
        let closed = false;
        return {
            waitForPlugin: (timeoutMs, signal) => tab.waitForPlugin(timeoutMs, signal),
            close: async () => {
                if (closed) return;
                closed = true;

                try {
                    await tab.close();
                } finally {
                    const entry = this.#browsers.get(id);
                    if (entry !== undefined) entry.leases -= 1;
                    await this.#dropIfIdle(id);
                }
            },
        };
    }

    async #dropIfIdle(id: string): Promise<void> {
        const entry = this.#browsers.get(id);
        if (entry === undefined || entry.leases > 0) return;

        this.#browsers.delete(id);
        await entry.session.close().catch(() => undefined);
    }
}

/** The key as one string, since a Map compares objects by identity. */
function identify(key: BrowserKey): string {
    return [key.account, key.headed ? "headed" : "headless", key.flavour, key.display ?? ""].join(" ");
}
