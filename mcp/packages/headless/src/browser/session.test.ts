import test from "node:test";
import assert from "node:assert/strict";

import type { Account } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import {
    isSessionOnly,
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
    /** Cookies that appear after this many polls, modelling a person logging in. */
    readonly appearsAfter?: number;
    readonly post?: PostResult;
    /** Models a person closing the window. */
    readonly closesAfter?: number;
}

function fakeContexts(options: FakeOptions = {}) {
    const state = {
        opened: [] as { headless: boolean }[],
        closed: 0,
        posts: [] as { url: string; body: unknown }[],
        visited: [] as string[],
        polls: 0,
    };

    const open: OpenSessionContext = async (_account, headless) => {
        state.opened.push({ headless });

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
            async open(url) {
                state.visited.push(url);
            },
            hasWindow() {
                return options.closesAfter === undefined || state.polls <= options.closesAfter;
            },
            async close() {
                state.closed += 1;
            },
        };
        return ctx;
    };

    // No real waiting: the poll loop is the thing under test, not the clock.
    return { open, state, store: sessionStore(open, async () => undefined) };
}

test("a profile with the session cookie has a session", async () => {
    const f = fakeContexts({ cookies: [COOKIE] });

    assert.equal(await f.store.has(ACCOUNT), true);
    assert.deepEqual(f.state.opened, [{ headless: true }], "checking should not open a window");
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
    assert.deepEqual(f.state.opened, [{ headless: true }]);
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

test("an interactive login opens a window and waits for the cookie", async () => {
    const f = fakeContexts({ appearsAfter: 3 });
    await f.store.loginInteractive(ACCOUNT, AbortSignal.timeout(5000));

    assert.deepEqual(f.state.opened, [{ headless: false }], "a person needs to see the window");
    assert.deepEqual(f.state.visited, ["http://localhost:9001/#/auth/login"]);
    assert.ok(f.state.polls > 3, "it should have polled until the cookie appeared");
    assert.equal(f.state.closed, 1);
});

test("a window closed before logging in is a failure, not a success", async () => {
    // Waiting for the window to close rather than for the cookie was the
    // original bug: giving up looked exactly like succeeding.
    const f = fakeContexts({ cookies: [], closesAfter: 2 });

    await assert.rejects(
        () => f.store.loginInteractive(ACCOUNT, AbortSignal.timeout(5000)),
        (err: unknown) => isLauncherError(err) && err.message.includes("window closed before")
    );
    assert.equal(f.state.closed, 1);
});

test("a cancelled interactive login stops waiting", async () => {
    const control = new AbortController();
    const f = fakeContexts({ cookies: [] });
    control.abort();

    await assert.rejects(
        () => f.store.loginInteractive(ACCOUNT, control.signal),
        (err: unknown) => isLauncherError(err) && err.message.includes("cancelled")
    );
});

test("a trailing slash on the origin does not double up", async () => {
    const f = fakeContexts({ cookies: [COOKIE] });
    await f.store.loginWithPassword(ACCOUNT, AbortSignal.timeout(5000));

    assert.ok(!f.state.posts[0]?.url.includes("//api"), f.state.posts[0]?.url ?? "no post was made");
});

test("a session-only cookie is recognisable, because it will not survive a restart", () => {
    assert.equal(isSessionOnly({ name: "auth-token", value: "a", expires: -1 }), true);
    assert.equal(isSessionOnly(COOKIE), false);
});
