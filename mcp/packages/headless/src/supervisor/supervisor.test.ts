import test from "node:test";
import assert from "node:assert/strict";

import type { BrowserKey, BrowserPool, Lease, LeaseInit } from "../browser/pool.ts";
import { isLauncherError } from "../core/errors.ts";
import { portMap } from "../core/ports.ts";
import type { AccountRef, DocumentRef } from "../core/target.ts";
import { FakeExecBackend } from "../exec/fake.ts";
import type { LaneDeps, LaneEvent, LaneSpec } from "./lane.ts";
import { LaneSupervisor, type LaneRecord } from "./supervisor.ts";

const ACCOUNT: AccountRef = { name: "mcp-worker", origin: "http://localhost:9001", profileDir: "/tmp/p" };
const OTHER: AccountRef = { ...ACCOUNT, name: "second" };

const doc = (n: number): DocumentRef => ({
    teamId: "fdbdf01d-1111-4222-8333-444455556666",
    fileId: `0000000${n}-4444-4555-8666-777788889999`,
});

/** A pool that records only whether it was closed, which is all this suite needs. */
class CountingPool implements BrowserPool {
    closed = 0;
    async lease(_key: BrowserKey, _init: LeaseInit, _signal: AbortSignal): Promise<Lease> {
        return {
            waitForPlugin: async () => ({ connected: true as const, url: "ws://localhost:4602/" }),
            close: async () => undefined,
        };
    }
    async closeAll(): Promise<void> {
        this.closed += 1;
    }
}

/** A stand-in for runLane whose transitions the test drives by hand. */
class ScriptedLanes {
    readonly started: LaneSpec[] = [];
    readonly emitters = new Map<string, (event: LaneEvent) => void>();
    readonly #resolvers = new Map<string, () => void>();
    /** Lane ids whose task refuses to finish, modelling a wedged browser. */
    readonly wedged = new Set<string>();

    readonly run = async (
        spec: LaneSpec,
        _deps: LaneDeps,
        onEvent: (event: LaneEvent) => void,
        signal: AbortSignal
    ): Promise<void> => {
        this.started.push(spec);
        this.emitters.set(spec.id, onEvent);
        onEvent({ state: "opening", detail: "starting" });

        await new Promise<void>((resolve) => {
            this.#resolvers.set(spec.id, resolve);
            signal.addEventListener(
                "abort",
                () => {
                    if (!this.wedged.has(spec.id)) resolve();
                },
                { once: true }
            );
        });
    };

    connect(id: string, port = 4601): void {
        this.emitters.get(id)?.({
            state: "connected",
            clientUrl: `http://127.0.0.1:${port}/mcp`,
            document: doc(1),
            port: { http: port, ws: port + 1 },
        });
    }

    failLane(id: string, reason = "the plugin did not dial"): void {
        this.emitters.get(id)?.({ state: "failed", reason, log: ["line one"] });
        this.#resolvers.get(id)?.();
    }
}

function build(backend?: FakeExecBackend, over: Partial<LaneDeps> = {}) {
    const pool = new CountingPool();
    const lanes = new ScriptedLanes();
    const deps: LaneDeps = {
        pool,
        portRange: { lo: 4601, hi: 4608 },
        ...(backend === undefined ? {} : { backend }),
        ...over,
    };
    const sup = new LaneSupervisor(deps, { run: lanes.run });
    return { pool, lanes, sup };
}

const spec = (n: number, over: Partial<LaneSpec> = {}): Omit<LaneSpec, "id"> => ({
    account: ACCOUNT,
    document: doc(n),
    mode: "exec",
    headed: false,
    ...over,
});

function refuses(fn: () => Promise<unknown>, contains: string): Promise<void> {
    return assert.rejects(fn, (err: unknown) => {
        assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
        assert.equal(err.code, "lane-refused");
        assert.ok(err.message.includes(contains), err.message);
        return true;
    });
}

test("opening a lane lists it as opening", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));

    assert.equal(lanes.started.length, 1);
    assert.equal(sup.list().length, 1);
    assert.equal(sup.list()[0]?.state, "opening");
    assert.equal(sup.list()[0]?.spec.id, id);
});

