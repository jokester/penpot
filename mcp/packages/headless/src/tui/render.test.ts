import test from "node:test";
import assert from "node:assert/strict";

import type { AccountRef, DocumentRef } from "../core/target.ts";
import type { Leftover } from "../supervisor/leftovers.ts";
import type { LaneSpec } from "../supervisor/lane.ts";
import type { LaneRecord } from "../supervisor/supervisor.ts";
import { render, stripAnsi, type Screen } from "./render.ts";

const SIZE = { cols: 80, rows: 24 };
const NOW = 1_800_000_000_000;

const ACCOUNT: AccountRef = { name: "mcp-worker", origin: "http://localhost:9001", profileDir: "/tmp/p" };

const doc = (name: string): DocumentRef => ({
    teamId: "fdbdf01d-1111-4222-8333-444455556666",
    fileId: "0a1b2c3d-4444-4555-8666-777788889999",
    name,
});

const spec = (id: string, over: Partial<LaneSpec> = {}): LaneSpec => ({
    id,
    account: ACCOUNT,
    document: doc("diagrams"),
    mode: "exec",
    headed: false,
    ...over,
});

const record = (over: Partial<LaneRecord> & { spec: LaneSpec }): LaneRecord => ({
    state: "connected",
    since: NOW - 60_000,
    ...over,
});

/** Every visible line, with the ANSI removed. */
function lines(screen: Screen, size = SIZE): string[] {
    return stripAnsi(render(screen, size)).split("\n");
}

test("an empty list says so rather than showing nothing", () => {
    const out = lines({ records: [], leftovers: [], now: NOW });

    assert.ok(out.some((line) => line.includes("no lanes")));
    assert.ok(out.some((line) => line.includes("[n] new lane")));
});

test("a connected lane shows its port, document, account and uptime", () => {
    const out = lines({
        records: [record({ spec: spec("1"), port: { http: 4601, ws: 4602 }, since: NOW - 8_040_000 })],
        leftovers: [],
        now: NOW,
    });
    const row = out.find((line) => line.includes("4601"));

    assert.ok(row !== undefined, out.join("\n"));
    assert.ok(row.includes("connected"));
    assert.ok(row.includes("diagrams"));
    assert.ok(row.includes("mcp-worker"));
    assert.ok(row.includes("headless"));
    assert.ok(row.includes("2h14m"), row);
});

test("uptime reads in the unit that matters", () => {
    const at = (ms: number) =>
        lines({ records: [record({ spec: spec("1"), since: NOW - ms })], leftovers: [], now: NOW })[2] ?? "";

    assert.ok(at(9_000).includes("9s"));
    assert.ok(at(11 * 60_000).includes("11m"));
    assert.ok(at(60 * 60_000).includes("1h00m"));
});

test("a failed lane has no uptime, because it is not up", () => {
    const out = lines({
        records: [record({ spec: spec("1"), state: "failed", error: "the plugin did not dial" })],
        leftovers: [],
        now: NOW,
    });

    assert.ok(out.some((line) => line.includes("failed") && line.includes("—")));
});

test("an opening lane shows the step it is on", () => {
    // A lane can take ninety seconds to connect. A blank row for that long
    // reads as a hang.
    const out = lines({
        records: [record({ spec: spec("1"), state: "opening", detail: "waiting for the plugin to connect" })],
        leftovers: [],
        now: NOW,
    });

    assert.ok(out.some((line) => line.includes("waiting for the plugin to connect")));
});

test("a lane with no name falls back to the start of its file id", () => {
    const out = lines({
        records: [record({ spec: spec("1", { document: { teamId: "t", fileId: "0a1b2c3d-4444-4555-8666-7777" } }) })],
        leftovers: [],
        now: NOW,
    });

    assert.ok(out.some((line) => line.includes("0a1b2c3d")));
});

test("the selected row is highlighted, and the highlight is not part of its width", () => {
    const screen: Screen = {
        records: [record({ spec: spec("1") }), record({ spec: spec("2") })],
        leftovers: [],
        selected: 1,
        now: NOW,
    };
    const raw = render(screen, SIZE);

    assert.ok(raw.includes("[7m"), "the selected row should be reversed");
    for (const line of stripAnsi(raw).split("\n")) {
        assert.ok(line.length <= SIZE.cols, `line is ${line.length} columns: ${JSON.stringify(line)}`);
    }
});

