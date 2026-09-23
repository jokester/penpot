import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError } from "../core/errors.ts";
import type { DocumentRef } from "../core/target.ts";
import { LeaseRegistry, type LaneHandle, type LaneSource } from "./leases.ts";

const TEAM = "fdbdf01d-1111-4222-8333-444455556666";

const doc = (name: string): DocumentRef => ({ teamId: TEAM, fileId: `file-${name}`, name });

const SIGNAL = new AbortController().signal;

/** A lane source that opens nothing and remembers everything. */
function fakeLanes(over: Partial<LaneSource> = {}) {
    const opened: string[] = [];
    const closed: string[] = [];
    const wiped: string[] = [];
    let next = 1;

    const lanes: LaneSource = {
        async open(document): Promise<LaneHandle> {
            const lane = { id: `lane-${next}`, clientUrl: `http://127.0.0.1:${4600 + next * 2}/mcp` };
            next += 1;
            opened.push(document.fileId);
            return lane;
        },
        async close(id) {
            closed.push(id);
        },
        async wipe(lane) {
            wiped.push(lane.id);
        },
        ...over,
    };
    return { lanes, opened, closed, wiped };
}

/** A clock a test can move. */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
}

function refuses(fn: () => Promise<unknown>, contains: string): Promise<void> {
    return assert.rejects(fn, (err: unknown) => {
        assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
        assert.ok(err.message.includes(contains), err.message);
        return true;
    });
}

// --- the lease: one lane per document ------------------------------------

test("a document gets a lane, and asking again gets the same one", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });

    const first = await registry.acquire("s1", doc("diagrams"), SIGNAL);
    const again = await registry.acquire("s1", doc("diagrams"), SIGNAL);

    assert.equal(first.lane.id, again.lane.id);
    assert.deepEqual(f.opened, ["file-diagrams"], "it should not open a second lane");
});

test("a second client is refused, and told the document is held", async () => {
    // The allocation policy: two agents on one document is hazardous in itself,
    // so the façade declines to create the collision it controls.
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    await registry.acquire("s1", doc("diagrams"), SIGNAL);

    await refuses(() => registry.acquire("s2", doc("diagrams"), SIGNAL), "already held by another client");
    assert.deepEqual(f.opened, ["file-diagrams"]);
});

test("the refusal names the document by name, not by uuid", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    await registry.acquire("s1", doc("LLM session viewer"), SIGNAL);

    await refuses(() => registry.acquire("s2", doc("LLM session viewer"), SIGNAL), '"LLM session viewer"');
});

test("a session holds one document at a time, so a second switches", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });

    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.acquire("s1", doc("b"), SIGNAL);

    assert.equal(registry.heldBy("s1")?.document.fileId, "file-b");
    // The first is warm, not gone: someone else may want it.
    assert.deepEqual(
        registry.list().map((l) => [l.document.fileId, l.holder]),
        [
            ["file-a", null],
            ["file-b", "s1"],
        ]
    );
});

test("switching away frees the document for someone else", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });

    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.acquire("s1", doc("b"), SIGNAL);
    const taken = await registry.acquire("s2", doc("a"), SIGNAL);

    assert.equal(taken.document.fileId, "file-a");
    assert.deepEqual(f.opened, ["file-a", "file-b"], "the warm lane is reused, not reopened");
});

// --- the scratchpad ------------------------------------------------------

test("releasing wipes the scratchpad before anyone else sees the lane", async () => {
    // storage is one object per tab and the agent is told to use it
    // extensively, so a lane handed on dirty is a cross-client channel.
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    await registry.release("s1");

    assert.deepEqual(f.wiped, [lease.lane.id]);
    assert.deepEqual(f.closed, [], "the lane stays warm for the next holder");
});

test("a lane that cannot be wiped is torn down rather than handed on", async () => {
    const f = fakeLanes({
        async wipe() {
            throw new Error("the tab is not answering");
        },
    });
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    await registry.release("s1");

    assert.deepEqual(f.closed, [lease.lane.id]);
    assert.deepEqual(registry.list(), [], "a dirty lane must not stay available");
});

test("a reused lane is not a cold start", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });

    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.release("s1");
    await registry.acquire("s2", doc("a"), SIGNAL);

    assert.deepEqual(f.opened, ["file-a"], "opened once, held twice");
});

// --- capacity ------------------------------------------------------------

