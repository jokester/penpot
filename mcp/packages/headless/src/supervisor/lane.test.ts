import test from "node:test";
import assert from "node:assert/strict";

import type { NotReady } from "../browser/page.ts";
import type { BrowserKey, BrowserPool, Lease, LeaseInit } from "../browser/pool.ts";
import type { PortPair } from "../core/ports.ts";
import type { AccountRef, DocumentRef } from "../core/target.ts";
import type { ExecBackend, ExecResult, Exposure, RemoteProcess } from "../exec/backend.ts";
import { FakeExecBackend, type FakeOptions } from "../exec/fake.ts";
import { runLane, type LaneDeps, type LaneEvent, type LaneSpec } from "./lane.ts";

const ACCOUNT: AccountRef = { name: "mcp-worker", origin: "http://localhost:9001", profileDir: "/tmp/p" };
const DOCUMENT: DocumentRef = {
    teamId: "fdbdf01d-1111-4222-8333-444455556666",
    fileId: "0a1b2c3d-4444-4555-8666-777788889999",
};
const RANGE = { lo: 4601, hi: 4608 };

/** Records what happened and in what order, which is the thing under test. */
class Trace {
    readonly steps: string[] = [];
    note(step: string): void {
        this.steps.push(step);
    }
}

/** A backend that writes down what it was asked to do. */
class TracingBackend implements ExecBackend {
    readonly kind = "compose" as const;
    readonly inner: FakeExecBackend;

    readonly #trace: Trace;

    constructor(trace: Trace, options: FakeOptions = {}) {
        this.#trace = trace;
        this.inner = new FakeExecBackend(options);
    }

    run(argv: readonly string[], signal: AbortSignal): Promise<ExecResult> {
        return this.inner.run(argv, signal);
    }
    async start(
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        signal: AbortSignal
    ): Promise<RemoteProcess> {
        const proc = await this.inner.start(argv, env, signal);
        this.#trace.note(`start:${env.PENPOT_MCP_SERVER_PORT}`);
        return proc;
    }
    async kill(pid: number): Promise<void> {
        this.#trace.note("kill");
        await this.inner.kill(pid);
    }
    log(pid: number): readonly string[] {
        return this.inner.log(pid);
    }
    listening(): Promise<number[]> {
        return this.inner.listening();
    }
    async expose(ports: PortPair, signal: AbortSignal): Promise<Exposure> {
        const exposure = await this.inner.expose(ports, signal);
        this.#trace.note(`expose:${ports.http}`);
        return {
            url: exposure.url,
            close: async () => {
                this.#trace.note("unexpose");
                await exposure.close();
            },
        };
    }
}

/** Knobs for the tab a lane gets. */
interface PoolOptions {
    /** Why the plugin is not ready, when a test wants it not to be. */
    readonly notReady?: NotReady;
    /** Makes leasing throw, as a browser that will not start would. */
    readonly failLease?: string;
}

class FakePool implements BrowserPool {
    leases = 0;
    lastInit: LeaseInit | null = null;
    lastKey: BrowserKey | null = null;

    readonly #trace: Trace;
    readonly #options: PoolOptions;

    constructor(trace: Trace, options: PoolOptions = {}) {
        this.#trace = trace;
        this.#options = options;
    }