test("no line ever runs past the terminal, at any width", () => {
    const leftovers: Leftover[] = [
        { kind: "server", pid: 348, port: 4601, detail: "node index.js --a-very-long-argument-list-indeed" },
    ];
    const screen: Screen = {
        records: [record({ spec: spec("1", { document: doc("a document with a really quite long name") }) })],
        leftovers,
        message: "lane 1 already drives that document, and one document is one lane",
        now: NOW,
        portRange: { lo: 4601, hi: 4608 },
        form: {
            title: "new lane",
            fields: [{ label: "document", value: "a document with a really quite long name", hint: "modified today" }],
            cursor: 0,
            command: "mcp-headless --account mcp-worker --file-id 0a1b2c3d-4444-4555-8666-777788889999 --team-id x",
        },
    };

    for (const cols of [40, 60, 80, 100, 200]) {
        for (const line of stripAnsi(render(screen, { cols, rows: 24 })).split("\n")) {
            assert.ok(line.length <= Math.max(40, cols), `at ${cols} cols a line was ${line.length}: ${line}`);
        }
    }
});

test("leftovers are listed apart from lanes, and offered for reaping", () => {
    // Never counted as lanes, never adopted -- the list is only what this
    // supervisor started.
    const out = lines({
        records: [record({ spec: spec("1") })],
        leftovers: [
            { kind: "server", pid: 348, port: 4601, detail: "node index.js" },
            { kind: "browser", pid: 91204, detail: "profile-mcp-worker" },
        ],
        now: NOW,
    });

    assert.ok(out.some((line) => line.includes("2 leftovers from a previous run")));
    assert.ok(out.some((line) => line.includes("pid 348")));
    assert.ok(out.some((line) => line.includes("pid 91204")));
    assert.ok(out.some((line) => line.includes("[r] reap")));
});

test("one leftover is not two", () => {
    const out = lines({
        records: [],
        leftovers: [{ kind: "server", pid: 348, port: 4601, detail: "node index.js" }],
        now: NOW,
    });

    assert.ok(out.some((line) => line.includes("1 leftover from")));
});

test("the form prints the command it is equivalent to", () => {
    // How the flags get learned. The curses version did this and it was the
    // only documentation of the command line anyone read.
    const out = lines({
        records: [],
        leftovers: [],
        now: NOW,
        form: {
            title: "new lane",
            fields: [
                { label: "account", value: "mcp-worker" },
                { label: "port", value: "4607", hint: "free" },
            ],
            cursor: 1,
            command: "mcp-headless --account mcp-worker --port 4607",
        },
    });

    assert.ok(out.some((line) => line.includes("NEW LANE")));
    assert.ok(out.some((line) => line.includes("4607") && line.includes("(free)")));
    assert.ok(out.some((line) => line.includes("→ mcp-headless --account mcp-worker --port 4607")));
});

test("the cursor marks one field and only one", () => {
    const out = lines({
        records: [],
        leftovers: [],
        now: NOW,
        form: {
            title: "new lane",
            fields: [
                { label: "account", value: "mcp-worker" },
                { label: "document", value: "diagrams" },
            ],
            cursor: 1,
            command: "mcp-headless",
        },
    });

    assert.equal(out.filter((line) => line.includes("▸")).length, 1);
    assert.ok(out.find((line) => line.includes("▸"))?.includes("diagrams"));
});

test("a refusal is shown where it will be read", () => {
    const out = lines({
        records: [],
        leftovers: [],
        now: NOW,
        message: "lane 1 is already the builtin lane for mcp-worker",
    });

    assert.ok(out.some((line) => line.includes("already the builtin lane")));
});

test("the header names the published range when there is one", () => {
    const withRange = lines({ records: [], leftovers: [], now: NOW, portRange: { lo: 4601, hi: 4608 } });
    const without = lines({ records: [], leftovers: [], now: NOW });

    assert.ok(withRange[0]?.includes("4601-4608"));
    assert.ok(withRange[0]?.includes("mcp-headless"));
    assert.ok(!without[0]?.includes("4601"));
});
