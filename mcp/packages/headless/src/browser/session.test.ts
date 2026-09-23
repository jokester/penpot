import test from "node:test";
import assert from "node:assert/strict";

import type { Account } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import {
    ensureSession,
    sessionStore,
    type OpenSessionContext,
    type PostResult,
    type SessionContext,
    type StoredCookie,
} from "./session.ts";

const ACCOUNT: Account = {
    name: "mcp-worker",
    origin: "http://localhost:9001/",
    profileDir: "/tmp/profile-mcp-worker",
    email: "mcp-worker@example.test",
    password: "hunter2",
};

const COOKIE: StoredCookie = { name: "auth-token", value: "abc", expires: 1_800_000_000 };

/** What a test wants the browser to do. */
interface FakeOptions {
    /** Cookies present before anything happens. */
    readonly cookies?: readonly StoredCookie[];
    /** Cookies that appear only after the login has been posted. */
    readonly appearsAfter?: number;
    readonly post?: PostResult;
}

function fakeContexts(options: FakeOptions = {}) {
    const state = {
        opened: 0,
        closed: 0,
        posts: [] as { url: string; body: unknown }[],
        polls: 0,
    };

    const open: OpenSessionContext = async () => {
        state.opened += 1;

        const ctx: SessionContext = {
            async cookies() {
                state.polls += 1;
                if (options.appearsAfter !== undefined) {
                    return state.polls > options.appearsAfter ? [COOKIE] : [];
                }
                return options.cookies ?? [];
            },
            async post(url, body) {
                state.posts.push({ url, body });
                return options.post ?? { ok: true, status: 200, text: async () => "" };
            },
            async close() {
                state.closed += 1;
            },
        };
        return ctx;
    };

    return { open, state, store: sessionStore(open) };
}

test("a profile with the session cookie has a session", async () => {
    const f = fakeContexts({ cookies: [COOKIE] });

    assert.equal(await f.store.has(ACCOUNT), true);
    assert.equal(f.state.opened, 1, "checking should open one context and close it");
    assert.equal(f.state.closed, 1, "the context must be closed so the jar is flushed");
});

test("a profile with other cookies does not have a session", async () => {
    const f = fakeContexts({ cookies: [{ name: "consent", value: "1", expires: -1 }] });

    assert.equal(await f.store.has(ACCOUNT), false);
});

test("a password login posts through the browser, not through Node", async () => {
    // Through the browser so the Set-Cookie lands in the profile's jar exactly
    // as a real login would leave it. Node's own fetch would drop it.
    const f = fakeContexts({ cookies: [COOKIE] });
    await f.store.loginWithPassword(ACCOUNT, AbortSignal.timeout(5000));

    assert.deepEqual(f.state.posts, [
        {
            url: "http://localhost:9001/api/rpc/command/login-with-password",
            body: { email: ACCOUNT.email, password: "hunter2" },
        },
    ]);
    assert.equal(f.state.opened, 1);
    assert.equal(f.state.closed, 1);
});

test("a rejected password says what the server said", async () => {
    const f = fakeContexts({
        cookies: [],
        post: { ok: false, status: 400, text: async () => '{"type":"validation","code":"wrong-credentials"}' },
    });

    await assert.rejects(
        () => f.store.loginWithPassword({ ...ACCOUNT, password: "wrong" }, AbortSignal.timeout(5000)),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.ok(err.message.includes("HTTP 400"), err.message);
            assert.ok(err.message.includes("wrong-credentials"), err.message);
            return true;
        }
    );
    assert.equal(f.state.closed, 1, "a failed login must still close its context");
});

test("a 200 that stores no cookie is still a failure", async () => {
    // It has happened: the call succeeds and the jar stays empty, and the
    // symptom then looks like an auth bug three steps later.
    const f = fakeContexts({ cookies: [] });

    await assert.rejects(
        () => f.store.loginWithPassword(ACCOUNT, AbortSignal.timeout(5000)),
        (err: unknown) => isLauncherError(err) && err.message.includes("no session cookie was stored")
    );
});

test("a trailing slash on the origin does not double up", async () => {
    const f = fakeContexts({ cookies: [COOKIE] });
    await f.store.loginWithPassword(ACCOUNT, AbortSignal.timeout(5000));

    assert.ok(!f.state.posts[0]?.url.includes("//api"), f.state.posts[0]?.url ?? "no post was made");
});

test("a profile that already has a session is left alone", async () => {
    const f = fakeContexts({ cookies: [COOKIE] });
    await ensureSession(ACCOUNT, f.store, AbortSignal.timeout(5000));

    assert.deepEqual(f.state.posts, [], "it should not have logged in again");
});

test("a profile with no session is logged in before any lane opens", async () => {
    // Without this the workspace URL redirects to the login page, the page
    // loads, nothing errors, and the lane waits ninety seconds before blaming
    // the plugin. Measured on the first live run.
    // The first look finds nothing; the one after the login finds the cookie.
    const f = fakeContexts({ appearsAfter: 1 });
    await ensureSession(ACCOUNT, f.store, AbortSignal.timeout(5000));

    assert.equal(f.state.posts.length, 1);
    // One context to look, one to log in.
    assert.equal(f.state.opened, 2);
    assert.equal(f.state.closed, 2, "both contexts must close so the jar is flushed");
});

test("no session and no password says what to do about it", async () => {
    const f = fakeContexts({ cookies: [] });
    const { password: _password, ...noPassword } = ACCOUNT;

    await assert.rejects(
        () => ensureSession(noPassword, f.store, AbortSignal.timeout(5000)),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.ok(err.message.includes("provision the account again"), err.message);
            return true;
        }
    );
});
