import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError } from "./errors.ts";
import type { PortPair } from "./ports.ts";
import type { AccountRef } from "./target.ts";
import { isPluginSocket, wire, type Mode } from "./topology.ts";

const SELF: AccountRef = {
    name: "mcp-worker",
    origin: "http://localhost:9001",
    profileDir: "/tmp/profile-mcp-worker",
};

const CLOUD: AccountRef = { ...SELF, origin: "https://design.penpot.app" };

const PORTS: PortPair = { http: 4603, ws: 4604 };

/** The modes that run a server of their own. */
const SERVER_MODES: Mode[] = ["exec", "local", "image"];

test("builtin uses the instance's own server and the account's token", () => {
    const w = wire("builtin", CLOUD, null, "tok-123");

    assert.equal(w.injectWsUri, null);
    assert.equal(w.clientUrl, "https://design.penpot.app/mcp/stream?userToken=tok-123");
    assert.equal(w.needsServer, false);
    assert.equal(w.needsUserToken, true);
    assert.deepEqual(w.serverEnv, {});
});

test("builtin without a token is refused rather than half-addressed", () => {
    for (const token of [undefined, ""]) {
        assert.throws(
            () => wire("builtin", CLOUD, null, token),
            (err: unknown) => {
                assert.ok(isLauncherError(err));
                assert.equal(err.code, "not-configured");
                assert.equal(err.detail.account, "mcp-worker");
                return true;
            }
        );
    }
});

test("a token with URL-significant characters survives", () => {
    assert.ok(wire("builtin", CLOUD, null, "a b&c=d").clientUrl.endsWith("userToken=a%20b%26c%3Dd"));
});

test("every server mode injects the port it is actually on", () => {
    for (const mode of SERVER_MODES) {
        const w = wire(mode, SELF, PORTS);

        assert.equal(w.injectWsUri, "ws://localhost:4604", mode);
        assert.equal(w.clientUrl, "http://127.0.0.1:4603/mcp", mode);
        assert.equal(w.needsServer, true, mode);
        assert.equal(w.needsUserToken, false, mode);
    }
});

test("only builtin contends for the account's one plugin slot", () => {
    const needs = (m: Mode) => wire(m, SELF, PORTS, "tok").needsUserToken;

    assert.deepEqual([needs("builtin"), needs("exec"), needs("local"), needs("image")], [true, false, false, false]);
});

test("a server mode without ports is refused", () => {
    for (const mode of SERVER_MODES) {
        assert.throws(
            () => wire(mode, SELF, null),
            (err: unknown) => isLauncherError(err) && err.code === "not-configured"
        );
    }
});

test("the worker is pointed at localhost, never a LAN address", () => {
    // Invariant 7: hardened session cookies are Secure, and only a trustworthy
    // origin keeps them. A lane addressed by IP loses its session while the
    // login appears to have worked.
    const w = wire("exec", { ...SELF, origin: "http://192.168.100.200:9001" }, PORTS);

    assert.ok(w.injectWsUri?.includes("localhost"));
    assert.ok(w.clientUrl.includes("127.0.0.1"));
});

test("the REPL is aimed at a port that is already bound", () => {
    // Invariant 9. The 2.17 bundle builds its ReplServer unconditionally and
    // offers no switch, so the only way to suppress it is to make its listen
    // fail. The server's own HTTP port is bound first.
    const env = wire("exec", SELF, PORTS).serverEnv;

    assert.deepEqual(env, {
        PENPOT_MCP_SERVER_PORT: "4603",
        PENPOT_MCP_WEBSOCKET_PORT: "4604",
        PENPOT_MCP_REPL_PORT: "4603",
    });
    assert.equal(env.PENPOT_MCP_REPL_PORT, env.PENPOT_MCP_SERVER_PORT);
});

test("the readiness check matches the injected port, not the default", () => {
    // The failure this prevents: isPluginSocket matched the default 4402 while
    // 4604 had been injected, so a connected lane reported as a timeout.
    const w = wire("exec", SELF, PORTS);

    assert.ok(isPluginSocket("ws://localhost:4604/?token=abc", w));
    assert.ok(!isPluginSocket("ws://localhost:4402/", w));
    assert.ok(!isPluginSocket("ws://localhost:4602/", w));
});

test("the readiness check ignores Penpot's other sockets", () => {
    const w = wire("exec", SELF, PORTS);

    // The notifications socket rides the app's own origin and port.
    assert.ok(!isPluginSocket("ws://localhost:9001/ws/notifications?session-id=1", w));
});

test("builtin recognises the instance's own socket by path", () => {
    const w = wire("builtin", CLOUD, null, "tok");

    assert.ok(isPluginSocket("wss://design.penpot.app/mcp/ws?userToken=tok", w));
    assert.ok(!isPluginSocket("wss://design.penpot.app/ws/notifications", w));
    assert.ok(!isPluginSocket("ws://localhost:4604/", w));
});

test("an unparseable socket URL is not a match rather than a crash", () => {
    assert.equal(isPluginSocket("not a url", wire("exec", SELF, PORTS)), false);
    assert.equal(isPluginSocket("not a url", wire("builtin", CLOUD, null, "tok")), false);
});

test("a trailing slash on the origin does not double up", () => {
    assert.equal(
        wire("builtin", { ...CLOUD, origin: "https://design.penpot.app/" }, null, "tok").clientUrl,
        "https://design.penpot.app/mcp/stream?userToken=tok"
    );
});
