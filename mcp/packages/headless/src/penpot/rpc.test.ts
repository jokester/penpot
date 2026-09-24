import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseAccount } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import { penpotApi, type RpcFetch, type RpcResponse } from "./rpc.ts";

const ORIGIN = "http://localhost:9001";
const SESSION = { cookie: "auth-token=abc123" };

const TEAM = "fdbdf01d-1111-4222-8333-444455556666";
const FILE = "0a1b2c3d-4444-4555-8666-777788889999";

// Captured from the running instance on 2026-09-21. Penpot takes kebab-case
// parameters and answers in camelCase; the first version of these fixtures was
// written from the wrong guess, so every optional field read as absent and
// isDefault was always false -- and the tests passed, because they agreed with
// the code rather than with the server.
const TEAMS = JSON.stringify([
    { id: TEAM, name: "Default", isDefault: true, createdAt: "2026-01-01T00:00:00Z", permissions: {} },
    { id: "aaaaaaaa-1111-4222-8333-444455556666", name: "ihate-workspace", isDefault: false },
]);

const FILES = JSON.stringify([
    {
        id: FILE,
        name: "worker-scratch",
        modifiedAt: "2026-09-20T11:21:29.162784Z",
        createdAt: "2026-09-19T00:00:00Z",
        projectId: "a666c135-9926-812e-8008-a9e10b11d32a",
        teamId: TEAM,
        isShared: false,
        rowNum: 1,
    },
]);

const TOKENS = JSON.stringify([
    { id: "1", name: "CI", type: "access", perms: [] },
    { id: "2", name: "MCP", type: "mcp", token: "tok-abc123" },
]);

/** Records requests and answers from a script. */
function fakeFetch(answers: Record<string, { status?: number; body: string; setCookie?: string }>) {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];

    const doFetch: RpcFetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });

        const command = url.slice(url.lastIndexOf("/") + 1);
        const answer = answers[command] ?? { status: 404, body: '{"type":"not-found"}' };
        const status = answer.status ?? 200;

        const response: RpcResponse = {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (name.toLowerCase() === "set-cookie" ? (answer.setCookie ?? null) : null) },
            text: async () => answer.body,
        };
        return response;
    };
    return { doFetch, calls };
}

test("logging in returns the cookie the session carries by hand", async () => {
    // By hand because Node will not send a Secure cookie over loopback http,
    // however the jar is configured -- which 401s in a way that reads as an
    // auth bug.
    const f = fakeFetch({
        "login-with-password": {
            body: '{"id":"profile-1"}',
            setCookie: "auth-token=abc123; Path=/; HttpOnly; Secure; SameSite=Lax",
        },
    });

    const session = await penpotApi(f.doFetch).loginWithPassword(ORIGIN, "worker@example.test", "hunter2");

    assert.deepEqual(session, { cookie: "auth-token=abc123" });
    assert.equal(f.calls[0]?.url, "http://localhost:9001/api/rpc/command/login-with-password");
    assert.deepEqual(f.calls[0]?.body, { email: "worker@example.test", password: "hunter2" });
});

test("a login with no cookie in the reply is a failure", async () => {
    const f = fakeFetch({ "login-with-password": { body: '{"id":"profile-1"}' } });

    await assert.rejects(
        () => penpotApi(f.doFetch).loginWithPassword(ORIGIN, "a@b.test", "x"),
        (err: unknown) => isLauncherError(err) && err.message.includes("no auth-token cookie")
    );
});

test("a rejected login names the origin and the status", async () => {
    const f = fakeFetch({ "login-with-password": { status: 400, body: '{"code":"wrong-credentials"}' } });

    await assert.rejects(
        () => penpotApi(f.doFetch).loginWithPassword(ORIGIN, "a@b.test", "x"),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.ok(err.message.includes("HTTP 400"), err.message);
            assert.ok(err.message.includes("wrong-credentials"), err.message);
            assert.equal(err.detail.origin, ORIGIN);
            return true;
        }
    );
});

test("teams come back with the default one marked", async () => {
    // isDefault, not is-default. The kebab spelling read false for every team,
    // including the one actually named Default, which is how it went unnoticed.
    const f = fakeFetch({ "get-teams": { body: TEAMS } });
    const teams = await penpotApi(f.doFetch).teams(ORIGIN, SESSION);

    assert.deepEqual(teams, [
        { id: TEAM, name: "Default", isDefault: true },
        { id: "aaaaaaaa-1111-4222-8333-444455556666", name: "ihate-workspace", isDefault: false },
    ]);
    assert.ok(
        teams.some((team) => team.isDefault),
        "exactly the bug this replaces: no team ever came back as the default"
    );
    assert.equal(f.calls[0]?.headers.Cookie, SESSION.cookie);
});

