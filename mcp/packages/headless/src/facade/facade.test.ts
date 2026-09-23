import test from "node:test";
import assert from "node:assert/strict";

import type { Account } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import type { AccountCatalogue, Catalogue, DocumentChoice } from "../penpot/catalogue.ts";
import { DOCUMENT_TOOLS, Facade, STATIC_TOOLS, resolveDocument, type Backend, type CallResult } from "./facade.ts";
import { LeaseRegistry, type LaneHandle, type LaneSource } from "./leases.ts";

const TEAM_A = "a666c135-9926-812e-8008-a9e10b11d329";
const TEAM_B = "fdbdf01d-1111-4222-8333-444455556666";

const ACCOUNT: Account = {
    name: "mcp-worker",
    origin: "http://localhost:9001",
    profileDir: "/tmp/p",
    email: "w@example.test",
    password: "hunter2",
    mcpToken: "tok",
};

const choice = (fileId: string, fileName: string, teamName: string, teamId = TEAM_B): DocumentChoice => ({
    fileId,
    teamId,
    fileName,
    teamName,
    modifiedAt: "2026-09-20T00:00:00Z",
});

const DOCUMENTS = [
    choice("file-diagrams", "diagrams", "ihate-workspace"),
    choice("file-viewer", "LLM session viewer", "ihate-workspace"),
    choice("file-scratch", "worker-scratch", "Default", TEAM_A),
];

const SIGNAL = new AbortController().signal;
const STATIC_ENDPOINT = "http://localhost:9001/mcp/stream?userToken=tok";

const text = (value: unknown): CallResult => ({ content: [{ type: "text", text: JSON.stringify({ result: value }) }] });

/** A catalogue that answers from a list. */
function fakeCatalogue(result: AccountCatalogue = { documents: DOCUMENTS, problem: null }): Catalogue {
    return {
        forAccount: async () => result,
        cached: () => result,
        forget: () => undefined,
    };
}

/** A backend that records every call and answers from a script. */
function fakeBackend(answers: Record<string, CallResult> = {}) {
    const calls: { endpoint: string; tool: string; args: Record<string, unknown> }[] = [];

    const backend: Backend = {
        async call(endpoint, tool, args) {
            calls.push({ endpoint, tool, args: { ...args } });
            return answers[tool] ?? text("ok");
        },
    };
    return { backend, calls };
}

/** Lanes that open instantly and remember what happened. */
function fakeLanes() {
    const opened: string[] = [];
    let next = 1;
    const lanes: LaneSource = {
        async open(document): Promise<LaneHandle> {
            opened.push(document.fileId);
            const lane = { id: `lane-${next}`, clientUrl: `http://127.0.0.1:${4600 + next * 2}/mcp` };
            next += 1;
            return lane;
        },
        async close() {},
        async wipe() {},
    };
    return { lanes, opened };
}

function build(over: { catalogue?: Catalogue; answers?: Record<string, CallResult>; capacity?: number } = {}) {
    const l = fakeLanes();
    const b = fakeBackend(over.answers);
    const leases = new LeaseRegistry(l.lanes, { capacity: over.capacity ?? 8 });
    const facade = new Facade({
        leases,
        backend: b.backend,
        catalogue: over.catalogue ?? fakeCatalogue(),
        account: ACCOUNT,
        staticEndpoint: STATIC_ENDPOINT,
    });
    return { facade, leases, ...l, ...b };
}

function refuses(fn: () => Promise<unknown>, contains: string): Promise<void> {
    return assert.rejects(fn, (err: unknown) => {
        assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
        assert.ok(err.message.includes(contains), err.message);
        return true;
    });
}

// --- resolving a document ------------------------------------------------

test("a document resolves by name, by id, and by a unique fragment", () => {
    assert.equal(resolveDocument("diagrams", DOCUMENTS).fileId, "file-diagrams");
    assert.equal(resolveDocument("file-viewer", DOCUMENTS).fileId, "file-viewer");
    assert.equal(resolveDocument("session", DOCUMENTS).fileId, "file-viewer");
    assert.equal(resolveDocument("Default /", DOCUMENTS).fileId, "file-scratch");
});

test("resolving ignores case and surrounding space", () => {
    assert.equal(resolveDocument("  DIAGRAMS  ", DOCUMENTS).fileId, "file-diagrams");
});

test("an ambiguous query is refused rather than guessed at", () => {
    // Driving the wrong document is the expensive mistake in this system.
    assert.throws(
        () => resolveDocument("ihate", DOCUMENTS),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.ok(err.message.includes("matches 2 documents"), err.message);
            return true;
        }
    );
});

test("an unknown document is refused, naming the ones there are", () => {
    assert.throws(
        () => resolveDocument("nonesuch", DOCUMENTS),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.ok(err.message.includes("ihate-workspace / diagrams"), err.message);
            return true;
        }
    );
});

test("an empty query asks for one rather than picking", () => {
    assert.throws(
        () => resolveDocument("   ", DOCUMENTS),
        (err: unknown) => isLauncherError(err)
    );
});

// --- the tool surface ----------------------------------------------------

