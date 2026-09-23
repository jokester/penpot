// Getting a session into a browser profile, once.
//
// Ported from mcp/packages/host/spikes/login.js, minus its interactive half.
// That path opened a window and waited for a person to log in, for accounts
// SSO or 2FA make unscriptable. A worker account is provisioned by us with a
// password we wrote, so it never needed one -- and nothing ever called it,
// which is the more honest reason it is gone.
//
// This must run while no lane is using the account, because one profile
// directory holds one Chromium and two would fight over its lock. In practice
// that means logging in before opening any lane.

import type { Account } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { normalizeOrigin, type AccountRef } from "../core/target.ts";

/** Penpot's session cookie. Its presence is the only proof a login worked. */
const COOKIE = "auth-token";

/** A cookie as the session store needs to see it. */
export interface StoredCookie {
    readonly name: string;
    readonly value: string;
    /** Seconds since the epoch, or -1 for a session-only cookie. */
    readonly expires: number;
    readonly domain?: string;
    readonly path?: string;
    readonly secure?: boolean;
}

/** What a reply to the login RPC looks like, narrowed to what matters. */
export interface PostResult {
    readonly ok: boolean;
    readonly status: number;
    text(): Promise<string>;
}

/**
 * The part of a browser context a login needs.
 *
 * Narrow on purpose: it keeps Playwright out of the logic, and the logic here
 * is the part that has been wrong -- trusting a closed window instead of a
 * stored cookie.
 */
export interface SessionContext {
    /**
     * Every cookie in the jar, unfiltered.
     *
     * Unfiltered because Playwright's own `cookies(url)` will not return a
     * `Secure` cookie for an `http://` URL, loopback included -- so asking it
     * about the origin reports "no session" for a session that is right there.
     * Matching the host here instead makes that decision ours.
     */
    cookies(): Promise<readonly StoredCookie[]>;
    /** Posts through the browser, so Set-Cookie lands in the profile's jar. */
    post(url: string, body: unknown): Promise<PostResult>;
    /** Puts cookies back, which is how a Secure cookie is made usable on loopback. */
    addCookies(cookies: readonly (StoredCookie & { url?: string })[]): Promise<void>;
    close(): Promise<void>;
}

/** Opens a context on an account's profile. `playwrightSessions` provides one. */
export type OpenSessionContext = (account: AccountRef) => Promise<SessionContext>;

/** Putting a session into a profile, and knowing whether one is there. */
export interface SessionStore {
    has(account: AccountRef): Promise<boolean>;
    /**
     * Logs in with the credentials the account file carries.
     *
     * Takes the whole `Account` rather than a loose password, so the password
     * cannot be paired with the wrong email -- and so no caller has to pass a
     * secret around by hand.
     */
    loginWithPassword(account: Account, signal: AbortSignal): Promise<void>;
}

/** Builds a session store over whatever opens contexts. */
export function sessionStore(open: OpenSessionContext): SessionStore {
    /** Runs `body` against a context and always closes it, so the jar is flushed. */
    const withContext = async <T>(account: AccountRef, body: (ctx: SessionContext) => Promise<T>) => {
        const ctx = await open(account);
        try {
            return await body(ctx);
        } finally {
            await ctx.close().catch(() => undefined);
        }
    };

    const cookieOf = async (ctx: SessionContext, account: AccountRef): Promise<StoredCookie | undefined> => {
        const host = hostOf(account.origin);
        return (await ctx.cookies()).find(
            (cookie) => cookie.name === COOKIE && (cookie.domain ?? "").replace(/^\./, "") === host
        );
    };

    return {
        async has(account) {
            return await withContext(account, async (ctx) => (await cookieOf(ctx, account)) !== undefined);
        },

        /**
         * Logs in over the API, so no window is needed.
         *
         * The post goes through the browser's own request context rather than
         * Node's fetch, so the Set-Cookie lands in the profile's cookie jar
         * exactly as a real login would leave it.
         */
        async loginWithPassword(account, signal) {
            if (account.email === undefined || account.password === undefined) {
                fail("not-configured", `${account.name} has no email and password to log in with`, {
                    account: account.name,
                });
            }

            await withContext(account, async (ctx) => {
                const origin = normalizeOrigin(account.origin);
                const result = await ctx.post(`${origin}/api/rpc/command/login-with-password`, {
                    email: account.email,
                    password: account.password,
                });

                if (!result.ok) {
                    const body = (await result.text().catch(() => "")).slice(0, 200);
                    fail("unreachable", `login failed for ${account.name}: HTTP ${result.status} ${body}`.trim(), {
                        account: account.name,
                        status: result.status,
                    });
                }
                if (signal.aborted) return;
                await usableOnLoopback(ctx, account, cookieOf);
                await requireCookie(ctx, account, cookieOf);
            });
        },
    };
}

