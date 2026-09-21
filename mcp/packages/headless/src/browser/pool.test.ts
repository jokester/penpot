import test from "node:test";
import assert from "node:assert/strict";

import type { AccountRef } from "../core/target.ts";
import { wire } from "../core/topology.ts";
import { flavourOf } from "./launch.ts";
import { LeasingPool, type BrowserKey, type BrowserSession, type Launch, type Lease, type LeaseInit } from "./pool.ts";

const ACCOUNT: AccountRef = { name: "mcp-worker", origin: "http://localhost:9001", profileDir: "/tmp/profile" };
const OTHER: AccountRef = { ...ACCOUNT, name: "second", profileDir: "/tmp/profile-2" };

const init = (account: AccountRef = ACCOUNT, port = 4601): LeaseInit => ({
    account,
    wiring: wire("exec", account, { http: port, ws: port + 1 }),
    url: "http://localhost:9001/#/workspace?team-id=t&file-id=f",
});

const key = (over: Partial<BrowserKey> = {}): BrowserKey => ({
    account: ACCOUNT.name,
    headed: false,
    flavour: "default",
    ...over,
});

/** A browser that opens tabs and counts them, with no Playwright anywhere. */
class FakeSession implements BrowserSession {
    tabs = 0;
    closed = 0;
    readonly injected: (string | null)[] = [];
    /** Set to make the next openTab throw, as a browser out of memory would. */
    failTab: string | undefined;

    constructor(failTab?: string) {
        this.failTab = failTab;
    }

    async openTab(leaseInit: LeaseInit, _signal: AbortSignal): Promise<Lease> {
        if (this.failTab !== undefined) throw new Error(this.failTab);

        this.tabs += 1;
        this.injected.push(leaseInit.wiring.injectWsUri);
        return {
            waitForPlugin: async () => ({ connected: true as const, url: "ws://localhost:4602/" }),
            close: async () => {
                this.tabs -= 1;
            },
        };
    }

    async close(): Promise<void> {
        this.closed += 1;
    }
}

/** Records every browser the pool asked for. */
function launcher(make: () => FakeSession = () => new FakeSession()) {
    const sessions: FakeSession[] = [];
    const keys: BrowserKey[] = [];

    const launch: Launch = async (k) => {
        keys.push(k);
        const session = make();
        sessions.push(session);
        return session;
    };
    return { launch, sessions, keys };
}

const SIGNAL = new AbortController().signal;

test("lanes on one key share a browser and get a tab each", async () => {
    // The measured reason: a browser and its first tab cost 527 MB, each
    // further tab 94 MB.
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    const a = await pool.lease(key(), init(ACCOUNT, 4601), SIGNAL);
    const b = await pool.lease(key(), init(ACCOUNT, 4603), SIGNAL);
    const c = await pool.lease(key(), init(ACCOUNT, 4605), SIGNAL);

    assert.equal(l.sessions.length, 1, "three lanes should share one browser");
    assert.equal(l.sessions[0]?.tabs, 3);
    assert.equal(pool.open, 1);

    await Promise.all([a.close(), b.close(), c.close()]);
    assert.equal(pool.open, 0);
});

test("each tab is injected with its own socket", async () => {
    // This is what makes sharing possible at all, and it was measured before
    // it was designed around.
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    await pool.lease(key(), init(ACCOUNT, 4601), SIGNAL);
    await pool.lease(key(), init(ACCOUNT, 4603), SIGNAL);

    assert.deepEqual(l.sessions[0]?.injected, ["ws://localhost:4602", "ws://localhost:4604"]);
});

test("the browser closes with its last lease, not its first", async () => {
    const l = launcher();
    const pool = new LeasingPool(l.launch);
    const a = await pool.lease(key(), init(), SIGNAL);
    const b = await pool.lease(key(), init(), SIGNAL);

    await a.close();
    assert.equal(l.sessions[0]?.closed, 0, "one lane leaving must not take the browser");

    await b.close();
    assert.equal(l.sessions[0]?.closed, 1);
});