test("the hard-coded tools are the ones a lane advertises", () => {
    // Taken from a live single-user lane on 2026-09-23. A live test asserts
    // this still holds, so drift fails rather than surprising an agent.
    assert.deepEqual([...DOCUMENT_TOOLS], ["execute_code", "export_shape", "import_image"]);
    assert.deepEqual([...STATIC_TOOLS], ["high_level_overview", "penpot_api_info"]);
});

test("a static tool needs no document and no lane", async () => {
    // The server's own instructions tell an agent to read the overview first,
    // before it could possibly have connected to anything.
    const f = build();
    await f.facade.callStatic("high_level_overview", {}, SIGNAL);

    assert.deepEqual(f.calls, [{ endpoint: STATIC_ENDPOINT, tool: "high_level_overview", args: {} }]);
    assert.deepEqual(f.opened, [], "no lane should have been opened");
});

// --- listing and connecting ----------------------------------------------

test("documents are listed by team and name", async () => {
    const f = build();

    assert.deepEqual(await f.facade.listDocuments(SIGNAL), {
        documents: ["ihate-workspace / diagrams", "ihate-workspace / LLM session viewer", "Default / worker-scratch"],
        problem: null,
    });
});

test("connecting binds the session and reports what it got", async () => {
    const f = build();
    const connected = await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    assert.equal(connected.document, "ihate-workspace / diagrams");
    assert.equal(connected.fileId, "file-diagrams");
    assert.equal(connected.teamId, TEAM_B);
    assert.equal(f.leases.heldBy("s1")?.document.fileId, "file-diagrams");
});

test("connecting reports anyone else already in the file", async () => {
    // A person editing the same document cannot be prevented, so the next best
    // thing is to say so.
    const f = build({ answers: { execute_code: text(["Wang", "someone else"]) } });
    const connected = await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    assert.deepEqual(connected.alsoEditing, ["Wang", "someone else"]);
});

test("failing to ask who else is there does not fail the connection", async () => {
    const f = build({ answers: { execute_code: { content: [], isError: true } } });
    const connected = await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    assert.deepEqual(connected.alsoEditing, []);
    assert.equal(f.leases.heldBy("s1")?.document.fileId, "file-diagrams");
});

test("a second client is refused the document, by name", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    await refuses(() => f.facade.connectDoc("s2", "diagrams", SIGNAL), "already held by another client");
});

test("an account with no documents says so rather than offering nothing", async () => {
    const f = build({ catalogue: fakeCatalogue({ documents: [], problem: "get-teams failed: HTTP 401" }) });

    await refuses(() => f.facade.connectDoc("s1", "anything", SIGNAL), "HTTP 401");
});

test("disconnecting says what it gave back, and holds nothing after", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    assert.deepEqual(await f.facade.disconnectDoc("s1"), { released: "diagrams" });
    assert.equal(f.leases.heldBy("s1"), undefined);
});

test("disconnecting with nothing held is not an error", async () => {
    const f = build();

    assert.deepEqual(await f.facade.disconnectDoc("s1"), { released: null });
});

test("a closed transport releases the lease", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    await f.facade.releaseSession("s1");

    assert.equal(f.leases.heldBy("s1"), undefined);
    // Released, not destroyed: the next holder gets it warm.
    assert.deepEqual(
        f.leases.list().map((l) => l.holder),
        [null]
    );
});

// --- calling a document tool ---------------------------------------------

test("a call with no document uses the one the session holds", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);
    f.calls.length = 0;

    await f.facade.callDocument("s1", "execute_code", { code: "return 1;" }, SIGNAL);

    assert.equal(f.calls[0]?.endpoint, "http://127.0.0.1:4602/mcp");
    assert.deepEqual(f.calls[0]?.args, { code: "return 1;" }, "the routing argument must not reach the backend");
});

test("a call naming a document switches to it, which is also how a lost session recovers", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    await f.facade.callDocument("s1", "execute_code", { code: "return 1;", document: "worker-scratch" }, SIGNAL);

    assert.equal(f.leases.heldBy("s1")?.document.fileId, "file-scratch");
    assert.deepEqual(f.opened, ["file-diagrams", "file-scratch"]);
});

test("a call with no document and nothing held says what to do", async () => {
    const f = build();

    await refuses(
        () => f.facade.callDocument("s1", "execute_code", { code: "return 1;" }, SIGNAL),
        "call connect_doc first"
    );
});

test("a call reports what it queued behind", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);

    const ran = await f.facade.callDocument("s1", "execute_code", { code: "return 1;" }, SIGNAL);
    assert.equal(ran.queuedBehind, 0);
});

test("every document tool routes to the lane, not the static endpoint", async () => {
    const f = build();
    await f.facade.connectDoc("s1", "diagrams", SIGNAL);
    f.calls.length = 0;

    for (const tool of DOCUMENT_TOOLS) await f.facade.callDocument("s1", tool, {}, SIGNAL);

    assert.deepEqual(
        f.calls.map((c) => c.tool),
        [...DOCUMENT_TOOLS]
    );
    assert.ok(
        f.calls.every((c) => c.endpoint.startsWith("http://127.0.0.1:")),
        "document tools must never go to the instance's own endpoint"
    );
});
