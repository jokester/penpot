import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import type { Deployment } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import { allocate } from "../core/ports.ts";
import { backendFor } from "./backend.ts";
import { ComposeBackend } from "./compose.ts";
import { execBackendContract, type ContractHarness } from "./contract.ts";
import { FakeExecBackend } from "./fake.ts";

const RANGE = { lo: 4601, hi: 4608 };

/** The live stack, driven only when explicitly asked for. */
const E2E = process.env.MCP_HEADLESS_E2E === "1";

// --- the fake ------------------------------------------------------------

execBackendContract("fake", async (): Promise<ContractHarness> => {
    const backend = new FakeExecBackend();
    return {
        backend,
        serverFor: (port) => ({
            argv: ["node", "index.js"],
            env: { PENPOT_MCP_SERVER_PORT: String(port), PENPOT_MCP_WEBSOCKET_PORT: String(port + 1) },
        }),
        freePort: async () => allocate(RANGE, await backend.listening()).http,
        deadPort: () => 4607,
        cleanup: async (pids) => {
            for (const pid of pids) await backend.kill(pid);
        },
    };
});

test("the fake reports ports a previous run left behind", async () => {
    const backend = new FakeExecBackend({ listening: [4601, 4602] });

    assert.deepEqual(await backend.listening(), [4601, 4602]);
    assert.deepEqual(allocate(RANGE, await backend.listening()), { http: 4603, ws: 4604 });
});

test("the fake counts exposures, so a leak is visible to a test", async () => {
    const backend = new FakeExecBackend({ listening: [4601] });
    const exposure = await backend.expose(4601, AbortSignal.timeout(1000));

    assert.equal(backend.openExposures, 1);
    await exposure.close();
    assert.equal(backend.openExposures, 0);
});

test("a killed process stops being running", async () => {
    const backend = new FakeExecBackend();
    const proc = await backend.start(["node"], { PENPOT_MCP_SERVER_PORT: "4601" }, AbortSignal.timeout(1000));

    assert.deepEqual(backend.running, [proc.pid]);
    await backend.kill(proc.pid);
    assert.deepEqual(backend.running, []);
});

// --- the factory ---------------------------------------------------------

test("an unimplemented backend is refused by name, not by a missing branch", async () => {
    const kubectl: Deployment = {
        backend: "kubectl",
        exposure: "none",
        portRange: RANGE,
        configDir: "/etc",
        kubectl: { namespace: "penpot", selector: "app=penpot-mcp" },
    };

    await assert.rejects(
        () => backendFor(kubectl),
        (err: unknown) => isLauncherError(err) && err.code === "not-configured" && err.detail.backend === "kubectl"
    );
});

test("a compose deployment with no compose block is refused", () => {
    const broken: Deployment = { backend: "compose", exposure: "none", portRange: RANGE, configDir: "/etc" };

    assert.throws(
        () => new ComposeBackend(broken),
        (err: unknown) => isLauncherError(err) && err.code === "not-configured"
    );
});

// --- the real thing, opt in ----------------------------------------------

const HOME_CLUSTER = resolve(import.meta.dirname, "../../../../../deploy/home-cluster");

const COMPOSE: Deployment = {
    backend: "compose",
    exposure: "none",
    portRange: RANGE,
    configDir: HOME_CLUSTER,
    compose: { projectDir: ".", service: "penpot-mcp" },
};

if (E2E) {
    execBackendContract("compose", async (): Promise<ContractHarness> => {
        const backend = new ComposeBackend(COMPOSE, { reachableTimeoutMs: 3_000 });

        return {
            backend,
            serverFor: (port) => ({
                argv: [
                    "node",
                    "-e",
                    "require('node:http').createServer((q, s) => s.end('ok'))" +
                        ".listen(Number(process.env.PENPOT_MCP_SERVER_PORT), '0.0.0.0')",
                ],
                env: { PENPOT_MCP_SERVER_PORT: String(port) },
            }),
            freePort: async () => allocate(RANGE, await backend.listening()).http,
            deadPort: () => 4608,
            cleanup: async (pids) => {
                // The container here is the operator's real one, so a failed
                // assertion must not leave a server behind.
                for (const pid of pids) await backend.kill(pid).catch(() => undefined);
            },
        };
    });

    test("compose: listening() sees the container's own server", async () => {
        const backend = new ComposeBackend(COMPOSE);
        const ports = await backend.listening();

        // The image's default multi-user server, HTTP on IPv4 and WebSocket on
        // IPv6 -- the pair that proves both /proc files were read.
        assert.ok(ports.includes(4401), `expected 4401 among ${ports.join(" ")}`);
        assert.ok(ports.includes(4402), `expected 4402 among ${ports.join(" ")}`);
    });

    test("compose: run reports a command's exit code", async () => {
        const backend = new ComposeBackend(COMPOSE);
        const signal = AbortSignal.timeout(15_000);

        assert.equal((await backend.run(["true"], signal)).code, 0);
        assert.notEqual((await backend.run(["sh", "-c", "exit 3"], signal)).code, 0);
    });
} else {
    test("compose contract is skipped without MCP_HEADLESS_E2E=1", { skip: true }, () => undefined);
}
