import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError, type ErrorCode } from "./errors.ts";
import { normalizeOrigin, parseWorkspaceUrl, workspaceUrl, type AccountRef, type DocumentRef } from "./target.ts";

const ACCOUNT: AccountRef = {
    name: "mcp-worker",
    origin: "http://localhost:9001",
    profileDir: "/home/worker/.cache/penpot-headless/profile-mcp-worker",
};

const TEAM = "fdbdf01d-1111-4222-8333-444455556666";
const FILE = "0a1b2c3d-4444-4555-8666-777788889999";
const PAGE = "deadbeef-0000-4111-8222-333344445555";

const DOC: DocumentRef = { teamId: TEAM, fileId: FILE };

/** Asserts `fn` refuses with a specific code, and names the field in the detail. */
function refuses(fn: () => unknown, code: ErrorCode, field?: string): void {
    assert.throws(fn, (err: unknown) => {
        assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
        assert.equal(err.code, code);
        if (field !== undefined) assert.equal(err.detail.field, field);
        return true;
    });
}

test("a workspace URL carries both ids, in the form 2.17 answers", () => {
    assert.equal(workspaceUrl(ACCOUNT, DOC), `http://localhost:9001/#/workspace?team-id=${TEAM}&file-id=${FILE}`);
});

test("a page id is included only when asked for", () => {
    const url = workspaceUrl(ACCOUNT, { ...DOC, pageId: PAGE });
    assert.ok(url.endsWith(`&page-id=${PAGE}`));
    assert.ok(!workspaceUrl(ACCOUNT, DOC).includes("page-id"));
});

test("the document name never reaches the URL", () => {
    assert.equal(workspaceUrl(ACCOUNT, { ...DOC, name: "LLM session viewer" }), workspaceUrl(ACCOUNT, DOC));
});

test("a trailing slash on the origin does not double up", () => {
    assert.equal(workspaceUrl({ ...ACCOUNT, origin: "http://localhost:9001/" }, DOC), workspaceUrl(ACCOUNT, DOC));
    assert.equal(normalizeOrigin("https://design.penpot.app///"), "https://design.penpot.app");
});

test("a URL round trips", () => {
    assert.deepEqual(parseWorkspaceUrl(workspaceUrl(ACCOUNT, DOC)), DOC);
    assert.deepEqual(parseWorkspaceUrl(workspaceUrl(ACCOUNT, { ...DOC, pageId: PAGE })), { ...DOC, pageId: PAGE });
});

test("the query-string routing style parses too", () => {
    // Penpot's develop branch moved to ?screen=…; the hash form is legacy and
    // scheduled for removal. An operator pastes whichever their browser shows.
    const url = `https://design.penpot.app/?screen=workspace&team-id=${TEAM}&file-id=${FILE}`;
    assert.deepEqual(parseWorkspaceUrl(url), DOC);
});

test("an empty id is refused rather than driving the wrong document", () => {
    refuses(
        () => parseWorkspaceUrl(`http://localhost:9001/#/workspace?team-id=${TEAM}&file-id=`),
        "blank-id",
        "file-id"
    );
    refuses(
        () => parseWorkspaceUrl(`http://localhost:9001/#/workspace?team-id=&file-id=${FILE}`),
        "blank-id",
        "team-id"
    );
    refuses(() => workspaceUrl(ACCOUNT, { ...DOC, fileId: "   " }), "blank-id", "file-id");
});

test("a missing team-id is refused, because the page would render nothing", () => {
    refuses(() => parseWorkspaceUrl(`http://localhost:9001/#/workspace?file-id=${FILE}`), "missing-id", "team-id");
});

test("a missing file-id is refused", () => {
    refuses(() => parseWorkspaceUrl(`http://localhost:9001/#/workspace?team-id=${TEAM}`), "missing-id", "file-id");
});

test("an id that is not a uuid is refused", () => {
    refuses(
        () => parseWorkspaceUrl(`http://localhost:9001/#/workspace?team-id=${TEAM}&file-id=scratch`),
        "bad-id",
        "file-id"
    );
    refuses(() => workspaceUrl(ACCOUNT, { ...DOC, teamId: `${TEAM}-extra` }), "bad-id", "team-id");
    refuses(() => workspaceUrl(ACCOUNT, { ...DOC, pageId: "1" }), "bad-id", "page-id");
});

test("a URL with no parameters at all is refused", () => {
    refuses(() => parseWorkspaceUrl("http://localhost:9001/#/workspace"), "missing-id");
    refuses(() => parseWorkspaceUrl("http://localhost:9001/dashboard"), "missing-id");
});

test("ids are lowercased, so one document never looks like two", () => {
    const parsed = parseWorkspaceUrl(`http://localhost:9001/#/workspace?team-id=${TEAM.toUpperCase()}&file-id=${FILE}`);

    assert.equal(parsed.teamId, TEAM);
    assert.deepEqual(parsed, DOC);
});

test("extra parameters are ignored rather than rejected", () => {
    const url = `http://localhost:9001/#/workspace?team-id=${TEAM}&file-id=${FILE}&layout=layers&plugin=mcp`;
    assert.deepEqual(parseWorkspaceUrl(url), DOC);
});