    async lease(key: BrowserKey, init: LeaseInit, _signal: AbortSignal): Promise<Lease> {
        if (this.#options.failLease !== undefined) throw new Error(this.#options.failLease);

        this.leases += 1;
        this.lastKey = key;
        this.lastInit = init;
        this.#trace.note("lease");

        return {
            waitForPlugin: async () =>
                this.#options.notReady === undefined
                    ? { connected: true as const, url: "ws://localhost:4602/" }
                    : { connected: false as const, reason: this.#options.notReady },
            close: async () => {
                this.leases -= 1;
                this.#trace.note("unlease");
            },
        };
    }

    async closeAll(): Promise<void> {
        this.#trace.note("closeAll");
    }
}

/** Builds a lane and the fakes behind it, ready to run. */
function harness(spec: Partial<LaneSpec> = {}, pool: PoolOptions = {}, backend: FakeOptions = {}) {
    const trace = new Trace();
    const events: LaneEvent[] = [];
    const tracing = new TracingBackend(trace, backend);
    const fakePool = new FakePool(trace, pool);
    const control = new AbortController();

    const full: LaneSpec = {
        id: "lane-1",
        account: ACCOUNT,
        document: DOCUMENT,
        mode: "exec",
        headed: false,
        ...spec,
    };
    const deps: LaneDeps = { backend: tracing, pool: fakePool, portRange: RANGE, connectTimeoutMs: 50 };

    return {
        trace,
        events,
        pool: fakePool,
        backend: tracing,
        control,
        run: () => runLane(full, deps, (e) => events.push(e), control.signal),
        states: () => events.map((e) => e.state),
    };
}

test("a lane reaches connected and reports the URL an agent uses", async () => {
    const h = harness();
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    const connected = h.events.find((e) => e.state === "connected");

    assert.equal(connected?.clientUrl, "http://127.0.0.1:4601/mcp");
    assert.deepEqual(connected?.document, DOCUMENT);
    assert.deepEqual(h.states().at(-1), "connected");

    h.control.abort();
    await running;
});

test("a connected lane parks until it is cancelled", async () => {
    const h = harness();
    let settled = false;
    const running = h.run().then(() => (settled = true));

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    await tick();
    assert.equal(settled, false, "the lane resolved while it should have been parked");

    h.control.abort();
    await running;
    assert.equal(settled, true);
});

test("cancellation unwinds every acquisition in reverse", async () => {
    // The whole reason this is a function with nested finally rather than a
    // generator: one cleanup path, and it runs backwards.
    const h = harness();
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    h.control.abort();
    await running;

    assert.deepEqual(h.trace.steps, ["start:4601", "expose:4601", "lease", "unlease", "unexpose", "kill"]);
    assert.equal(h.pool.leases, 0);
    assert.deepEqual(h.backend.inner.running, []);
});

test("a cancelled lane is not a failed one", async () => {
    const h = harness();
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    h.control.abort();
    await running;

    assert.ok(!h.states().includes("failed"), `unexpected failure in ${h.states().join(" ")}`);
});

test("a plugin that never dials fails the lane and still cleans up", async () => {
    const h = harness({}, { notReady: "timeout" });
    await h.run();

    const failed = h.events.find((e) => e.state === "failed");
    assert.ok(failed?.reason.includes("did not dial"), failed?.reason ?? "no failure was reported");
    assert.deepEqual(h.trace.steps, ["start:4601", "expose:4601", "lease", "unlease", "unexpose", "kill"]);
    assert.deepEqual(h.backend.inner.running, []);
});

test("a dropped socket is reported as a drop, not as silence", async () => {
    // The two want different next steps, which is why the watch tells them
    // apart: nothing dialled points at the session or the injected URI, while
    // a socket that closed points at the server on the other end of it.
    const h = harness({}, { notReady: "dropped" });
    await h.run();

    const failed = h.events.find((e) => e.state === "failed");
    assert.ok(failed?.reason.includes("closed again"), failed?.reason ?? "no failure was reported");
    assert.ok(failed?.reason.includes("ws://localhost:4602"), failed?.reason ?? "");
    assert.deepEqual(h.trace.steps, ["start:4601", "expose:4601", "lease", "unlease", "unexpose", "kill"]);
});

test("a browser that will not open still kills the server", async () => {
    const h = harness({}, { failLease: "chromium exited" });
    await h.run();

    assert.ok(h.events.find((e) => e.state === "failed")?.reason.includes("chromium exited"));
    assert.deepEqual(h.trace.steps, ["start:4601", "expose:4601", "unexpose", "kill"]);
    assert.deepEqual(h.backend.inner.running, []);
});

test("a port that never answers still kills the server", async () => {
    const h = harness({}, {}, { failExpose: true });
    await h.run();

    assert.ok(h.events.find((e) => e.state === "failed")?.reason.includes("nothing answers"));
    assert.deepEqual(h.trace.steps, ["start:4601", "kill"]);
    assert.deepEqual(h.backend.inner.running, []);
});

test("an unbuilt mode fails by name, and starts nothing", async () => {
    for (const mode of ["builtin", "local", "image"] as const) {
        const h = harness({ mode });
        await h.run();

        const failed = h.events.find((e) => e.state === "failed");
        assert.ok(failed?.reason.includes("SPEC section 3b"), failed?.reason ?? "no failure was reported");
        assert.ok(failed?.reason.includes(mode));
        assert.deepEqual(h.trace.steps, []);
    }
});

test("a lane with no deployment says so rather than crashing", async () => {
    const events: LaneEvent[] = [];
    const trace = new Trace();
    const spec: LaneSpec = { id: "l", account: ACCOUNT, document: DOCUMENT, mode: "exec", headed: false };

    await runLane(
        spec,
        { pool: new FakePool(trace), portRange: RANGE },
        (e) => events.push(e),
        new AbortController().signal
    );

    assert.ok(events.find((e) => e.state === "failed")?.reason.includes("needs a deployment"));
});

test("a lane skips the ports a previous run left listening", async () => {
    const h = harness({}, {}, { listening: [4601, 4602, 4603] });
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    assert.equal(h.events.find((e) => e.state === "connected")?.clientUrl, "http://127.0.0.1:4605/mcp");

    h.control.abort();
    await running;
});

test("an operator's port is checked as hard as a chosen one", async () => {
    const outside = harness({ port: { http: 4701, ws: 4702 } });
    await outside.run();

    assert.ok(outside.events.find((e) => e.state === "failed")?.reason.includes("outside the published range"));
    assert.deepEqual(outside.trace.steps, [], "nothing should start when the port is unusable");

    const busy = harness({ port: { http: 4601, ws: 4602 } }, {}, { listening: [4602] });
    await busy.run();

    assert.ok(busy.events.find((e) => e.state === "failed")?.reason.includes("already serving"));
});

test("an operator's usable port is honoured", async () => {
    const h = harness({ port: { http: 4607, ws: 4608 } });
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    assert.equal(h.events.find((e) => e.state === "connected")?.clientUrl, "http://127.0.0.1:4607/mcp");

    h.control.abort();
    await running;
});

test("a headless lane carries no display, whatever the spec says", async () => {
    const h = harness({ headed: false, display: ":3" });
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    assert.equal(h.pool.lastKey?.display, undefined, "a headless browser has no screen to be on");

    h.control.abort();
    await running;
});

test("a headed lane leases a browser on its own display", async () => {
    const h = harness({ headed: true, display: ":3" });
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    assert.equal(h.pool.lastKey?.display, ":3");

    h.control.abort();
    await running;
});

test("the tab is leased with the wiring and URL the lane decided", async () => {
    const h = harness({ headed: true, flavour: "chrome" });
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));

    assert.deepEqual(h.pool.lastKey, { account: "mcp-worker", headed: true, flavour: "chrome" });
    assert.equal(h.pool.lastInit?.wiring.injectWsUri, "ws://localhost:4602");
    assert.equal(
        h.pool.lastInit?.url,
        `http://localhost:9001/#/workspace?team-id=${DOCUMENT.teamId}&file-id=${DOCUMENT.fileId}`
    );

    h.control.abort();
    await running;
});

test("opening reports progress, so a slow lane is not a blank row", async () => {
    const h = harness();
    const running = h.run();

    await waitFor(() => h.events.some((e) => e.state === "connected"));
    const details = h.events.filter((e) => e.state === "opening").map((e) => e.detail);

    assert.ok(details.length >= 4, `expected several opening steps, got ${details.join(" | ")}`);
    assert.ok(details.some((d) => d.includes("MCP server")));
    assert.ok(details.some((d) => d.includes("plugin")));

    h.control.abort();
    await running;
});

/** Waits for a condition, failing the test rather than hanging forever. */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) assert.fail("condition never held");
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** Lets pending microtasks and one timer turn. */
function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 20));
}
