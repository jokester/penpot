// Getting a session into a browser profile, once.
//
// Ported from mcp/packages/host/spikes/login.js. Two paths because they are
// genuinely different problems: a password can be posted, and an SSO or 2FA
// account cannot be scripted at all.
//
// Both paths must run while no lane is using the account, because one profile
// directory holds one Chromium and two would fight over its lock. In practice
// that means logging in before opening any lane, which is what the TUI does.

import type { Account } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { normalizeOrigin, type AccountRef } from "../core/target.ts";

/** How long an interactive login may take before the window is abandoned. */
const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000;

/** How often to look for the cookie an interactive login is waiting for. */
const POLL_MS = 2000;

/** Penpot's session cookie. Its presence is the only proof a login worked. */
const COOKIE = "auth-token";

/** A cookie as the session store needs to see it. */
export interface StoredCookie {
    readonly name: string;
    readonly value: string;
    /** Seconds since the epoch, or -1 for a session-only cookie. */
    readonly expires: number;
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
    cookies(origin: string): Promise<readonly StoredCookie[]>;
    /** Posts through the browser, so Set-Cookie lands in the profile's jar. */
    post(url: string, body: unknown): Promise<PostResult>;
    /** Opens a page for a person to log in on. */
    open(url: string): Promise<void>;
    /** Whether a window is still open, so a closed one is not waited on. */
    hasWindow(): boolean;
    close(): Promise<void>;
}

/** Opens a context on an account's profile. `playwrightSessions` provides one. */
export type OpenSessionContext = (account: AccountRef, headless: boolean) => Promise<SessionContext>;

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
    loginInteractive(account: AccountRef, signal: AbortSignal): Promise<void>;
}

/** Builds a session store over whatever opens contexts. */
export function sessionStore(open: OpenSessionContext, wait: (ms: number) => Promise<void> = sleep): SessionStore {
    /** Runs `body` against a context and always closes it, so the jar is flushed. */
    const withContext = async <T>(
        account: AccountRef,
        headless: boolean,
        body: (ctx: SessionContext) => Promise<T>
    ) => {
        const ctx = await open(account, headless);
        try {
            return await body(ctx);
        } finally {
            await ctx.close().catch(() => undefined);
        }
    };

    const cookieOf = async (ctx: SessionContext, account: AccountRef): Promise<StoredCookie | undefined> => {
        const origin = normalizeOrigin(account.origin);
        return (await ctx.cookies(origin)).find((cookie) => cookie.name === COOKIE);
    };

    return {
        async has(account) {
            return await withContext(account, true, async (ctx) => (await cookieOf(ctx, account)) !== undefined);
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

            await withContext(account, true, async (ctx) => {
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
                await requireCookie(ctx, account, cookieOf);
            });
        },

        /**
         * Opens a window and waits for the cookie, not for the window to close.
         *
         * A person closing the window proves nothing: they may have given up,
         * or the login may have failed. The cookie existing is the only proof.
         */
        async loginInteractive(account, signal) {
            await withContext(account, false, async (ctx) => {
                const origin = normalizeOrigin(account.origin);
                await ctx.open(`${origin}/#/auth/login`);

                const deadline = Date.now() + INTERACTIVE_TIMEOUT_MS;
                while ((await cookieOf(ctx, account)) === undefined) {
                    if (signal.aborted)
                        fail("unreachable", `login for ${account.name} was cancelled`, {
                            account: account.name,
                        });
                    if (!ctx.hasWindow()) {
                        fail("unreachable", `the window closed before ${account.name} was logged in`, {
                            account: account.name,
                        });
                    }
                    if (Date.now() > deadline) {
                        fail("unreachable", `gave up waiting for ${account.name} to log in`, { account: account.name });
                    }
                    await wait(POLL_MS);
                }
            });
        },
    };
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

/** True when the cookie will not survive a restart, which is worth saying out loud. */
export function isSessionOnly(cookie: StoredCookie): boolean {
    return cookie.expires === -1;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