test("a lane's transitions reach the record the TUI renders", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));

    lanes.connect(id, 4603);
    const record = sup.list()[0];

    assert.equal(record?.state, "connected");
    assert.equal(record?.clientUrl, "http://127.0.0.1:4603/mcp");
    assert.deepEqual(record?.port, { http: 4603, ws: 4604 });
    assert.equal(record?.detail, undefined);
});

test("subscribers see the list on every change, and the current one on joining", async () => {
    const { sup, lanes } = build();
    const seen: number[] = [];
    const unsubscribe = sup.subscribe((records: readonly LaneRecord[]) => seen.push(records.length));

    assert.deepEqual(seen, [0], "a new subscriber should be given the current list");

    const id = await sup.open(spec(1));
    lanes.connect(id);
    assert.ok(seen.length >= 3, `expected several publications, saw ${seen.join(",")}`);

    unsubscribe();
    const before = seen.length;
    await sup.open(spec(2));
    assert.equal(seen.length, before, "an unsubscribed listener should hear nothing");
});

test("two lanes on one document are refused, naming the lane that has it", async () => {
    const { sup } = build();
    const first = await sup.open(spec(1));

    await refuses(() => sup.open(spec(1)), `lane ${first} already drives that document`);
    assert.equal(sup.list().length, 1, "a refusal must not leave a half-open lane");
});

test("a second builtin lane on one account is refused, because a token is one slot", async () => {
    const { sup } = build();
    await sup.open(spec(1, { mode: "builtin" }));

    await refuses(() => sup.open(spec(2, { mode: "builtin" })), "one MCP token is one plugin slot");
});

test("a builtin lane on a different account is allowed", async () => {
    const { sup } = build();
    await sup.open(spec(1, { mode: "builtin" }));
    await sup.open(spec(2, { mode: "builtin", account: OTHER }));

    assert.equal(sup.list().length, 2);
});

test("exec lanes on one account are the normal case, not a clash", async () => {
    const { sup } = build();
    await sup.open(spec(1));
    await sup.open(spec(2));
    await sup.open(spec(3));

    assert.equal(sup.list().length, 3);
});

test("a port a live lane already holds is refused", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.connect(id, 4605);

    await refuses(() => sup.open(spec(2, { port: { http: 4605, ws: 4606 } })), "already on port 4605");
});

test("a failed lane releases its document", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.failLane(id);

    assert.equal(sup.list()[0]?.state, "failed");
    await sup.open(spec(1)); // the same document, now free
    assert.equal(sup.list().length, 2);
});

test("a failed lane keeps its reason and its log", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.failLane(id, "chromium exited");

    assert.equal(sup.list()[0]?.error, "chromium exited");
    assert.deepEqual(sup.list()[0]?.log, ["line one"]);
});

test("retry re-runs a failed lane under its own id", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.failLane(id);

    await sup.retry(id);

    assert.equal(sup.list().length, 1);
    assert.equal(sup.list()[0]?.spec.id, id, "the row must not jump");
    assert.equal(sup.list()[0]?.state, "opening");
    assert.equal(lanes.started.length, 2);
});

test("retrying a lane that has not failed is refused", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.connect(id);

    await refuses(() => sup.retry(id), "only a failed lane can be retried");
    await refuses(() => sup.retry("no-such-lane"), "there is no lane");
});

test("closing a lane cancels it and drops it from the list", async () => {
    const { sup, lanes } = build();
    const id = await sup.open(spec(1));
    lanes.connect(id);

    const states: string[] = [];
    sup.subscribe((records) => states.push(records[0]?.state ?? "empty"));

    await sup.close(id);

    assert.deepEqual(sup.list(), []);
    assert.ok(states.includes("empty"), `expected the list to empty, saw ${states.join(",")}`);
});

test("closing a lane that is already gone is not an error", async () => {
    const { sup } = build();
    await sup.close("nothing");
});

test("shutdown ends every lane and closes the browsers", async () => {
    const { sup, lanes, pool } = build();
    const a = await sup.open(spec(1));
    await sup.open(spec(2));
    lanes.connect(a);

    const { forced } = await sup.shutdown(1000);

    assert.equal(forced, 0);
    assert.deepEqual(sup.list(), []);
    assert.equal(pool.closed, 1);
});

