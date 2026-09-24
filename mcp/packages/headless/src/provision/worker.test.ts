import test from "node:test";
import assert from "node:assert/strict";

import { parseAccount, type ConfigIo } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import type { WorkerAdmin } from "./admin.ts";
import type { Joined, ProvisioningApi } from "./api.ts";
import { provisionWorker, type WorkerDeps, type WorkerRequest } from "./worker.ts";

const ORIGIN = "http://penpot.example.test";
const TEAM = "fdbdf01d-1111-4222-8333-444455556666";
const PROJECT = "a666c135-9926-812e-8008-a9e10b11d32a";
const FILE = "0a1b2c3d-4444-4555-8666-777788889999";

const REQUEST: WorkerRequest = {
    email: "worker-a@penpot.local",
    origin: ORIGIN,
    account: "worker-a",
    fullName: "worker-a",
    invitations: [],
    resetPassword: false,
    mintToken: false,
    fileName: "worker-scratch",
};

/** Everything provisioning talks to, recording what it was asked. */
function harness(
    overrides: {
        profile?: "created" | "exists";
        files?: Record<string, string>;
        heldToken?: string | null;
        joins?: Joined[];
        env?: NodeJS.ProcessEnv;
    } = {}
) {
    const written = new Map<string, string>();
    const calls: string[] = [];
    const logins: { password: string }[] = [];
    const joins = [...(overrides.joins ?? [])];

    const admin: WorkerAdmin = {
        createProfile: async (_name, _email, password) => {
            calls.push(`createProfile ${password}`);
            return overrides.profile ?? "created";
        },
        setPassword: async (_email, password) => {
            calls.push(`setPassword ${password}`);
        },
    };

    const api: ProvisioningApi = {
        login: async (_origin, _email, password) => {
            logins.push({ password });
            calls.push("login");
            return {
                session: { cookie: "auth-token=abc" },
                profile: { id: "p1", defaultTeamId: TEAM, defaultProjectId: PROJECT },
            };
        },
        acceptInvitation: async () => {
            calls.push("acceptInvitation");
            return joins.shift() ?? { joined: true, teamId: TEAM, role: "editor" };
        },
        createMcpToken: async () => {
            calls.push("createMcpToken");
            return "tok-new";
        },
        enableMcp: async () => {
            calls.push("enableMcp");
        },
        createFile: async (_origin, _session, _projectId, name) => {
            calls.push(`createFile ${name}`);
            return FILE;
        },
    };

    const io: ConfigIo = {
        read: (path) => overrides.files?.[path] ?? null,
        list: () => [],
    };

    const deps: WorkerDeps = {
        admin,
        api,
        io,
        tokens: { readMcpToken: async () => overrides.heldToken ?? null },
        accountsDir: "/cfg/accounts",
        write: async (path, contents) => {
            written.set(path, contents);
        },
        log: () => undefined,
        newPassword: () => "generated-pw",
        env: overrides.env ?? {},
    };

    return { deps, written, calls, logins };
}

test("a fresh worker gets an account file the launcher can read back", async () => {
    const h = harness();

    const report = await provisionWorker(REQUEST, h.deps);

    assert.equal(report.path, "/cfg/accounts/worker-a.env");
    const account = parseAccount("worker-a", h.written.get(report.path) as string, { HOME: "/home/x" });
    assert.equal(account.origin, ORIGIN);
    assert.equal(account.email, "worker-a@penpot.local");
    assert.equal(account.password, "generated-pw");
    assert.equal(account.mcpToken, "tok-new");
    assert.deepEqual(account.defaultDocument, { teamId: TEAM, fileId: FILE });
    assert.equal(account.profileDir, "/home/x/.cache/penpot-headless/profile-worker-a");
});

test("a brand new profile mints a token without being asked twice", async () => {
    // Minting deletes the account's previous MCP token. An account created a
    // moment ago has none, so there is nothing to destroy and no flag to ask
    // for.
    const h = harness();

    const report = await provisionWorker(REQUEST, h.deps);

    assert.equal(report.token, "minted");
    assert.ok(h.calls.includes("createMcpToken"));
});

test("an existing account keeps its token unless minting is asked for", async () => {
    // The destructive case: create-access-token with type mcp deletes the
    // token in use, which has broken MCP in somebody's open Penpot tab.
    const h = harness({
        profile: "exists",
        heldToken: "tok-already-in-use",
        files: { "/cfg/accounts/worker-a.env": 'PENPOT_ORIGIN="x"\nPENPOT_PASSWORD="old-pw"\n' },
    });

    const report = await provisionWorker(REQUEST, h.deps);

    assert.equal(report.token, "reused");
    assert.ok(!h.calls.includes("createMcpToken"), "minted a token nobody asked to replace");
    assert.match(h.written.get(report.path) as string, /userToken=tok-already-in-use/);
});