test("a warm lane is evicted to make room, oldest first", async () => {
    const c = clock();
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 2, now: c.now });

    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.release("s1");
    c.advance(1000);
    await registry.acquire("s2", doc("b"), SIGNAL);
    await registry.release("s2");

    await registry.acquire("s3", doc("c"), SIGNAL);

    // "a" went warm first, so "a" goes.
    assert.deepEqual(f.closed, ["lane-1"]);
    assert.deepEqual(
        registry
            .list()
            .map((l) => l.document.fileId)
            .sort(),
        ["file-b", "file-c"]
    );
});

test("when every lane is held, a new document is refused", async () => {
    // Nothing is ever taken from a client: a held lane is not available, and
    // the answer is no rather than an eviction.
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 2 });

    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.acquire("s2", doc("b"), SIGNAL);

    await refuses(() => registry.acquire("s3", doc("c"), SIGNAL), "all 2 lanes are in use");
    assert.deepEqual(f.closed, [], "a held lane is never torn down to make room");
});

test("the refusal lists what is holding the lanes", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 1 });
    await registry.acquire("s1", doc("diagrams"), SIGNAL);

    await refuses(() => registry.acquire("s2", doc("viewer"), SIGNAL), "in use: diagrams");
});

test("concurrent acquires do not open two lanes for one document", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });

    const [a, b] = await Promise.allSettled([
        registry.acquire("s1", doc("a"), SIGNAL),
        registry.acquire("s2", doc("a"), SIGNAL),
    ]);

    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected", "the second should be refused, not given a second lane");
    assert.deepEqual(f.opened, ["file-a"]);
});

// --- the idle sweep ------------------------------------------------------

test("a warm lane is collected once nobody has come back for it", async () => {
    const c = clock();
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8, idleMs: 600_000, now: c.now });

    const lease = await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.release("s1");

    c.advance(599_000);
    assert.equal(await registry.collectIdle(), 0, "not yet");

    c.advance(2000);
    assert.equal(await registry.collectIdle(), 1);
    assert.deepEqual(f.closed, [lease.lane.id]);
    assert.deepEqual(registry.list(), []);
});

test("a held lane is never collected, however long it sits", async () => {
    const c = clock();
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8, idleMs: 1000, now: c.now });

    await registry.acquire("s1", doc("a"), SIGNAL);
    c.advance(10_000_000);

    assert.equal(await registry.collectIdle(), 0);
    assert.deepEqual(f.closed, []);
});

// --- the tab lock --------------------------------------------------------

test("two calls on one lane run one at a time, in order", async () => {
    // Needed even with a single agent: a client may issue parallel tool calls
    // and the plugin dispatches without awaiting.
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    const order: string[] = [];
    const slow = async (name: string, ms: number) => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        return name;
    };

    const first = registry.run(lease, () => slow("first", 40));
    const second = registry.run(lease, () => slow("second", 1));

    assert.equal((await first).value, "first");
    assert.equal((await second).value, "second");
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a queued call is told what it waited behind", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    const hold = registry.run(lease, () => new Promise((r) => setTimeout(() => r("a"), 30)));
    const queued = registry.run(lease, async () => "b");

    assert.equal((await hold).queuedBehind, 0);
    assert.equal((await queued).queuedBehind, 1);
});

test("a failing call releases the lane for the next one", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    const failed = registry.run(lease, async () => {
        throw new Error("the code threw");
    });
    const after = registry.run(lease, async () => "still works");

    await assert.rejects(() => failed, /the code threw/);
    assert.equal((await after).value, "still works");
});

test("a call that overruns tears the lane down rather than letting the next in", async () => {
    // Releasing the lock while the old call is still running inside the tab
    // would let the next one interleave, which is what the lock is for.
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8, lockTimeoutMs: 20 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);

    await refuses(() => registry.run(lease, () => new Promise(() => undefined)), "was torn down");

    assert.deepEqual(f.closed, [lease.lane.id]);
    assert.deepEqual(registry.list(), []);
});

test("a call against a lane that is gone says to connect again", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    const lease = await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.closeAll();

    await refuses(() => registry.run(lease, async () => "x"), "connect to it again");
});

test("closeAll ends every lane, held or warm", async () => {
    const f = fakeLanes();
    const registry = new LeaseRegistry(f.lanes, { capacity: 8 });
    await registry.acquire("s1", doc("a"), SIGNAL);
    await registry.acquire("s2", doc("b"), SIGNAL);
    await registry.release("s2");

    await registry.closeAll();

    assert.deepEqual(f.closed.sort(), ["lane-1", "lane-2"]);
    assert.deepEqual(registry.list(), []);
});

test("releasing a session that holds nothing is not an error", async () => {
    const registry = new LeaseRegistry(fakeLanes().lanes, { capacity: 8 });

    await registry.release("nobody");
    assert.equal(registry.heldBy("nobody"), undefined);
});
