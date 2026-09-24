import test from "node:test";
import assert from "node:assert/strict";

import type { Account } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import type { LaneSupervisor } from "../supervisor/supervisor.ts";
import type { Backend } from "./facade.ts";
import { laneCapacity, supervisorLanes } from "./lanes.ts";

const isRefusal = (err: unknown) => isLauncherError(err) && err.code !== undefined;

const DOCUMENT = { fileId: "file-1", teamId: "team-1" };

function account(name: string): Account {
    return { name, origin: "http://localhost:9001", profileDir: `/tmp/${name}` };
}

/**
 * A supervisor that reports every lane connected as soon as it is opened.
 *
 * Structural rather than a full double: `supervisorLanes` uses three of its
 * methods and the rest would be scenery.
 */
function fakeSupervisor() {
    const opened: { id: string; account: string }[] = [];
    /** Every spec the supervisor was handed, for the ones that care how. */
    const specs: Record<string, unknown>[] = [];
    const closed: string[] = [];
    let listener: ((records: unknown[]) => void) | null = null;
    let next = 1;

    const records = () =>
        opened.map((lane) => ({
            spec: { id: lane.id },
            state: "connected",
            clientUrl: "http://127.0.0.1:4601/mcp",
        }));

    const supervisor = {
        async open(spec: { account: Account }) {
            const id = `lane-${next++}`;
            opened.push({ id, account: spec.account.name });
            specs.push(spec as unknown as Record<string, unknown>);
            listener?.(records());
            return id;
        },
        // The real one delivers current state on subscribe, which is what the
        // TUI draws its first frame from -- and what `settled` relies on,
        // since it subscribes after the lane has already been opened.
        subscribe(cb: (rows: unknown[]) => void) {
            listener = cb;
            queueMicrotask(() => cb(records()));
            return () => {
                listener = null;
            };
        },
        async close(id: string) {
            closed.push(id);
        },
    };

    return { supervisor: supervisor as unknown as LaneSupervisor, opened, closed, specs };
}

const backend = {} as Backend;

test("each lane takes a worker of its own", async () => {
    // The whole point of a pool: two documents open as two Penpot identities,
    // so neither sees the other's presence and selections.
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, {
        accounts: [account("worker-a"), account("worker-b")],
        flavour: "",
    });

    await lanes.open(DOCUMENT, [], AbortSignal.timeout(5_000));
    await lanes.open({ fileId: "file-2", teamId: "team-1" }, [], AbortSignal.timeout(5_000));

    assert.deepEqual(
        s.opened.map((lane) => lane.account),
        ["worker-a", "worker-b"]
    );
});

test("closing a lane frees its worker for the next document", async () => {
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, { accounts: [account("only")], flavour: "" });

    const first = await lanes.open(DOCUMENT, [], AbortSignal.timeout(5_000));
    await lanes.close(first.id);
    await lanes.open({ fileId: "file-2", teamId: "team-1" }, [], AbortSignal.timeout(5_000));

    assert.deepEqual(
        s.opened.map((lane) => lane.account),
        ["only", "only"]
    );
});

test("running out of workers says so, and says what fixes it", async () => {
    // Distinct from the registry's capacity refusal: the lanes are free and
    // the workers are not, which waiting does not fix.
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, { accounts: [account("only")], flavour: "" });

    await lanes.open(DOCUMENT, [], AbortSignal.timeout(5_000));

    await assert.rejects(
        () => lanes.open({ fileId: "file-2", teamId: "team-1" }, [], AbortSignal.timeout(5_000)),
        (err: unknown) => isLauncherError(err) && /provision another/.test(err.message)
    );
});

test("only a worker that can see the document is given the lane", async () => {
    // Two workers need not be in the same teams. Handing a document to a
    // worker that cannot see it opens a workspace that renders nothing, and
    // the lane fails ninety seconds later as a plugin that never connected.
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, {
        accounts: [account("worker-a"), account("worker-b")],
        flavour: "",
    });

    await lanes.open(DOCUMENT, ["worker-b"], AbortSignal.timeout(5_000));

    assert.deepEqual(
        s.opened.map((lane) => lane.account),
        ["worker-b"]
    );
});

test("a document no worker can see is refused before a lane is opened", async () => {
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, { accounts: [account("worker-a")], flavour: "" });

    await assert.rejects(
        () => lanes.open(DOCUMENT, ["worker-z"], AbortSignal.timeout(5_000)),
        (err: unknown) => isLauncherError(err) && /no configured worker can see/.test(err.message)
    );
    assert.deepEqual(s.opened, []);
});

test("a lane that never connects gives its worker back", async () => {
    // Otherwise a failed open costs a worker permanently, and the pool drains
    // one bad document at a time.
    // Nothing here ever reports connected, so every open times out.
    const quiet = {
        async open() {
            return "lane-x";
        },
        subscribe() {
            return () => undefined;
        },
        async close() {},
    } as unknown as LaneSupervisor;

    const quietLanes = supervisorLanes(quiet, backend, {
        accounts: [account("only")],
        flavour: "",
        openTimeoutMs: 50,
    });
    await assert.rejects(() => quietLanes.open(DOCUMENT, [], AbortSignal.timeout(5_000)));

    // The pool is whole again: a second attempt is refused for the timeout,
    // not for having no worker left.
    await assert.rejects(
        () => quietLanes.open(DOCUMENT, [], AbortSignal.timeout(5_000)),
        (err: unknown) => !/every worker/.test(String(err))
    );
});

// --- capacity -------------------------------------------------------------

test("capacity is whichever of ports and workers runs out first", async () => {
    // Both are real ceilings. Eight ports are four lanes; two workers are two.
    assert.equal(laneCapacity({ lo: 4601, hi: 4608 }), 4);
    assert.equal(laneCapacity({ lo: 4601, hi: 4608 }, 2), 2);
    assert.equal(laneCapacity({ lo: 4601, hi: 4604 }, 9), 2);
});

test("a range with no room for a lane is refused, and so is an empty pool", async () => {
    assert.throws(() => laneCapacity({ lo: 4601, hi: 4601 }), isRefusal);
    assert.throws(() => laneCapacity({ lo: 4601, hi: 4608 }, 0), isRefusal);
});

test("the façade's own lanes can be headed, which nothing else can reach", async () => {
    // --headed is a lane flag, and the façade names no lanes on a command
    // line, so without this its browsers are unwatchable by construction.
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, {
        accounts: [account("only")],
        flavour: "",
        headed: true,
        display: ":3",
    });

    await lanes.open(DOCUMENT, [], AbortSignal.timeout(5_000));

    assert.equal(s.specs[0]?.headed, true);
    assert.equal(s.specs[0]?.display, ":3");
});

test("a headless pool passes no display at all", async () => {
    const s = fakeSupervisor();
    const lanes = supervisorLanes(s.supervisor, backend, { accounts: [account("only")], flavour: "" });

    await lanes.open(DOCUMENT, [], AbortSignal.timeout(5_000));

    assert.equal(s.specs[0]?.headed, false);
    assert.equal("display" in (s.specs[0] ?? {}), false);
});
