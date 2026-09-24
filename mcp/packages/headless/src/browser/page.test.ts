import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { Page } from "playwright";

import type { AccountRef } from "../core/target.ts";
import { samePorts, wire } from "../core/topology.ts";
import { watchPluginSocket, type PluginReadiness } from "./page.ts";

const ACCOUNT: AccountRef = { name: "mcp-worker", origin: "http://localhost:9001", profileDir: "/tmp/p" };

/** The lane's wiring: injected on 4602, so only that port is the plugin's. */
const WIRING = wire("exec", ACCOUNT, samePorts({ http: 4601, ws: 4602 }));

/** Settle short enough that the suite stays fast, long enough to be a window. */
const SETTLE = 30;

/** A socket, as Playwright reports one. */
class FakeSocket extends EventEmitter {
    readonly #value: string;

    constructor(value: string) {
        super();
        this.#value = value;
    }
    url(): string {
        return this.#value;
    }
    /** Models the far end hanging up. */
    drop(): void {
        this.emit("close");
    }
}

/** The part of a Page the watch uses, and nothing else. */
function fakePage() {
    const emitter = new EventEmitter();
    const page = { on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn) } as unknown as Page;

    return {
        page,
        /** Opens a socket the page can see, and hands it back to be dropped. */
        dial(url: string): FakeSocket {
            const socket = new FakeSocket(url);
            emitter.emit("websocket", socket);
            return socket;
        },
    };
}

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function watch(options: { settleMs?: number } = {}) {
    const f = fakePage();
    return { ...f, watch: watchPluginSocket(f.page, WIRING, { settleMs: SETTLE, ...options }) };
}

test("a socket that opens and stays is the readiness signal", async () => {
    const w = watch();
    const waiting = w.watch.wait(1000, AbortSignal.timeout(5000));

    w.dial("ws://localhost:4602/?userToken=abc");

    assert.deepEqual(await waiting, { connected: true, url: "ws://localhost:4602/?userToken=abc" });
});

test("a socket that opens and closes again is not connected", async () => {
    // The defect this replaces. A lane reported itself connected on a socket
    // the server had already hung up on, and the failure surfaced much later
    // as a tool call against a server with no plugin attached.
    const w = watch();
    const waiting = w.watch.wait(200, AbortSignal.timeout(5000));

    const socket = w.dial("ws://localhost:4602/");
    await after(SETTLE / 3);
    socket.drop();

    assert.deepEqual(await waiting, { connected: false, reason: "dropped" });
});

test("a drop is distinguished from silence, because they mean different things", async () => {
    // Nothing dialled points at the session, the MCP setting or the injected
    // URI. A socket that closed points at the server on the other end.
    const silent = watch();
    assert.deepEqual(await silent.watch.wait(60, AbortSignal.timeout(5000)), {
        connected: false,
        reason: "timeout",
    });
});

test("a socket that closes after settling leaves the lane connected", async () => {
    // Past the settle the lane owns the socket's fate; this watch is done.
    const w = watch();
    const waiting = w.watch.wait(1000, AbortSignal.timeout(5000));
    const socket = w.dial("ws://localhost:4602/");

    const readiness = await waiting;
    socket.drop();

    assert.equal(readiness.connected, true);
    assert.deepEqual(await w.watch.wait(1000, AbortSignal.timeout(5000)), {
        connected: true,
        url: "ws://localhost:4602/",
    });
});

test("a plugin that dials again after dropping still counts", async () => {
    // Waiting costs nothing the caller's own timeout does not already bound,
    // and the plugin may well retry.
    const w = watch();
    const waiting = w.watch.wait(1000, AbortSignal.timeout(5000));

    w.dial("ws://localhost:4602/").drop();
    await after(SETTLE / 2);
    w.dial("ws://localhost:4602/?second");

    assert.deepEqual(await waiting, { connected: true, url: "ws://localhost:4602/?second" });
});

test("only the injected port counts as the plugin", async () => {
    // Invariant 11 from the other side: matching the default port while a
    // different one was injected reported a healthy lane as a timeout, and
    // would now report an unhealthy one as connected.
    const w = watch();
    const waiting = w.watch.wait(80, AbortSignal.timeout(5000));

    w.dial("ws://localhost:9001/ws/notifications?session-id=1");
    w.dial("ws://localhost:4402/");

    assert.deepEqual(await waiting, { connected: false, reason: "timeout" });
});

test("waiting after the socket has already settled answers at once", async () => {
    const w = watch();
    w.dial("ws://localhost:4602/");
    await after(SETTLE * 2);

    const started = Date.now();
    const readiness = await w.watch.wait(5000, AbortSignal.timeout(5000));

    assert.equal(readiness.connected, true);
    assert.ok(Date.now() - started < 50, "an answer already known should not be waited for");
});

test("an abort is answered promptly, and not at the deadline", async () => {
    const control = new AbortController();
    const w = watch();
    const waiting = w.watch.wait(10_000, control.signal);

    const started = Date.now();
    control.abort();
    const readiness = await waiting;

    assert.deepEqual(readiness, { connected: false, reason: "cancelled" });
    assert.ok(Date.now() - started < 500, "it waited for the deadline instead of the signal");
});

test("a signal already aborted is answered without waiting at all", async () => {
    const w = watch();

    assert.deepEqual(await w.watch.wait(10_000, AbortSignal.abort()), { connected: false, reason: "cancelled" });
});

test("two waiters on one watch both hear the answer", async () => {
    const w = watch();
    const both = Promise.all([
        w.watch.wait(1000, AbortSignal.timeout(5000)),
        w.watch.wait(1000, AbortSignal.timeout(5000)),
    ]);

    w.dial("ws://localhost:4602/");

    const [a, b]: PluginReadiness[] = await both;
    assert.deepEqual(a, b);
    assert.equal(a.connected, true);
});

test("the builtin wiring watches for the instance's own socket", async () => {
    const builtin = wire("builtin", ACCOUNT, null, "tok");
    const f = fakePage();
    const w = watchPluginSocket(f.page, builtin, { settleMs: SETTLE });
    const waiting = w.wait(1000, AbortSignal.timeout(5000));

    f.dial("ws://localhost:9001/ws/notifications");
    f.dial("ws://localhost:9001/mcp/ws?userToken=tok");

    assert.deepEqual(await waiting, { connected: true, url: "ws://localhost:9001/mcp/ws?userToken=tok" });
});
