import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import type { ConfigIo } from "./core/config.ts";
import { FakeExecBackend } from "./exec/fake.ts";
import { main, type Io } from "./main.ts";

const ENV: NodeJS.ProcessEnv = { HOME: "/home/worker" };

/** Collects what was written, so a test can read the output. */
function capture() {
    const chunks: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, done) {
            chunks.push(String(chunk));
            done();
        },
    });
    return {
        stream,
        get text() {
            return chunks.join("");
        },
    };
}

/** Configuration from a map, so nothing touches the real filesystem. */
function configIo(files: Record<string, string>): ConfigIo {
    return {
        read: (path) => files[path] ?? null,
        list: (dir) =>
            Object.keys(files)
                .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
                .map((p) => p.slice(dir.length + 1)),
    };
}

const CONFIG = "/etc/headless";

const FILES = {
    [`${CONFIG}/accounts/mcp-worker.env`]: 'PENPOT_ORIGIN="http://localhost:9001"',
};

function run(argv: string[], over: Partial<Io> = {}, files: Record<string, string> = FILES) {
    const out = capture();
    const err = capture();
    const io: Io = { out: out.stream, err: err.stream, config: configIo(files), backend: null, ...over };

    return { out, err, code: main(["--config", CONFIG, ...argv], ENV, io) };
}

test("help prints the usage and succeeds", async () => {
    const r = run(["--help"]);

    assert.equal(await r.code, 0);
    assert.ok(r.out.text.includes("mcp-headless --no-tui"));
    assert.ok(r.out.text.includes("--team-id"));
    assert.equal(r.err.text, "");
});

test("a bad argument is a usage error, not a crash", async () => {
    const r = run(["--detach"]);

    assert.equal(await r.code, 2);
    assert.ok(r.err.text.includes("unknown argument --detach"), r.err.text);
    assert.equal(r.out.text, "");
});

test("a lane missing an id is refused before anything starts", async () => {
    const r = run(["--no-tui", "--account", "mcp-worker", "--file-id", "abc"]);

    assert.equal(await r.code, 2);
    assert.ok(r.err.text.includes("needs --team-id"), r.err.text);
});

test("--check says so when there is nothing to report", async () => {
    const r = run(["--check"], { backend: new FakeExecBackend() });

    assert.equal(await r.code, 0);
    assert.equal(r.out.text, "no leftovers\n");
});

test("--check returns non-zero when it finds wreckage", async () => {
    // Non-zero so a shell script or a unit notices without parsing the text.
    const backend = new FakeExecBackend({
        runs: () => ({ code: 0, stdout: "348 4601 node index.js\n402 4603 node index.js\n", stderr: "" }),
    });
    const r = run(["--check"], { backend });

    assert.equal(await r.code, 1);
    assert.ok(r.out.text.includes("2 leftovers from a previous run"), r.out.text);
    assert.ok(r.out.text.includes(":4601"), r.out.text);
    assert.ok(r.out.text.includes("pid 348"), r.out.text);
});

test("--no-tui with no lanes and no endpoint has nothing to do", async () => {
    // With the endpoint open this is the ordinary way to run: an agent asks
    // for documents through it, so there is nothing to name up front. Without
    // it there genuinely is nothing.
    const r = run(["--no-tui", "--no-serve"], { backend: new FakeExecBackend() });

    assert.equal(await r.code, 2);
    assert.ok(r.err.text.includes("needs the MCP endpoint"), r.err.text);
});

test("a lane naming an account that does not exist lists the ones that do", async () => {
    const r = run(
        ["--no-tui", "--account", "ghost", "--file-id", "0a1b2c3d-4444-4555-8666-777788889999", "--team-id", "t"],
        { backend: new FakeExecBackend() }
    );

    assert.equal(await r.code, 1);
    assert.ok(r.err.text.includes("no account named ghost"), r.err.text);
    assert.ok(r.err.text.includes("mcp-worker"), r.err.text);
});

test("main never calls process.exit", async () => {
    // The tooling being replaced exited from inside a branch and skipped its
    // own cleanup, orphaning a server in the container. The process ends in
    // bin/, once, after main resolves.
    const original = process.exit;
    let called = false;
    (process as unknown as { exit: unknown }).exit = (() => {
        called = true;
    }) as typeof process.exit;

    try {
        await run(["--help"]).code;
        await run(["--detach"]).code;
        await run(["--check"], { backend: new FakeExecBackend() }).code;
    } finally {
        (process as unknown as { exit: unknown }).exit = original;
    }

    assert.equal(called, false);
});

test("a configuration directory with nothing in it still runs --check", async () => {
    const r = run(["--check"], { backend: new FakeExecBackend() }, {});

    assert.equal(await r.code, 0);
});

/** `main` without the --config the other tests prepend, so argv[0] is ours. */
function runRaw(argv: string[], over: Partial<Io> = {}, files: Record<string, string> = FILES) {
    const out = capture();
    const err = capture();
    const io: Io = { out: out.stream, err: err.stream, config: configIo(files), backend: null, ...over };
    return { out, err, code: main(argv, ENV, io) };
}

const DEPLOYMENT = {
    [`${CONFIG}/deployment.json`]: JSON.stringify({
        backend: "compose",
        projectDir: ".",
        service: "penpot-mcp",
        portRange: [4601, 4608],
    }),
};

test("provisioning without a deployment says so instead of half-running", async () => {
    // There is no RPC command that creates a profile, so with no container to
    // reach there is nothing this command can do at all.
    const r = runRaw(["provision-worker-user", "--config", CONFIG, "--email", "w@x.test"], {}, FILES);

    assert.equal(await r.code, 1);
    assert.ok(r.err.text.includes("provisioning needs a deployment"), r.err.text);
});

test("provisioning writes the account file under the configured accounts dir", async (t) => {
    // Driven end to end through main, with only the container and the
    // filesystem faked: everything between is the code that runs for real.
    const written = new Map<string, string>();
    const backend = new FakeExecBackend();
    const fetches: string[] = [];

    const realFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = realFetch;
    });
    globalThis.fetch = (async (url: string | URL, init: { body: string }) => {
        const command = String(url).slice(String(url).lastIndexOf("/") + 1);
        fetches.push(command);
        const bodies: Record<string, unknown> = {
            "login-with-password": { id: "p1", defaultTeamId: "team-1", defaultProjectId: "proj-1" },
            "get-access-tokens": [],
            "create-access-token": { token: "tok-new" },
            "update-profile-props": {},
            "create-file": { id: "file-1" },
        };
        void init;
        return {
            ok: true,
            status: 200,
            headers: { get: () => (command === "login-with-password" ? "auth-token=abc; Secure" : null) },
            text: async () => JSON.stringify(bodies[command] ?? {}),
        };
    }) as unknown as typeof fetch;

    const r = runRaw(
        ["provision-worker-user", "--config", CONFIG, "--email", "worker-b@penpot.local"],
        {
            backend,
            write: async (path, contents) => {
                written.set(path, contents);
            },
        },
        { ...FILES, ...DEPLOYMENT }
    );

    assert.equal(await r.code, 0);
    const file = written.get(`${CONFIG}/accounts/worker-b.env`);
    assert.ok(file !== undefined, `wrote ${[...written.keys()].join(", ")}`);
    assert.match(file, /PENPOT_EMAIL="worker-b@penpot.local"/);
    assert.match(file, /userToken=tok-new/);
    // The profile was created in the admin container, not the MCP one.
    assert.equal(backend.runs[0]?.container, "admin");
});
