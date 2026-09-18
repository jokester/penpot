// Penpot MCP browser host (v0).
//
// Owns the browser the MCP plugin runs in, so the MCP server no longer depends
// on a user keeping a Penpot tab open. It launches a headless browser against a
// persistent profile (logged in once via spikes/login.js), points Penpot's
// bundled MCP plugin at the right MCP server, and holds the workspace page open.
//
// The MCP server itself is unmodified: the page dials it exactly as a user's
// tab would. See config.js for the two supported topologies.
//
//   Self-hosted Penpot (nothing to inject, no separate server to run):
//     PENPOT_ORIGIN=http://localhost:9001 \
//     PENPOT_FILE_URL='http://localhost:9001/#/workspace?file-id=...' node host.js
//
//   Penpot cloud, against a separately-run MCP server:
//     PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' node host.js
import { openContext, sessionCookie, isPluginSocket, describe, ORIGIN } from "./config.js";

const FILE_URL = process.env.PENPOT_FILE_URL;
const HEADLESS = process.env.PENPOT_HOST_HEADLESS !== "false";
const CONNECT_TIMEOUT_MS = 90_000;

if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to the workspace URL the agent should drive.");
    process.exit(2);
}

const log = (msg) => console.log(`[host] ${new Date().toISOString().slice(11, 19)} ${msg}`);

log(describe());

const ctx = await openContext({ headless: HEADLESS });

if (!(await sessionCookie(ctx))) {
    log(`no session cookie for ${ORIGIN} — run \`pnpm run login\` first`);
    await ctx.close();
    process.exit(1);
}

const page = await ctx.newPage();

/**
 * Resolves when the page opens the MCP WebSocket.
 *
 * This is the only trustworthy readiness signal: the URL stays on the workspace
 * even when unauthenticated, and API probes can be answered by an edge proxy.
 */
function waitForPluginConnection(timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        page.on("websocket", (ws) => {
            if (!isPluginSocket(ws.url())) return;
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
        log("  check: MCP enabled in Penpot settings; session still valid (pnpm run login);");
        log("  the MCP server is reachable; then run pnpm run diagnose");
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
