// Penpot MCP browser host (v0).
//
// Owns the browser the MCP plugin runs in, so the MCP server no longer depends
// on a user keeping a Penpot tab open. It launches a headless Chrome against a
// persistent profile (logged in once via spikes/login.js), points Penpot's
// bundled MCP plugin at the local MCP server by injecting penpotMcpServerURI
// before page load, and holds the workspace page open.
//
// The MCP server itself is unmodified: the page dials it exactly as a user's
// tab would.
//
//   PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' node host.js
import { chromium } from "playwright";
import os from "os";
import path from "path";

const ORIGIN = process.env.PENPOT_ORIGIN ?? "https://design.penpot.app";
const PROFILE = process.env.PENPOT_PROFILE_DIR ?? path.join(os.homedir(), ".cache", "penpot-headless", "profile");
const WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? 4402);
const FILE_URL = process.env.PENPOT_FILE_URL;
const HEADLESS = process.env.PENPOT_HOST_HEADLESS !== "false";
const CONNECT_TIMEOUT_MS = 90_000;

if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to the workspace URL the agent should drive.");
    process.exit(2);
}

const log = (msg) => console.log(`[host] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    channel: "chrome", // stock Chrome: Cloudflare challenges the headless shell
    viewport: { width: 1440, height: 900 },
});

// ws://localhost is a private-network request from a public https origin; without
// this grant Chromium refuses it with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS.
await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN });

// Read by app.config/mcp-ws-uri at app boot, so it must be set before any page script.
await ctx.addInitScript((port) => {
    window.penpotMcpServerURI = `ws://localhost:${port}`;
}, WS_PORT);

const page = await ctx.newPage();

/**
 * Resolves when the page opens the MCP WebSocket.
 *
 * This is the only trustworthy readiness signal: the URL stays on the workspace
 * even when unauthenticated, and API probes are answered by Cloudflare.
 */
function waitForPluginConnection(timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        page.on("websocket", (ws) => {
            if (!ws.url().includes(`:${WS_PORT}`)) return;
            clearTimeout(timer);
            ws.on("close", () => log("plugin WebSocket closed"));
            resolve(ws);
        });
    });
}

async function open() {
    const connected = waitForPluginConnection(CONNECT_TIMEOUT_MS);
    log(`opening ${FILE_URL.slice(0, 90)}`);
    await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ws = await connected;
    if (ws) {
        log(`plugin connected to ${ws.url()} — MCP server can now drive this file`);
    } else {
        log("plugin did NOT connect within timeout.");
        log("  check: MCP enabled in Penpot settings; session still valid (spikes/login.js);");
        log("  MCP server listening on " + WS_PORT + "; then run spikes/diagnose.js");
    }
    return Boolean(ws);
}

await open();

// Keep the page alive; a crashed or navigated-away page means no plugin.
page.on("close", () => log("page closed unexpectedly"));
page.on("crash", async () => {
    log("page crashed; reloading");
    await open().catch((e) => log(`reload failed: ${e.message}`));
});

const shutdown = async (signal) => {
    log(`${signal} — closing browser`);
    await ctx.close().catch(() => {});
    process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("host running; Ctrl-C to stop");
await new Promise(() => {});
