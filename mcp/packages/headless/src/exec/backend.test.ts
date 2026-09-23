import test from "node:test";
import assert from "node:assert/strict";

import type { Deployment } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import { allocate } from "../core/ports.ts";
import { backendFor } from "./backend.ts";
import { ComposeBackend } from "./compose.ts";
import { KubectlBackend } from "./kubectl.ts";
import { execBackendContract, type ContractHarness } from "./contract.ts";
import { FakeExecBackend } from "./fake.ts";

const RANGE = { lo: 4601, hi: 4608 };
const HOST = "127.0.0.1";

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
        freePort: async () => allocate(RANGE, await backend.listening()),
        upstreamOf: (port) => port,
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
    const exposure = await backend.expose({ http: 4601, ws: 4602 }, AbortSignal.timeout(1000));

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

const KUBECTL: Deployment = {
    backend: "kubectl",
    exposure: "none",
    host: HOST,
    portRange: RANGE,
    configDir: "/etc",
    kubectl: { namespace: "penpot", selector: "app=penpot-mcp" },
};

test("a kubectl deployment builds a kubectl backend", async () => {
    assert.equal((await backendFor(KUBECTL)).kind, "kubectl");
});

test("a compose deployment with no compose block is refused", () => {
    const broken: Deployment = {
        backend: "compose",
        exposure: "none",
        host: HOST,
        portRange: RANGE,
        configDir: "/etc",
    };

    assert.throws(
        () => new ComposeBackend(broken),
        (err: unknown) => isLauncherError(err) && err.code === "not-configured"
    );
});

test("a kubectl deployment with no kubectl block is refused", () => {
    const broken: Deployment = {
        backend: "kubectl",
        exposure: "none",
        host: HOST,
        portRange: RANGE,
        configDir: "/etc",
    };

    assert.throws(
        () => new KubectlBackend(broken),
        (err: unknown) => isLauncherError(err) && err.code === "not-configured"
    );
});

// --- the real thing, opt in ----------------------------------------------
//
// Against the cluster, never against compose: those containers belong to
// another service now. The namespace is ~/Homelab/home-cluster/ns-penpot, the
// MCP pod carries `app=penpot-mcp`, and 4601-4608 are hostPorts on the node's
// loopback -- so a launcher running ON the node needs exposure "none" and one
// running anywhere else needs "port-forward". Which of those is under test is
// the environment's choice, because only the second works from off-node.

// A local range that is deliberately NOT the pod's: 4601-4608 are taken on
// this host by an unrelated stack's docker-proxy, which accepts a connection
// and resets it. That is the case upstreamPortRange exists for, so the live
// run exercises the mapping rather than the identity.
const LOCAL_RANGE = { lo: 5601, hi: 5608 };

const NAMESPACE = process.env.MCP_HEADLESS_E2E_NAMESPACE ?? "penpot";
const KUBECONFIG = process.env.MCP_HEADLESS_E2E_KUBECONFIG;
const EXPOSURE = process.env.MCP_HEADLESS_E2E_EXPOSURE === "none" ? "none" : "port-forward";

const OFFSET = RANGE.lo - LOCAL_RANGE.lo;

const LIVE: Deployment = {
    backend: "kubectl",
    exposure: EXPOSURE,
    host: HOST,
    portRange: LOCAL_RANGE,
    upstreamPortRange: RANGE,
    configDir: "/etc",
    kubectl: {
        namespace: NAMESPACE,
        selector: "app=penpot-mcp",
        ...(KUBECONFIG === undefined ? {} : { kubeconfig: KUBECONFIG }),
    },
};

if (E2E) {
    execBackendContract("kubectl", async (): Promise<ContractHarness> => {
        const backend = new KubectlBackend(LIVE, { reachableTimeoutMs: 8_000 });

        return {
            backend,
            // Both ports, like a real lane: exposure forwards the pair and
            // waits for both to be listening before it does.
            serverFor: (local) => ({
                argv: [
                    "node",
                    "-e",
                    "const h = require('node:http');" +
                        "h.createServer((q, s) => s.end('ok')).listen(Number(process.env.PENPOT_MCP_SERVER_PORT), '0.0.0.0');" +
                        "h.createServer((q, s) => s.end('ok')).listen(Number(process.env.PENPOT_MCP_WEBSOCKET_PORT), '0.0.0.0');",
                ],
                // 0.0.0.0, not loopback: a lane on the pod's own loopback is
                // invisible to portmap and to port-forward alike.
                env: {
                    PENPOT_MCP_SERVER_PORT: String(local + OFFSET),
                    PENPOT_MCP_WEBSOCKET_PORT: String(local + OFFSET + 1),
                },
            }),
            // `listening` answers in the pod's port space; allocation happens
            // in the host's, so the busy list is translated down first.
            freePort: async () =>
                allocate(
                    LOCAL_RANGE,
                    (await backend.listening()).map((port) => port - OFFSET)
                ),
            upstreamOf: (port) => port + OFFSET,
            deadPort: () => LOCAL_RANGE.hi,
            cleanup: async (pids) => {
                // The pod here is the operator's real one, so a failed
                // assertion must not leave a server behind.
                for (const pid of pids) await backend.kill(pid).catch(() => undefined);
            },
        };
    });

    test("kubectl: listening() sees the pod's own server", async () => {
        const backend = new KubectlBackend(LIVE);
        const ports = await backend.listening();

        // The image's default multi-user server, HTTP on IPv4 and WebSocket on
        // IPv6 -- the pair that proves both /proc files were read.
        assert.ok(ports.includes(4401), `expected 4401 among ${ports.join(" ")}`);
        assert.ok(ports.includes(4402), `expected 4402 among ${ports.join(" ")}`);
    });

    test("kubectl: run reports a command's exit code", async () => {
        const backend = new KubectlBackend(LIVE);
        const signal = AbortSignal.timeout(20_000);

        assert.equal((await backend.run(["true"], signal)).code, 0);
        assert.notEqual((await backend.run(["sh", "-c", "exit 3"], signal)).code, 0);
    });

    test("kubectl: the admin container is a different pod from the MCP one", async () => {
        // The one thing role resolution has to get right: manage.py lives in
        // the backend image and the MCP image has no such thing.
        const backend = new KubectlBackend(LIVE);
        const signal = AbortSignal.timeout(30_000);

        const admin = await backend.run(["sh", "-c", "ls manage.py"], signal, { container: "admin" });
        assert.equal(admin.code, 0, `${admin.stdout}${admin.stderr}`);

        const mcp = await backend.run(["sh", "-c", "ls manage.py"], signal);
        assert.notEqual(mcp.code, 0, "the MCP pod should not have manage.py");
    });
} else {
    test("kubectl contract is skipped without MCP_HEADLESS_E2E=1", { skip: true }, () => undefined);
}
