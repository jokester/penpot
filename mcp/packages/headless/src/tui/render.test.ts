import test from "node:test";
import assert from "node:assert/strict";

import type { AccountRef, DocumentRef } from "../core/target.ts";
import type { Leftover } from "../supervisor/leftovers.ts";
import type { LaneSpec } from "../supervisor/lane.ts";
import type { LaneRecord } from "../supervisor/supervisor.ts";
import { render, statusFor, stripAnsi, valueOf, type Screen } from "./render.ts";

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

test("the columns shown are the ones asked for, in that order", () => {
    const rec = record({ spec: spec("1"), port: { http: 4601, ws: 4602 } });
    const out = lines({ records: [rec], leftovers: [], now: NOW, columns: ["client", "port"] });

    const header = out[1] ?? "";
    assert.ok(header.indexOf("client") < header.indexOf("port"), header);
    assert.ok(!header.includes("uptime"), "a column not asked for must not appear");
});

test("every column can be read off a lane", () => {
    const rec = record({
        spec: spec("1", { headed: true, display: ":3", document: { ...doc("diagrams"), teamName: "ihate-workspace" } }),
        port: { http: 4605, ws: 4606 },
        clientUrl: "http://127.0.0.1:4605/mcp",
        since: NOW - 60_000,
    });

    assert.equal(valueOf("port", rec, NOW), "4605");
    assert.equal(valueOf("state", rec, NOW), "connected");
    assert.equal(valueOf("document", rec, NOW), "diagrams");
    assert.equal(valueOf("team", rec, NOW), "ihate-workspace");
    assert.equal(valueOf("account", rec, NOW), "mcp-worker");
    assert.equal(valueOf("browser", rec, NOW), "headed");
    assert.equal(valueOf("display", rec, NOW), ":3");
    assert.equal(valueOf("mode", rec, NOW), "exec");
    assert.equal(valueOf("uptime", rec, NOW), "1m");
    assert.equal(valueOf("client", rec, NOW), "http://127.0.0.1:4605/mcp");
});

test("a team with no name falls back to the start of its id", () => {
    const rec = record({ spec: spec("1") });

    assert.equal(valueOf("team", rec, NOW), "fdbdf01d");
});

test("a headless lane has no display to show", () => {
    assert.equal(valueOf("display", record({ spec: spec("1") }), NOW), "—");
});

test("the status bar carries what the columns cannot", () => {
    // The reason the document column can afford to show a name.
    const rec = record({
        spec: spec("1", { document: doc("diagrams") }),
        port: { http: 4601, ws: 4602 },
        clientUrl: "http://127.0.0.1:4601/mcp",
    });
    const status = statusFor(rec);

    assert.ok(status.includes(rec.spec.document.fileId), status);
    assert.ok(status.includes(rec.spec.document.teamId), status);
    assert.ok(status.includes("http://127.0.0.1:4601/mcp"), status);
});

test("a failed lane's reason reaches the status bar", () => {
    const status = statusFor(record({ spec: spec("1"), state: "failed", error: "the plugin did not dial" }));

    assert.ok(status.includes("the plugin did not dial"), status);
});

test("the status bar describes the selected lane, not the first", () => {
    const a = record({ spec: spec("1", { document: doc("first") }) });
    const b = record({
        spec: spec("2", { document: { ...doc("second"), fileId: "beefcafe-0000-4111-8222-333344445555" } }),
    });
    const out = lines({ records: [a, b], leftovers: [], selected: 1, now: NOW });

    assert.ok(out.some((line) => line.includes("beefcafe-0000-4111-8222-333344445555")));
});

test("the status bar can be turned off", () => {
    const rec = record({ spec: spec("1") });
    const on = lines({ records: [rec], leftovers: [], now: NOW });
    const off = lines({ records: [rec], leftovers: [], now: NOW, statusBar: false });

    assert.ok(on.some((line) => line.includes(rec.spec.document.fileId)));
    assert.ok(!off.some((line) => line.includes(rec.spec.document.fileId)));
});

test("a custom status overrides the description of the selection", () => {
    const out = lines({ records: [], leftovers: [], now: NOW, status: "enter expands · escape closes" });

    assert.ok(out.some((line) => line.includes("enter expands")));
});

