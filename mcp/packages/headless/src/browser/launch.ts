// Playwright, and the only file allowed to name it.
//
// Ported from mcp/packages/host/config.js, which is the working reference. The
// one real change is where the injection happens: per page rather than per
// context, which is what lets several lanes share a browser (SPEC 5).

import { rmSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { AccountRef } from "../core/target.ts";
import type { BrowserKey, BrowserSession, Launch, Lease, LeaseInit } from "./pool.ts";
import type { OpenSessionContext, SessionContext } from "./session.ts";
import { watchPluginSocket } from "./page.ts";

/**
 * Flags that stop Chromium deciding a background tab can be slowed down.
 *
 * Nobody can click a headless tab to wake it. Measured note: timers were not in
 * fact throttled here, and three backgrounded tabs each ticked thirty times in
 * three seconds. A "plugin tab appears to be suspended" error means a
 * version-skewed plugin that sends no heartbeat at all, not a throttled timer.
 * These stay as cheap insurance.
 */
const NO_THROTTLE_ARGS = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
];

/** How long to give a workspace page to load before giving up on the tab. */
const GOTO_TIMEOUT_MS = 60_000;

/** How a browser is started, beyond what the key already decides. */
export interface LaunchOptions {
    /** Playwright channel, e.g. "chrome". Empty means the bundled Chromium. */
    readonly channel?: string;
    /** Extra Chromium flags, e.g. the GL overrides wasm export needs. */
    readonly args?: readonly string[];
    /**
     * Drops the profile's HTTP caches at launch.
     *
     * Penpot serves its MCP plugin as a static asset, so a profile caches it.
     * Against an instance running a mounted plugin build, a stale copy survives
     * the remount and the symptom points elsewhere entirely: the old plugin
     * sends no heartbeat and the server blames a suspended tab. Cookies are
     * untouched -- only the cache directories go.
     */
    readonly clearCache?: boolean;
    /** Overrides how long a plugin socket must stay open to count. */
    readonly settleMs?: number;
}

/**
 * The fingerprint two lanes must share to share a browser.
 *
 * Channel and flags cannot be varied per tab, so they belong in the key
 * alongside the account and headedness.
 */
export function flavourOf(options: LaunchOptions): string {
    return [options.channel ?? "", ...(options.args ?? [])].join(" ").trim() || "default";
}

/** Builds the real `Launch` the pool uses. */
export function playwrightLaunch(options: LaunchOptions = {}): Launch {
    return async (key: BrowserKey, init: LeaseInit, _signal: AbortSignal): Promise<BrowserSession> => {
        const profileDir = init.account.profileDir;
        if (options.clearCache === true) clearHttpCache(profileDir);

        const context = await chromium.launchPersistentContext(profileDir, {
            headless: !key.headed,
            ...(options.channel === undefined || options.channel === "" ? {} : { channel: options.channel }),
            args: [...NO_THROTTLE_ARGS, ...(options.args ?? [])],
            viewport: { width: 1440, height: 900 },
            // A headed browser has to be told which screen. Without this it
            // inherits the launcher's own DISPLAY, so --display was accepted
            // and then quietly ignored.
            ...(key.display === undefined || key.display === ""
                ? {}
                : { env: { ...process.env, DISPLAY: key.display } }),
        });

        // A ws://localhost dialled from a public https origin is a
        // private-network request, refused with
        // ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS without this grant.
        // Unnecessary when both ends are loopback, and harmless there.
        if (init.wiring.injectWsUri !== null) {
            await context.grantPermissions(["local-network-access"], { origin: init.account.origin });
        }

        return new PlaywrightSession(context, options.settleMs);
    };
}

/** One persistent context, handing out tabs. */
class PlaywrightSession implements BrowserSession {
    readonly #context: BrowserContext;
    readonly #settleMs: number | undefined;

    constructor(context: BrowserContext, settleMs?: number) {
        this.#context = context;
        this.#settleMs = settleMs;
    }

    async openTab(init: LeaseInit, signal: AbortSignal): Promise<Lease> {
        const page = await this.#context.newPage();

        try {
            // Per page, not per context. addInitScript runs before page scripts
            // and is scoped to the page it is called on, which is the whole
            // trick behind sharing a browser: three tabs in one context booted
            // with three different penpotMcpServerURI values. Read by
            // app.config/mcp-ws-uri at boot, so it must precede page script.
            if (init.wiring.injectWsUri !== null) {
                await page.addInitScript((uri: string) => {
                    (globalThis as unknown as { penpotMcpServerURI: string }).penpotMcpServerURI = uri;
                }, init.wiring.injectWsUri);
            }

            // Before goto: the plugin dials during load.
            const watch = watchPluginSocket(page, init.wiring, {
                ...(this.#settleMs === undefined ? {} : { settleMs: this.#settleMs }),
            });
            await page.goto(init.url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });

            return {
                waitForPlugin: (timeoutMs, waitSignal) => watch.wait(timeoutMs, waitSignal),
                close: async () => {
                    await page.close().catch(() => undefined);
                },
            };
        } catch (err) {
            await page.close().catch(() => undefined);
            throw err;
        } finally {
            if (signal.aborted) await closeQuietly(page);
        }
    }

    async close(): Promise<void> {
        await this.#context.close().catch(() => undefined);
    }
}

async function closeQuietly(page: Page): Promise<void> {
    await page.close().catch(() => undefined);
}

/** Removes the profile's HTTP caches, leaving its cookies alone. */
function clearHttpCache(profileDir: string): void {
    for (const dir of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage"]) {
        rmSync(join(profileDir, "Default", dir), { recursive: true, force: true });
    }
}

/**
 * Opens a context for logging in, on the account's own profile.
 *
 * Separate from `playwrightLaunch` because a login is not a lane: it wants no
 * injection, no workspace URL and no plugin watch, and it must close the
 * context afterwards so Chromium flushes the cookie jar to disk. Always
 * headless -- the interactive path that needed a window is gone.
 */
export function playwrightSessions(options: LaunchOptions = {}): OpenSessionContext {
    return async (account: AccountRef): Promise<SessionContext> => {
        const context = await chromium.launchPersistentContext(account.profileDir, {
            headless: true,
            ...(options.channel === undefined || options.channel === "" ? {} : { channel: options.channel }),
            args: [...NO_THROTTLE_ARGS, ...(options.args ?? [])],
            viewport: { width: 1440, height: 900 },
        });

        return {
            async cookies() {
                // Unfiltered: Playwright will not return a Secure cookie for
                // an http:// URL, which on loopback hides a session that is
                // there. The store matches the host itself.
                return await context.cookies();
            },
            async post(url: string, body: unknown) {
                const response = await context.request.post(url, {
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    data: body as Record<string, unknown>,
                });
                return { ok: response.ok(), status: response.status(), text: () => response.text() };
            },
            async addCookies(cookies) {
                await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
            },
            async close() {
                await context.close().catch(() => undefined);
            },
        };
    };
}
