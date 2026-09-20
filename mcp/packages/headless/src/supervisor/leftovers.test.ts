import test from "node:test";
import assert from "node:assert/strict";

import { allocate } from "../core/ports.ts";
import type { AccountRef } from "../core/target.ts";
import { FakeExecBackend } from "../exec/fake.ts";
import { describe, parseBrowsers, parseServers, reap, scan, type HostProcesses, type Leftover } from "./leftovers.ts";

const RANGE = { lo: 4601, hi: 4608 };

const ACCOUNT: AccountRef = {
    name: "mcp-worker",
    origin: "http://localhost:9001",
    profileDir: "/home/worker/.cache/penpot-headless/profile-mcp-worker",
};

/** What the in-container scan script prints when two lanes were killed mid-flight. */
const SCAN_OUTPUT = `348 4601 node index.js
402 4603 node index.js
`;

/** A host process table a test can write by hand. */
function host(processes: readonly { pid: number; command: string }[] = []): HostProcesses & { killed: number[] } {
    const killed: number[] = [];
    return {
        killed,
        list: async () => processes,
        kill: async (pid) => {
            killed.push(pid);
        },
    };
}

test("servers inside the range are found, with their ports", () => {
    assert.deepEqual(parseServers(SCAN_OUTPUT, RANGE), [
        { kind: "server", pid: 348, port: 4601, detail: "node index.js" },
        { kind: "server", pid: 402, port: 4603, detail: "node index.js" },
    ]);
});

test("the container's own server is never offered for reaping", () => {
    // Pid 1 is the image's CMD. It sets no PENPOT_MCP_SERVER_PORT, so the scan
    // script never prints it -- and if something else did, its 4401 is outside
    // the lane range. Killing it would take the container down.
    assert.deepEqual(parseServers("1 4401 node index.js --multi-user", RANGE), []);
});

test("junk in the scan output is skipped rather than guessed at", () => {
    assert.deepEqual(parseServers("\nnot a row\n  \nxyz abc node\n", RANGE), []);
});

test("a server with no command still reports something readable", () => {
    assert.equal(parseServers("348 4601", RANGE)[0]?.detail, "node");
});

test("browsers are found by the profile directory they hold", () => {
    const processes = [
        { pid: 91204, command: `/opt/chromium --user-data-dir=${ACCOUNT.profileDir} --headless` },
        { pid: 91300, command: "/usr/bin/firefox" },
        { pid: 91400, command: "/opt/chromium --user-data-dir=/home/someone/.config/chromium" },
    ];

    assert.deepEqual(parseBrowsers(processes, [ACCOUNT]), [
        { kind: "browser", pid: 91204, detail: ACCOUNT.profileDir },
    ]);
});

test("a browser that is not ours is left alone", () => {
    // The profile directory is the only honest marker, so anything else is
    // somebody's own browser and the operator decides.
    const processes = [{ pid: 1, command: "/opt/chromium --user-data-dir=/home/mono/.config/chromium" }];

    assert.deepEqual(parseBrowsers(processes, [ACCOUNT]), []);
});

test("an account with no profile directory matches nothing", () => {
    const processes = [{ pid: 5, command: "/opt/chromium --user-data-dir=" }];

    assert.deepEqual(parseBrowsers(processes, [{ ...ACCOUNT, profileDir: "" }]), []);
    assert.deepEqual(parseBrowsers(processes, []), []);
});

test("a scan reports both kinds together", async () => {
    const backend = new FakeExecBackend({ runs: () => ({ code: 0, stdout: SCAN_OUTPUT, stderr: "" }) });
    const h = host([{ pid: 91204, command: `chromium --user-data-dir=${ACCOUNT.profileDir}` }]);

    const found = await scan({ backend, portRange: RANGE, accounts: [ACCOUNT], host: h });

    assert.deepEqual(
        found.map((l) => l.kind),
        ["server", "server", "browser"]
    );
});

test("a launcher with no deployment still checks for stray browsers", async () => {
    const h = host([{ pid: 91204, command: `chromium --user-data-dir=${ACCOUNT.profileDir}` }]);
    const found = await scan({ portRange: RANGE, accounts: [ACCOUNT], host: h });

    assert.deepEqual(found, [{ kind: "browser", pid: 91204, detail: ACCOUNT.profileDir }]);
});

test("a probe that fails leaves the launcher able to start", async () => {
    // Being unable to check for wreckage is not a reason to refuse to run.
    const broken = new FakeExecBackend({
        runs: () => {
            throw new Error("docker is not running");
        },
    });
    const h: HostProcesses = {
        list: async () => {
            throw new Error("no /proc");
        },
        kill: async () => undefined,
    };

    assert.deepEqual(await scan({ backend: broken, portRange: RANGE, accounts: [ACCOUNT], host: h }), []);
});

test("a leftover's ports are excluded from allocation without anyone arranging it", async () => {
    // The container is the source of truth for busy ports, so a leftover that
    // is still listening is already accounted for -- there is no separate list
    // to keep in step.
    const backend = new FakeExecBackend({ listening: [4601, 4602] });

    assert.deepEqual(allocate(RANGE, await backend.listening()), { http: 4603, ws: 4604 });
});

test("reaping a server goes through the backend, because a host cannot see that pid", async () => {
    const backend = new FakeExecBackend();
    const proc = await backend.start(["node"], { PENPOT_MCP_SERVER_PORT: "4601" }, AbortSignal.timeout(1000));
    const h = host();

    await reap({ kind: "server", pid: proc.pid, port: 4601, detail: "node index.js" }, { backend, host: h });

    assert.deepEqual(backend.running, []);
    assert.deepEqual(h.killed, [], "a container pid must never be killed on the host");
});

test("reaping a browser kills it by pid on this host", async () => {
    const h = host();
    await reap({ kind: "browser", pid: 91204, detail: ACCOUNT.profileDir }, { host: h });

    assert.deepEqual(h.killed, [91204]);
});

test("a leftover renders as one line", () => {
    const server: Leftover = { kind: "server", pid: 348, port: 4601, detail: "node index.js" };
    const browser: Leftover = { kind: "browser", pid: 91204, detail: "profile-mcp-worker" };

    assert.equal(describe(server), ":4601  server  pid 348  node index.js");
    assert.equal(describe(browser), "browser  pid 91204  profile-mcp-worker");
});