test("a wedged lane is forced rather than allowed to hang the quit", async () => {
    const { sup, lanes, pool } = build();
    const stuck = await sup.open(spec(1));
    await sup.open(spec(2));
    lanes.wedged.add(stuck);

    const started = Date.now();
    const { forced } = await sup.shutdown(100);

    assert.equal(forced, 1);
    assert.ok(Date.now() - started < 2000, "shutdown waited past its deadline");
    assert.deepEqual(sup.list(), []);
    assert.equal(pool.closed, 1);
});

test("shutdown with nothing running is immediate and honest", async () => {
    const { sup, pool } = build();

    assert.deepEqual(await sup.shutdown(1000), { forced: 0 });
    assert.equal(pool.closed, 1);
});

test("concurrent opens never hand out the same port", async () => {
    // The bug this replaces, measured on the first two-lane run: each open
    // probed the container before the other had started its server, and both
    // lanes took 4601. A lane cannot see its siblings; the supervisor can.
    const { sup, lanes } = build(new FakeExecBackend());

    await Promise.all([sup.open(spec(1)), sup.open(spec(2)), sup.open(spec(3))]);

    const ports = lanes.started.map((s) => s.port?.http);
    assert.deepEqual(ports, [4601, 4603, 4605], `got ${ports.join(",")}`);
    assert.equal(new Set(ports).size, 3);
});

test("a port a previous run left listening is skipped", async () => {
    const { sup, lanes } = build(new FakeExecBackend({ listening: [4601, 4602] }));
    await sup.open(spec(1));

    assert.deepEqual(lanes.started[0]?.port, { http: 4603, ws: 4604 });
});

test("an operator's port is checked against siblings, not just the container", async () => {
    const { sup } = build(new FakeExecBackend());
    await sup.open(spec(1, { port: { http: 4603, ws: 4604 } }));

    // Nothing is listening on 4603 yet -- the lane has not started -- so only
    // the reservation can refuse this.
    await assert.rejects(
        () => sup.open(spec(2, { port: { http: 4603, ws: 4604 } })),
        (err: unknown) => isLauncherError(err) && err.code === "port-busy"
    );
});

test("closing a lane gives its port back", async () => {
    const { sup, lanes } = build(new FakeExecBackend());
    const first = await sup.open(spec(1));
    await sup.close(first);
    await sup.open(spec(2));

    assert.deepEqual(lanes.started[1]?.port, { http: 4601, ws: 4602 });
});

test("retrying a failed lane chooses a port again", async () => {
    // The range has moved on since it failed, and its old pair may be
    // someone else's now.
    const backend = new FakeExecBackend();
    const { sup, lanes } = build(backend);
    const id = await sup.open(spec(1));
    lanes.failLane(id);

    backend.set({ listening: [4601, 4602] });
    await sup.retry(id);

    assert.deepEqual(lanes.started[1]?.port, { http: 4603, ws: 4604 });
});

test("a builtin lane needs no port at all", async () => {
    const { sup, lanes } = build(new FakeExecBackend());
    await sup.open(spec(1, { mode: "builtin" }));

    assert.equal(lanes.started[0]?.port, undefined);
});

test("a port busy in the container is avoided even when the ranges differ", async () => {
    // The bug this covers: `listening` answers in the container's port space
    // and allocation happens in the host's, so under a mapping the two never
    // intersect and the supervisor allocates as though the container were
    // empty. It only showed up with a second launcher against one pod --
    // reservations hide it from a supervisor racing only itself.
    const backend = new FakeExecBackend({ listening: [4601, 4602] });
    const h = build(backend, {
        portRange: { lo: 30601, hi: 30608 },
        portMap: portMap({ lo: 30601, hi: 30608 }, { lo: 4601, hi: 4608 }),
    });

    await h.sup.open(spec(1));

    const [record] = h.sup.list();
    assert.deepEqual(record?.spec.port, { http: 30603, ws: 30604 }, "should skip the pair mapping onto 4601/4602");
});

test("with no mapping the two spaces are the same, as they always were", async () => {
    const backend = new FakeExecBackend({ listening: [4601, 4602] });
    const h = build(backend);

    await h.sup.open(spec(1));

    assert.deepEqual(h.sup.list()[0]?.spec.port, { http: 4603, ws: 4604 });
});
