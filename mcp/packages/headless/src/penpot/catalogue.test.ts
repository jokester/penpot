import test from "node:test";
import assert from "node:assert/strict";

import type { Account } from "../core/config.ts";
import { catalogue, describeChoice, documentRefOf } from "./catalogue.ts";
import type { FileSummary, PenpotApi, Session, Team } from "./rpc.ts";

const ACCOUNT: Account = {
    name: "mcp-worker",
    origin: "http://localhost:9001",
    profileDir: "/tmp/p",
    email: "worker@example.test",
    password: "hunter2",
};

const TEAM_A = "a666c135-9926-812e-8008-a9e10b11d329";
const TEAM_B = "fdbdf01d-1111-4222-8333-444455556666";

const SIGNAL = new AbortController().signal;

/** A PenpotApi that answers from a script and counts what it was asked. */
function fakeApi(over: Partial<PenpotApi> = {}) {
    const calls = { logins: 0, teams: 0, files: 0 };

    const api: PenpotApi = {
        async loginWithPassword(): Promise<Session> {
            calls.logins += 1;
            return { cookie: "auth-token=abc" };
        },
        async teams(): Promise<Team[]> {
            calls.teams += 1;
            return [
                { id: TEAM_A, name: "Default", isDefault: true },
                { id: TEAM_B, name: "ihate-workspace", isDefault: false },
            ];
        },
        async recentFiles(_origin, _session, teamId): Promise<FileSummary[]> {
            calls.files += 1;
            return teamId === TEAM_A
                ? [{ id: "f-scratch", name: "worker-scratch", teamId: TEAM_A, modifiedAt: "2026-09-18T00:00:00Z" }]
                : [
                      { id: "f-diagrams", name: "diagrams", teamId: TEAM_B, modifiedAt: "2026-09-20T00:00:00Z" },
                      {
                          id: "f-viewer",
                          name: "LLM session viewer",
                          teamId: TEAM_B,
                          modifiedAt: "2026-09-19T00:00:00Z",
                      },
                  ];
        },
        async readMcpToken(): Promise<string | null> {
            return null;
        },
        ...over,
    };
    return { api, calls };
}

test("documents come back named, with both ids", async () => {
    const { api } = fakeApi();
    const result = await catalogue(api).forAccount(ACCOUNT, SIGNAL);

    assert.equal(result.problem, null);
    assert.deepEqual(
        result.documents.map((d) => `${d.teamName}/${d.fileName}`),
        ["ihate-workspace/diagrams", "ihate-workspace/LLM session viewer", "Default/worker-scratch"]
    );
    assert.equal(result.documents[0]?.fileId, "f-diagrams");
    assert.equal(result.documents[0]?.teamId, TEAM_B);
});

test("the most recently touched document is first", async () => {
    // The one someone wants is nearly always the one they were last in.
    const { api } = fakeApi();
    const result = await catalogue(api).forAccount(ACCOUNT, SIGNAL);

    assert.deepEqual(
        result.documents.map((d) => d.modifiedAt),
        ["2026-09-20T00:00:00Z", "2026-09-19T00:00:00Z", "2026-09-18T00:00:00Z"]
    );
});

test("a document with no timestamp sorts last, not first", async () => {
    const { api } = fakeApi({
        async recentFiles() {
            return [
                { id: "a", name: "undated", teamId: TEAM_A, modifiedAt: "" },
                { id: "b", name: "dated", teamId: TEAM_A, modifiedAt: "2026-01-01T00:00:00Z" },
            ];
        },
    });
    const result = await catalogue(api).forAccount(ACCOUNT, SIGNAL);

    assert.equal(result.documents[0]?.fileName, "dated", "an undated file must not push the useful ones down");
});

test("one login per account, however often the list is opened", async () => {
    const { api, calls } = fakeApi();
    const cat = catalogue(api);

    await cat.forAccount(ACCOUNT, SIGNAL);
    await cat.forAccount(ACCOUNT, SIGNAL);
    await cat.forAccount(ACCOUNT, SIGNAL);

    assert.equal(calls.logins, 1);
    assert.equal(calls.teams, 1, "the answer is remembered, not re-fetched");
});

test("opening the picker twice at once asks once", async () => {
    const { api, calls } = fakeApi();
    const cat = catalogue(api);

    await Promise.all([cat.forAccount(ACCOUNT, SIGNAL), cat.forAccount(ACCOUNT, SIGNAL)]);

    assert.equal(calls.logins, 1);
});

test("what is already known can be read without asking", async () => {
    const { api } = fakeApi();
    const cat = catalogue(api);

    assert.equal(cat.cached(ACCOUNT.name), undefined);
    await cat.forAccount(ACCOUNT, SIGNAL);
    assert.equal(cat.cached(ACCOUNT.name)?.documents.length, 3);
});

test("forgetting an account makes the next call ask again", async () => {
    const { api, calls } = fakeApi();
    const cat = catalogue(api);

    await cat.forAccount(ACCOUNT, SIGNAL);
    cat.forget(ACCOUNT.name);
    await cat.forAccount(ACCOUNT, SIGNAL);

    assert.equal(calls.logins, 2);
});

test("a failure degrades to typing ids by hand, and says why", async () => {
    // A launcher that cannot reach Penpot must still open a lane.
    const { api } = fakeApi({
        async teams() {
            throw new Error("get-teams failed: HTTP 401");
        },
    });
    const result = await catalogue(api).forAccount(ACCOUNT, SIGNAL);

    assert.deepEqual(result.documents, []);
    assert.ok(result.problem?.includes("401"), result.problem ?? "no problem reported");
});

test("a failure is not remembered, because the network may come back", async () => {
    let broken = true;
    const { api, calls } = fakeApi({
        async teams() {
            if (broken) throw new Error("offline");
            return [{ id: TEAM_A, name: "Default", isDefault: true }];
        },
    });
    const cat = catalogue(api);

    assert.ok((await cat.forAccount(ACCOUNT, SIGNAL)).problem !== null);
    broken = false;
    const second = await cat.forAccount(ACCOUNT, SIGNAL);

    assert.equal(second.problem, null);
    assert.equal(calls.logins, 2, "a failed session is dropped, so the retry logs in again");
});

test("an account with no credentials says so rather than failing obscurely", async () => {
    const { api, calls } = fakeApi();
    const { password: _password, ...noPassword } = ACCOUNT;
    const result = await catalogue(api).forAccount(noPassword, SIGNAL);

    assert.deepEqual(result.documents, []);
    assert.ok(result.problem?.includes("no credentials"), result.problem ?? "");
    assert.equal(calls.logins, 0);
});

test("an account with no documents is a problem worth saying out loud", async () => {
    const { api } = fakeApi({
        async recentFiles() {
            return [];
        },
    });
    const result = await catalogue(api).forAccount(ACCOUNT, SIGNAL);

    assert.deepEqual(result.documents, []);
    assert.ok(result.problem?.includes("no documents"), result.problem ?? "");
});

test("a choice becomes the reference a lane is opened with", () => {
    const choice = {
        fileId: "f-diagrams",
        teamId: TEAM_B,
        fileName: "diagrams",
        teamName: "ihate-workspace",
        modifiedAt: "",
    };

    assert.deepEqual(documentRefOf(choice), {
        fileId: "f-diagrams",
        teamId: TEAM_B,
        name: "diagrams",
        teamName: "ihate-workspace",
    });
    assert.equal(describeChoice(choice), "ihate-workspace / diagrams");
});
