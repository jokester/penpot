import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError } from "../core/errors.ts";
import type { RpcFetch, RpcResponse } from "../penpot/rpc.ts";
import { provisioningApi } from "./api.ts";

const ORIGIN = "http://localhost:9001";
const SESSION = { cookie: "auth-token=abc123" };
const TEAM = "fdbdf01d-1111-4222-8333-444455556666";

/** A token shaped the way Penpot's invitation links carry them. */
const INVITE_TOKEN = "eyJhbGciOiJIUzI1NiJ9xxxxxx.eyJ0ZWFtLWlkIjoiZmRiZGYwMWQifQyyyyyy";

function fakeFetch(answers: Record<string, { status?: number; body: string; setCookie?: string }>) {
    const calls: { command: string; body: Record<string, unknown> }[] = [];

    const doFetch: RpcFetch = async (url, init) => {
        const command = url.slice(url.lastIndexOf("/") + 1);
        calls.push({ command, body: JSON.parse(init.body) });

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

test("logging in reports the ids a fresh account is given", async () => {
    // The plain PenpotApi login answers with a session only; provisioning
    // needs the default team and project to write the account file and to put
    // the scratch document somewhere.
    const f = fakeFetch({
        "login-with-password": {
            body: JSON.stringify({ id: "p1", defaultTeamId: TEAM, defaultProjectId: "proj-1" }),
            setCookie: "auth-token=abc123; Path=/; Secure",
        },
    });

    const { session, profile } = await provisioningApi(f.doFetch).login(ORIGIN, "w@example.test", "pw");

    assert.deepEqual(session, SESSION);
    assert.equal(profile.defaultTeamId, TEAM);
    assert.equal(profile.defaultProjectId, "proj-1");
});

test("an invitation link is accepted by the token inside it", async () => {
    // What a person copies out of Penpot is a URL; the command wants the token
    // that is buried in it.
    const f = fakeFetch({ "verify-token": { body: JSON.stringify({ teamId: TEAM, role: "editor" }) } });

    const joined = await provisioningApi(f.doFetch).acceptInvitation(
        ORIGIN,
        SESSION,
        `${ORIGIN}/#/auth/verify-token?token=${INVITE_TOKEN}`
    );

    assert.deepEqual(joined, { joined: true, teamId: TEAM, role: "editor" });
    assert.deepEqual(f.calls[0]?.body, { token: INVITE_TOKEN });
});

test("a link with nothing token-shaped in it is refused before the request", async () => {
    const f = fakeFetch({});

    await assert.rejects(
        () => provisioningApi(f.doFetch).acceptInvitation(ORIGIN, SESSION, "https://example.test/nope"),
        (err: unknown) => isLauncherError(err) && err.code === "not-configured"
    );
    assert.equal(f.calls.length, 0);
});

test("an invitation already accepted is not a failure", async () => {
    // Re-running with the same invitations is how a second team gets added.
    const f = fakeFetch({ "verify-token": { status: 400, body: '{"type":"validation","code":"invalid-token"}' } });

    assert.deepEqual(await provisioningApi(f.doFetch).acceptInvitation(ORIGIN, SESSION, INVITE_TOKEN), {
        joined: false,
    });
});

test("an invitation that fails for any other reason still raises", async () => {
    const f = fakeFetch({ "verify-token": { status: 500, body: "boom" } });

    await assert.rejects(() => provisioningApi(f.doFetch).acceptInvitation(ORIGIN, SESSION, INVITE_TOKEN));
});

test("minting names the token type Penpot's plugin looks for", async () => {
    const f = fakeFetch({ "create-access-token": { body: JSON.stringify({ id: "t1", token: "tok-new" }) } });

    assert.equal(await provisioningApi(f.doFetch).createMcpToken(ORIGIN, SESSION), "tok-new");
    assert.deepEqual(f.calls[0]?.body, { name: "MCP", type: "mcp" });
});

test("the scratch document goes in the account's own project", async () => {
    // kebab-case going out. Penpot kebabs every incoming key, so camelCase
    // also works, but one spelling in one place is easier to trust.
    const f = fakeFetch({ "create-file": { body: JSON.stringify({ id: "file-1", name: "worker-scratch" }) } });

    assert.equal(await provisioningApi(f.doFetch).createFile(ORIGIN, SESSION, "proj-1", "worker-scratch"), "file-1");
    assert.deepEqual(f.calls[0]?.body, { name: "worker-scratch", "project-id": "proj-1" });
});

test("enabling MCP also clears the screens that would greet a browser", async () => {
    // A lane drives the workspace through a real browser, and an onboarding
    // dialog in front of it is a lane that never becomes ready.
    const f = fakeFetch({ "update-profile-props": { body: "" } });

    await provisioningApi(f.doFetch).enableMcp(ORIGIN, SESSION);

    const props = (f.calls[0]?.body as { props: Record<string, unknown> }).props;
    assert.equal(props.mcpEnabled, true);
    assert.equal(props.onboardingViewed, true);
});
