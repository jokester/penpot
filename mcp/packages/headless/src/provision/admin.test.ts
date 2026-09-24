import test from "node:test";
import assert from "node:assert/strict";

import { FakeExecBackend } from "../exec/fake.ts";
import { isLauncherError } from "../core/errors.ts";
import { workerAdmin } from "./admin.ts";

test("the password reaches manage.py on stdin and never on the argv", async () => {
    // Verified against the real container: with no tty, getpass warns and
    // falls back to reading a line from stdin. A -p flag would put the
    // password in the host's process list and the container's at once.
    const backend = new FakeExecBackend();

    await workerAdmin(backend).createProfile("worker a", "a@example.test", "hunter2");

    const run = backend.runs[0];
    assert.equal(run?.stdin, "hunter2\n");
    assert.ok(!run?.argv.includes("-p"), "manage.py was given a password flag");
    assert.ok(!run?.argv.some((arg) => arg.includes("hunter2")), `password on argv: ${run?.argv.join(" ")}`);
});

test("creating a profile runs in the admin container, not the MCP one", async () => {
    // manage.py lives in the backend image; the MCP image has no such thing.
    const backend = new FakeExecBackend();

    await workerAdmin(backend).createProfile("worker a", "a@example.test", "hunter2");

    assert.equal(backend.runs[0]?.container, "admin");
    assert.deepEqual(backend.runs[0]?.argv.slice(0, 3), ["python3", "manage.py", "create-profile"]);
});

test("an account that is already there is reported, not raised", async () => {
    // Re-running provisioning is the supported way to add a team or rewrite a
    // lost account file, so this is the common case rather than a failure.
    const backend = new FakeExecBackend({
        runs: () => ({ code: 1, stdout: "", stderr: "ERR: profile already exists" }),
    });

    assert.equal(await workerAdmin(backend).createProfile("worker a", "a@example.test", "pw"), "exists");
});

test("any other failure carries what manage.py said", async () => {
    const backend = new FakeExecBackend({
        runs: () => ({ code: 1, stdout: "", stderr: "ERR: connection refused to PREPL" }),
    });

    await assert.rejects(
        () => workerAdmin(backend).createProfile("worker a", "a@example.test", "pw"),
        (err: unknown) => isLauncherError(err) && /connection refused/.test(err.message)
    );
});

test("resetting a password updates rather than creates", async () => {
    const backend = new FakeExecBackend();

    await workerAdmin(backend).setPassword("a@example.test", "new-one");

    assert.deepEqual(backend.runs[0]?.argv, ["python3", "manage.py", "update-profile", "-e", "a@example.test"]);
    assert.equal(backend.runs[0]?.stdin, "new-one\n");
});