test("--mint-token replaces a token that is already there", async () => {
    const h = harness({
        profile: "exists",
        heldToken: "tok-already-in-use",
        files: { "/cfg/accounts/worker-a.env": 'PENPOT_ORIGIN="x"\nPENPOT_PASSWORD="old-pw"\n' },
    });

    const report = await provisionWorker({ ...REQUEST, mintToken: true }, h.deps);

    assert.equal(report.token, "minted");
});

test("re-provisioning reuses the password in the account file", async () => {
    // Without this a re-run generates a password the profile does not have,
    // and the login that follows fails for a reason nobody would guess.
    const h = harness({
        profile: "exists",
        files: { "/cfg/accounts/worker-a.env": 'PENPOT_ORIGIN="x"\nPENPOT_PASSWORD="old-pw"\n' },
    });

    await provisionWorker(REQUEST, h.deps);

    assert.deepEqual(h.logins, [{ password: "old-pw" }]);
    assert.ok(!h.calls.some((call) => call.startsWith("setPassword")), "changed a password nobody asked about");
});

test("the environment beats the account file, so a known password can be given", async () => {
    const h = harness({
        profile: "exists",
        files: { "/cfg/accounts/worker-a.env": 'PENPOT_ORIGIN="x"\nPENPOT_PASSWORD="stale"\n' },
        env: { MCP_HEADLESS_WORKER_PASSWORD: "the-real-one" },
    });

    await provisionWorker(REQUEST, h.deps);

    assert.deepEqual(h.logins, [{ password: "the-real-one" }]);
});

test("an existing account with no password on hand is refused, not guessed at", async () => {
    const h = harness({ profile: "exists" });

    await assert.rejects(
        () => provisionWorker(REQUEST, h.deps),
        (err: unknown) =>
            isLauncherError(err) && /--reset-password/.test(err.message) && /WORKER_PASSWORD/.test(err.message)
    );
});

test("--reset-password sets the new one on the account that already exists", async () => {
    const h = harness({ profile: "exists" });

    await provisionWorker({ ...REQUEST, resetPassword: true }, h.deps);

    assert.ok(h.calls.includes("setPassword generated-pw"));
    assert.deepEqual(h.logins, [{ password: "generated-pw" }]);
});

test("an invitation already spent leaves the worker's memberships alone", async () => {
    // Adding a second team means re-running with both invitations, and the
    // first is long since accepted.
    const h = harness({ joins: [{ joined: false }, { joined: true, teamId: "t2", role: "editor" }] });

    const report = await provisionWorker({ ...REQUEST, invitations: ["link-one", "link-two"] }, h.deps);

    assert.deepEqual(report.teams, ["t2"]);
});

test("accepting an invitation is followed by a fresh login", async () => {
    // The cookie was minted before the memberships changed, so the claims in
    // it do not include the team just joined.
    const h = harness();

    await provisionWorker({ ...REQUEST, invitations: ["link-one"] }, h.deps);

    assert.deepEqual(h.calls, [
        "createProfile generated-pw",
        "login",
        "acceptInvitation",
        "login",
        "createMcpToken",
        "enableMcp",
        "createFile worker-scratch",
    ]);
});

test("no scratch document leaves the file id empty rather than absent", async () => {
    // parseAccount tolerates it: a workspace URL with an empty file-id is a
    // normal state for a worker that was never given one.
    const h = harness();

    const report = await provisionWorker({ ...REQUEST, fileName: "" }, h.deps);

    assert.equal(report.fileId, "");
    assert.ok(!h.calls.some((call) => call.startsWith("createFile")));
    assert.match(h.written.get(report.path) as string, /file-id="$/m);
});

test("MCP is switched on, because a worker's token is useless without it", async () => {
    const h = harness();

    await provisionWorker(REQUEST, h.deps);

    assert.ok(h.calls.includes("enableMcp"));
});

test("re-provisioning keeps the scratch document instead of making another", async () => {
    // Re-running is how a worker is added to a team, and doing that three
    // times should not leave three scratch files behind.
    const h = harness({
        profile: "exists",
        files: {
            "/cfg/accounts/worker-a.env":
                'PENPOT_ORIGIN="http://x"\nPENPOT_PASSWORD="old-pw"\n' +
                'PENPOT_FILE_URL="http://x/#/workspace?team-id=11111111-1111-4111-8111-111111111111' +
                '&file-id=22222222-2222-4222-8222-222222222222"\n',
        },
    });

    const report = await provisionWorker({ ...REQUEST, invitations: ["link"] }, h.deps);

    assert.equal(report.fileId, "22222222-2222-4222-8222-222222222222");
    assert.ok(!h.calls.some((call) => call.startsWith("createFile")), "made a second scratch document");
});

test("an account file with no document still gets one", async () => {
    // Provisioned once with --file-name '' and now wanted: the absence is not
    // a decision to remember forever.
    const h = harness({
        profile: "exists",
        files: { "/cfg/accounts/worker-a.env": 'PENPOT_ORIGIN="http://x"\nPENPOT_PASSWORD="old-pw"\n' },
    });

    const report = await provisionWorker(REQUEST, h.deps);

    assert.equal(report.fileId, FILE);
    assert.ok(h.calls.includes("createFile worker-scratch"));
});
