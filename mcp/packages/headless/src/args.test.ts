import test from "node:test";
import assert from "node:assert/strict";

import { defaultConfigDir, parseArgs } from "./args.ts";
import { isLauncherError } from "./core/errors.ts";

const ENV: NodeJS.ProcessEnv = { HOME: "/home/worker" };

const FILE = "0a1b2c3d-4444-4555-8666-777788889999";
const TEAM = "fdbdf01d-1111-4222-8333-444455556666";

const lane = (...extra: string[]) => ["--account", "mcp-worker", "--file-id", FILE, "--team-id", TEAM, ...extra];

function refuses(argv: string[], contains: string, env: NodeJS.ProcessEnv = ENV): void {
    assert.throws(
        () => parseArgs(argv, env),
        (err: unknown) => {
            assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
            assert.ok(err.message.includes(contains), err.message);
            return true;
        }
    );
}

test("no arguments means the TUI", () => {
    const options = parseArgs([], ENV);

    assert.equal(options.command, "tui");
    assert.deepEqual(options.lanes, []);
    assert.equal(options.yes, false);
});

test("a lane is a group of flags, with exec and headless as the defaults", () => {
    const options = parseArgs(["--no-tui", ...lane()], ENV);

    assert.equal(options.command, "no-tui");
    assert.deepEqual(options.lanes, [
        { account: "mcp-worker", fileId: FILE, teamId: TEAM, mode: "exec", headed: false },
    ]);
});

test("the group repeats, so one command names several lanes", () => {
    // The systemd shape: one unit, several documents.
    const options = parseArgs(
        ["--no-tui", ...lane("--port", "4601"), "--account", "second", "--file-id", "aaa", "--team-id", "bbb"],
        ENV
    );

    assert.equal(options.lanes.length, 2);
    assert.equal(options.lanes[0]?.port, 4601);
    assert.equal(options.lanes[1]?.account, "second");
    assert.equal(options.lanes[1]?.port, undefined);
});

test("a flag that belongs to a lane must follow one", () => {
    refuses(["--file-id", FILE], "--file-id must follow an --account");
    refuses(["--headed"], "--headed must follow an --account");
});

test("a lane without both ids is refused, and says which is missing", () => {
    // A workspace URL with only a file id renders nothing at all.
    refuses(["--account", "mcp-worker", "--file-id", FILE], "needs --team-id");
    refuses(["--account", "mcp-worker", "--team-id", TEAM], "needs --file-id");
});

test("--headed with no display is refused here, not by the browser", () => {
    refuses([...lane("--headed")], "--headed needs a display");

    assert.equal(parseArgs([...lane("--headed")], { ...ENV, DISPLAY: ":3" }).lanes[0]?.headed, true);
    assert.equal(parseArgs([...lane("--headed", "--display", ":3")], ENV).lanes[0]?.display, ":3");
});

test("a port must be a port", () => {
    refuses([...lane("--port", "no")], "not a port number");
    refuses([...lane("--port", "70000")], "not a port number");
    refuses([...lane("--port", "0")], "not a port number");
});

test("a mode must be one of the four in the map", () => {
    for (const mode of ["builtin", "exec", "local", "image"]) {
        assert.equal(parseArgs([...lane("--mode", mode)], ENV).lanes[0]?.mode, mode);
    }
    refuses([...lane("--mode", "magic")], "is not one of");
});

test("a flag that takes a value says so when it has none", () => {
    refuses(["--config"], "--config needs a value");
    refuses(["--account", "--no-tui"], "--account needs a value");
});

test("an unknown argument is refused rather than ignored", () => {
    refuses(["--detach"], "unknown argument --detach");
});

test("--check and --help stand alone", () => {
    assert.equal(parseArgs(["--check"], ENV).command, "check");
    assert.equal(parseArgs(["--help"], ENV).command, "help");
    assert.equal(parseArgs(["-h"], ENV).command, "help");
    assert.equal(parseArgs(["--version"], ENV).command, "version");
});

test("the config directory follows the usual places, and can be overridden", () => {
    assert.equal(defaultConfigDir({ HOME: "/home/worker" }), "/home/worker/.config/mcp-headless");
    assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: "/etc/xdg" }), "/etc/xdg/mcp-headless");

    assert.equal(parseArgs(["--config", "/srv/headless"], ENV).configDir, "/srv/headless");
    assert.equal(parseArgs([], { ...ENV, MCP_HEADLESS_CONFIG: "/srv/env" }).configDir, "/srv/env");
});

test("--yes is remembered, because it is what skips the quit prompt", () => {
    assert.equal(parseArgs(["--yes"], ENV).yes, true);
});
