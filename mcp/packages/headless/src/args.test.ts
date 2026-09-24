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

test("--columns overrides the file, and refuses a name that does not exist", () => {
    assert.deepEqual(parseArgs(["--columns", "port,client"], ENV).columns, ["port", "client"]);
    assert.equal(parseArgs([], ENV).columns, undefined, "no flag means the file decides");
    refuses(["--columns", "pid"], "there is no pid column");
    refuses(["--columns"], "--columns needs a value");
});

test("--listen and --no-serve reach the options", () => {
    assert.equal(parseArgs([], ENV).serve, true, "the endpoint is open unless it is turned off");
    assert.equal(parseArgs(["--no-serve"], ENV).serve, false);

    assert.deepEqual(parseArgs(["--listen", "4500"], ENV).listen, { port: 4500 });
    assert.deepEqual(parseArgs(["--listen", "0.0.0.0:4500"], ENV).listen, { host: "0.0.0.0", port: 4500 });
    assert.equal(parseArgs([], ENV).listen, undefined, "no flag means the environment or the default decides");
});

test("--listen refuses an address that is not one", () => {
    refuses(["--listen", "nope"], "is not a port number");
    refuses(["--listen"], "--listen needs a value");
});

test("--port still belongs to a lane, not to the endpoint", () => {
    // Two meanings for one flag would be a trap; the endpoint uses --listen.
    refuses(["--port", "4400"], "--port must follow an --account");
    assert.equal(parseArgs([...lane("--port", "4601")], ENV).lanes[0]?.port, 4601);
});

test("the bare invocation and `server` are the same command", async () => {
    // The bare form is in shell history and in MCP client configuration; a
    // subcommand added beside it must not change what it means.
    const bare = parseArgs(["--no-tui", "--account", "a", "--file-id", FILE, "--team-id", TEAM], ENV);
    const named = parseArgs(["server", "--no-tui", "--account", "a", "--file-id", FILE, "--team-id", TEAM], ENV);

    assert.deepEqual(named, bare);
});

test("a subcommand nobody has heard of is refused naming the ones that exist", async () => {
    assert.throws(
        () => parseArgs(["provision"], ENV),
        (err: unknown) =>
            isLauncherError(err) && /server/.test(err.message) && /provision-worker-user/.test(err.message)
    );
});

test("provisioning with no email means the workers conf.yaml names", async () => {
    // Which workers those are is not knowable here: it needs the file. So the
    // parser accepts the absence and main decides, which is also where the
    // "there are none left to provision" message can name the file.
    const options = parseArgs(["provision-worker-user"], ENV);

    assert.equal(options.command, "provision");
    assert.equal(options.provision?.email, "");
});

test("provisioning defaults the account name to the email's local part", async () => {
    const options = parseArgs(["provision-worker-user", "--email", "worker-a@penpot.local"], ENV);

    assert.equal(options.command, "provision");
    assert.equal(options.provision?.email, "worker-a@penpot.local");
    // Left undefined here: main derives it, so the default lives in one place.
    assert.equal(options.provision?.account, undefined);
    assert.equal(options.provision?.fileName, "worker-scratch");
    assert.equal(options.provision?.mintToken, false);
});

test("a worker can be invited to several teams at once", async () => {
    const options = parseArgs(
        ["provision-worker-user", "--email", "w@x.test", "--invite", "link-one", "--invite", "link-two"],
        ENV
    );

    assert.deepEqual(options.provision?.invitations, ["link-one", "link-two"]);
});

test("--file-name '' means no scratch document, not a missing value", async () => {
    const options = parseArgs(["provision-worker-user", "--email", "w@x.test", "--file-name", ""], ENV);

    assert.equal(options.provision?.fileName, "");
});

test("--password is refused rather than accepted quietly", async () => {
    // A flag's value is in the shell history and in every process list on the
    // host. Ignoring it would leave the password exposed and the caller
    // thinking it had been used.
    assert.throws(
        () => parseArgs(["provision-worker-user", "--email", "w@x.test", "--password", "hunter2"], ENV),
        (err: unknown) => isLauncherError(err) && /MCP_HEADLESS_WORKER_PASSWORD/.test(err.message)
    );
});

test("provisioning opens no endpoint and names no lanes", async () => {
    const options = parseArgs(["provision-worker-user", "--email", "w@x.test"], ENV);

    assert.equal(options.serve, false);
    assert.deepEqual(options.lanes, []);
});

test("a subcommand after the flags is told where it belongs", async () => {
    // Reporting it as an unknown argument is true and useless: the word is
    // right, only its position is wrong.
    assert.throws(
        () => parseArgs(["--config", "/etc/headless", "server"], ENV),
        (err: unknown) => isLauncherError(err) && /must come first/.test(err.message)
    );
});