/**
 * Re-stores a `Secure` session cookie without the flag, on loopback http only.
 *
 * Penpot sets `Secure` whenever the deployment runs with
 * `enable-secure-session-cookies`, which is right for its public https origin
 * and leaves the worker path -- `http://127.0.0.1:<port>`, a node-local
 * Service or an SSH forward -- unable to hold a session at all: the cookie is
 * accepted into the jar and then never sent, so every request is anonymous and
 * the lane fails ninety seconds later as a plugin that never dialled.
 *
 * Narrow on purpose. Only http, and only a loopback host, which is the case
 * where `Secure` protects against nothing: the request never leaves the
 * machine. It is the same reasoning browsers use to call loopback
 * "potentially trustworthy" -- Playwright's cookie filter simply does not
 * implement that carve-out. For any other host the cookie is left exactly as
 * the server set it, because downgrading it there would be a real weakening.
 */
async function usableOnLoopback(
    ctx: SessionContext,
    account: AccountRef,
    cookieOf: (ctx: SessionContext, account: AccountRef) => Promise<StoredCookie | undefined>
): Promise<void> {
    const origin = normalizeOrigin(account.origin);
    if (!origin.startsWith("http://") || !isLoopbackHost(hostOf(origin))) return;

    const cookie = await cookieOf(ctx, account);
    if (cookie === undefined || cookie.secure !== true) return;

    // Domain and path, never `url` -- Playwright takes one or the other and
    // refuses a cookie carrying both. The pair comes straight back off the
    // cookie the server set, so the replacement lands in the same slot.
    await ctx.addCookies([
        { ...cookie, secure: false, domain: cookie.domain ?? hostOf(origin), path: cookie.path ?? "/" },
    ]);
}

/** True for the hosts that never leave this machine. */
function isLoopbackHost(host: string): boolean {
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** The host of an origin, without the port. */
function hostOf(origin: string): string {
    try {
        return new URL(normalizeOrigin(origin)).hostname;
    } catch {
        return origin;
    }
}

/** Confirms the cookie landed, since a 200 with no cookie has happened. */
async function requireCookie(
    ctx: SessionContext,
    account: AccountRef,
    cookieOf: (ctx: SessionContext, account: AccountRef) => Promise<StoredCookie | undefined>
): Promise<void> {
    const cookie = await cookieOf(ctx, account);
    if (cookie === undefined) {
        fail("unreachable", `${account.name} logged in but no session cookie was stored`, { account: account.name });
    }
}

/**
 * Makes sure the account's profile holds a session, logging in when it does not.
 *
 * Called before any lane opens, and never from inside one: one profile
 * directory holds one Chromium, so a lane that tried to log in would fight the
 * browser its own pool had already started.
 *
 * This exists because the failure it prevents is unreadable. Without a session
 * the workspace URL redirects to the login page, the page loads, nothing
 * errors, and the lane waits ninety seconds before reporting that the plugin
 * never dialled -- which points at the plugin, the port and the injection
 * before it points at the session. Measured here on the first live run.
 */
export async function ensureSession(account: Account, store: SessionStore, signal: AbortSignal): Promise<void> {
    if (await store.has(account)) return;

    if (account.email === undefined || account.password === undefined) {
        fail(
            "not-configured",
            `${account.name} has no session and no password to make one; ` +
                `put its credentials in the account file, or provision the account again`,
            { account: account.name }
        );
    }

    await store.loginWithPassword(account, signal);
}