test("no line runs past the terminal with every column at once", () => {
    const rec = record({
        spec: spec("1", {
            headed: true,
            display: ":3",
            document: { ...doc("a really quite long document name"), teamName: "a really quite long team name" },
        }),
        port: { http: 4601, ws: 4602 },
        clientUrl: "http://127.0.0.1:4601/mcp",
    });

    for (const cols of [40, 60, 80, 120, 200]) {
        const screen: Screen = {
            records: [rec],
            leftovers: [],
            now: NOW,
            columns: ["port", "state", "document", "team", "account", "browser", "display", "mode", "uptime", "client"],
        };
        for (const line of stripAnsi(render(screen, { cols, rows: 24 })).split("\n")) {
            assert.ok(line.length <= Math.max(40, cols), `at ${cols} cols a line was ${line.length}`);
        }
    }
});

test("the footer offers a details view now that there is one", () => {
    const out = lines({ records: [record({ spec: spec("1") })], leftovers: [], now: NOW });

    assert.ok(out.some((line) => line.includes("[enter] details")));
});

test("the footer offers reaping only when there is something to reap", () => {
    const withWreckage = lines({
        records: [],
        leftovers: [{ kind: "server", pid: 348, port: 4601, detail: "node index.js" }],
        now: NOW,
    });
    const without = lines({ records: [record({ spec: spec("1") })], leftovers: [], now: NOW });

    assert.ok(withWreckage.some((line) => line.includes("[r] reap")));
    assert.ok(without.some((line) => line.includes("[r] retry")));
});

test("the form's footer names the form's keys, not the list's", () => {
    const out = lines({
        records: [],
        leftovers: [],
        now: NOW,
        form: { title: "new lane", fields: [{ label: "account", value: "mcp-worker" }], cursor: 0, command: "x" },
    });

    assert.ok(out.some((line) => line.includes("[enter] choose or start")));
    assert.ok(!out.some((line) => line.includes("[n] new lane")), "a list key while typing would be a lie");
});

test("an open list is drawn under the row it belongs to", () => {
    const out = lines({
        records: [],
        leftovers: [],
        now: NOW,
        form: {
            title: "new lane",
            fields: [
                { label: "account", value: "mcp-worker" },
                { label: "document", value: "Default / worker-scratch" },
            ],
            cursor: 1,
            command: "x",
            expansion: { options: ["ihate-workspace / diagrams", "Default / worker-scratch"], index: 1 },
        },
    });

    const row = out.findIndex((line) => line.includes("▸ Default / worker-scratch"));
    assert.ok(row >= 0, out.join("\n"));
    assert.ok(out[row + 1]?.includes("ihate-workspace / diagrams"), "the options follow the row");
    assert.ok(out[row + 2]?.includes("› Default / worker-scratch"), "the highlight marks the current one");
});

test("details shows what the columns cannot hold", () => {
    const rec = record({
        spec: spec("1", { headed: true, display: ":3", document: { ...doc("diagrams"), teamName: "ihate-workspace" } }),
        port: { http: 4601, ws: 4602 },
        clientUrl: "http://127.0.0.1:4601/mcp",
    });
    const out = lines({ records: [rec], leftovers: [], now: NOW, details: rec });

    assert.ok(out.some((line) => line.includes("LANE 1")));
    assert.ok(out.some((line) => line.includes(rec.spec.document.fileId)));
    assert.ok(out.some((line) => line.includes(rec.spec.document.teamId)));
    assert.ok(out.some((line) => line.includes("http 4601")));
    assert.ok(out.some((line) => line.includes("headed on :3")));
    assert.ok(out.some((line) => line.includes("[esc] back")));
    assert.ok(!out.some((line) => line.includes("[n] new lane")), "details is not the list");
});

test("a failed lane's details carry its reason and its last output", () => {
    const rec = record({
        spec: spec("1"),
        state: "failed",
        error: "the plugin did not dial",
        log: ["line one", "line two"],
    });
    const out = lines({ records: [rec], leftovers: [], now: NOW, details: rec });

    assert.ok(out.some((line) => line.includes("the plugin did not dial")));
    assert.ok(out.some((line) => line.includes("line two")));
});

test("no line runs past the terminal in details either", () => {
    const rec = record({
        spec: spec("1", { document: { ...doc("a really quite long document name"), teamName: "a long team name" } }),
        port: { http: 4601, ws: 4602 },
        clientUrl: "http://127.0.0.1:4601/mcp",
        log: ["a log line that goes on and on and on and really does not stop for quite some time at all"],
    });

    for (const cols of [40, 60, 80, 120]) {
        for (const line of stripAnsi(
            render({ records: [rec], leftovers: [], now: NOW, details: rec }, { cols, rows: 24 })
        ).split("\n")) {
            assert.ok(line.length <= Math.max(40, cols), `at ${cols} cols a line was ${line.length}`);
        }
    }
});