test("closing a lease twice is not a double release", async () => {
    const l = launcher();
    const pool = new LeasingPool(l.launch);
    const a = await pool.lease(key(), init(), SIGNAL);
    const b = await pool.lease(key(), init(), SIGNAL);

    await a.close();
    await a.close();

    assert.equal(l.sessions[0]?.closed, 0, "the second close should have done nothing");
    await b.close();
    assert.equal(l.sessions[0]?.closed, 1);
});

test("the axes of the key each force a second browser", async () => {
    for (const other of [
        key({ account: OTHER.name }),
        key({ headed: true }),
        key({ flavour: "chrome" }),
        key({ headed: true, display: ":3" }),
    ]) {
        const l = launcher();
        const pool = new LeasingPool(l.launch);

        await pool.lease(key(), init(), SIGNAL);
        await pool.lease(other, init(OTHER), SIGNAL);

        assert.equal(l.sessions.length, 2, `${JSON.stringify(other)} should not share`);
    }
});

test("a browser started for a tab that never opens is not left behind", async () => {
    const l = launcher(() => new FakeSession("chromium exited"));
    const pool = new LeasingPool(l.launch);

    await assert.rejects(() => pool.lease(key(), init(), SIGNAL), /chromium exited/);

    assert.equal(l.sessions[0]?.closed, 1, "the browser should have been closed again");
    assert.equal(pool.open, 0);
});

test("a failed tab does not take down a browser other lanes are using", async () => {
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    const held = await pool.lease(key(), init(), SIGNAL);
    const session = l.sessions[0];
    assert.ok(session !== undefined);

    // The same key, so the same browser -- and it already has a live lease.
    session.failTab = "out of memory";
    await assert.rejects(() => pool.lease(key(), init(), SIGNAL), /out of memory/);

    assert.equal(session.closed, 0, "a failed tab must not close a browser someone is using");
    assert.equal(pool.open, 1);

    await held.close();
    assert.equal(session.closed, 1);
    assert.equal(pool.open, 0);
});

test("closeAll ends every browser, whatever is still leased", async () => {
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    await pool.lease(key(), init(), SIGNAL);
    await pool.lease(key({ headed: true }), init(), SIGNAL);
    assert.equal(pool.open, 2);

    await pool.closeAll();

    assert.equal(pool.open, 0);
    assert.deepEqual(
        l.sessions.map((s) => s.closed),
        [1, 1]
    );
});

test("a browser that refuses to close does not stop the others", async () => {
    const l = launcher(() => {
        const session = new FakeSession();
        session.close = async () => {
            throw new Error("wedged");
        };
        return session;
    });
    const pool = new LeasingPool(l.launch);
    await pool.lease(key(), init(), SIGNAL);

    await pool.closeAll();
    assert.equal(pool.open, 0);
});

test("the flavour names what cannot be varied per tab", () => {
    assert.equal(flavourOf({}), "default");
    assert.equal(flavourOf({ channel: "chrome" }), "chrome");
    assert.equal(flavourOf({ args: ["--use-gl=angle", "--use-angle=gl-egl"] }), "--use-gl=angle --use-angle=gl-egl");
    assert.notEqual(flavourOf({ channel: "chrome" }), flavourOf({}));
});

test("two headed lanes on different screens are two browsers", async () => {
    // A browser is launched onto one display and cannot move, so the display
    // belongs in the key however much else the two lanes share.
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    await pool.lease(key({ headed: true, display: ":3" }), init(), SIGNAL);
    await pool.lease(key({ headed: true, display: ":4" }), init(), SIGNAL);

    assert.equal(l.sessions.length, 2);
});

test("two headed lanes on one screen share a browser", async () => {
    const l = launcher();
    const pool = new LeasingPool(l.launch);

    await pool.lease(key({ headed: true, display: ":3" }), init(), SIGNAL);
    await pool.lease(key({ headed: true, display: ":3" }), init(), SIGNAL);

    assert.equal(l.sessions.length, 1);
    assert.equal(l.keys[0]?.display, ":3");
});