test("recent files carry a team id and a modification time", async () => {
    const f = fakeFetch({ "get-team-recent-files": { body: FILES } });
    const files = await penpotApi(f.doFetch).recentFiles(ORIGIN, SESSION, TEAM);

    assert.deepEqual(files, [
        { id: FILE, name: "worker-scratch", teamId: TEAM, modifiedAt: "2026-09-20T11:21:29.162784Z" },
    ]);
    // Kebab going out, camel coming back.
    assert.deepEqual(f.calls[0]?.body, { "team-id": TEAM });
});

test("a file with no team id of its own falls back to the team that was asked about", async () => {
    const f = fakeFetch({ "get-team-recent-files": { body: '[{"id":"f","name":"n"}]' } });
    const files = await penpotApi(f.doFetch).recentFiles(ORIGIN, SESSION, TEAM);

    assert.equal(files[0]?.teamId, TEAM);
    assert.equal(files[0]?.modifiedAt, "");
});

test("the MCP token is read, and only from the mcp row", async () => {
    const f = fakeFetch({ "get-access-tokens": { body: TOKENS } });

    assert.equal(await penpotApi(f.doFetch).readMcpToken(ORIGIN, SESSION), "tok-abc123");
});

test("an account with no MCP token reads as null, not as an error", async () => {
    const f = fakeFetch({ "get-access-tokens": { body: '[{"id":"1","name":"CI","type":"access"}]' } });

    assert.equal(await penpotApi(f.doFetch).readMcpToken(ORIGIN, SESSION), null);
    assert.equal(
        await penpotApi(fakeFetch({ "get-access-tokens": { body: "[]" } }).doFetch).readMcpToken(ORIGIN, SESSION),
        null
    );
});

test("nothing here can create a token", async () => {
    // create-access-token with type "mcp" deletes the account's existing token
    // and breaks MCP in that user's real tab. The capability is left out so it
    // cannot be called by accident; provisioning does it knowingly, once.
    const f = fakeFetch({
        "login-with-password": { body: "{}", setCookie: "auth-token=abc123" },
        "get-teams": { body: TEAMS },
        "get-team-recent-files": { body: FILES },
        "get-access-tokens": { body: TOKENS },
    });
    const api = penpotApi(f.doFetch);

    assert.deepEqual(Object.keys(api).sort(), ["loginWithPassword", "readMcpToken", "recentFiles", "teams"]);

    // Drive everything it can do, and watch what it asks for.
    const session = await api.loginWithPassword(ORIGIN, "a@b.test", "x");
    await api.teams(ORIGIN, session);
    await api.recentFiles(ORIGIN, session, TEAM);
    await api.readMcpToken(ORIGIN, session);

    const commands = f.calls.map((call) => call.url.slice(call.url.lastIndexOf("/") + 1));
    assert.deepEqual(commands, ["login-with-password", "get-teams", "get-team-recent-files", "get-access-tokens"]);
    assert.ok(!commands.includes("create-access-token"));
});

test("an answer that is not a list is refused rather than read as empty", async () => {
    const f = fakeFetch({ "get-teams": { body: '{"error":"nope"}' } });

    await assert.rejects(
        () => penpotApi(f.doFetch).teams(ORIGIN, SESSION),
        (err: unknown) => isLauncherError(err) && err.code === "probe-failed"
    );
});

test("a row missing its id is refused rather than passed on", async () => {
    const f = fakeFetch({ "get-teams": { body: '[{"name":"nameless"}]' } });

    await assert.rejects(
        () => penpotApi(f.doFetch).teams(ORIGIN, SESSION),
        (err: unknown) => isLauncherError(err) && err.detail.field === "id"
    );
});

test("a trailing slash on the origin does not double up", async () => {
    const f = fakeFetch({ "get-teams": { body: "[]" } });
    await penpotApi(f.doFetch).teams("http://localhost:9001/", SESSION);

    assert.equal(f.calls[0]?.url, "http://localhost:9001/api/rpc/command/get-teams");
});

// --- the real instance, opt in -------------------------------------------

const WORKER_ENV = resolve(import.meta.dirname, "../../../../../deploy/home-cluster/worker/mcp-worker.env");
const E2E = process.env.MCP_HEADLESS_E2E === "1" && existsSync(WORKER_ENV);

if (!E2E) {
    test("live RPC is skipped without MCP_HEADLESS_E2E=1 and an account file", { skip: true }, () => undefined);
} else {
    test("the worker account can log in, list its teams and read its token", async () => {
        const account = parseAccount("mcp-worker", readFileSync(WORKER_ENV, "utf8"), process.env);
        assert.ok(account.email !== undefined && account.password !== undefined, "the account file needs credentials");

        const api = penpotApi();
        const session = await api.loginWithPassword(account.origin, account.email, account.password);
        const teams = await api.teams(account.origin, session);

        assert.ok(teams.length > 0, "the worker should belong to at least one team");

        const files = await api.recentFiles(account.origin, session, teams[0]!.id);
        assert.ok(Array.isArray(files));

        // Read only. Creating one would delete the token the worker uses.
        const token = await api.readMcpToken(account.origin, session);
        assert.ok(token === null || token.length > 20);
    });
}
