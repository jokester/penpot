// Attribution helper: when verify.js reports no WebSocket, this says why.
// Captures console output, auth status, the profile's mcp state, access tokens
// and any plugin iframes.
import { WebSocketServer } from "ws";
import { openContext, sessionCookie, WS_PORT } from "./context.js";

const FILE_URL = process.env.PENPOT_FILE_URL;
if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to a workspace URL.");
    process.exit(2);
}

const wss = new WebSocketServer({ port: WS_PORT });
let connected = false;
wss.on("connection", () => (connected = true));

const ctx = await openContext({ headless: true });
await ctx.addInitScript((port) => {
    window.penpotMcpServerURI = `ws://localhost:${port}`;
}, WS_PORT);

const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));

await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(25000);

// NOTE: these probes are Cloudflare-challenged; useful only as a rough signal.
const rpc = async (cmd) =>
    await page.evaluate(async (cmd) => {
        const r = await fetch(`/api/rpc/command/${cmd}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: "{}",
        });
        return `${r.status}: ${(await r.text()).slice(0, 700)}`;
    }, cmd);

console.log("=== cookie:", (await sessionCookie(ctx)) ? "present" : "MISSING");
console.log("=== connected to local ws:", connected);
console.log("\n=== get-profile (looking for mcp-enabled) ===\n", await rpc("get-profile"));
console.log("\n=== get-access-tokens (looking for type mcp) ===\n", await rpc("get-access-tokens"));
console.log(
    "\n=== iframes ===\n",
    (
        await page.evaluate(() =>
            Array.from(document.querySelectorAll("iframe")).map((f) => (f.src || "(no src)").slice(0, 110))
        )
    ).join("\n") || "(none)"
);
console.log("\n=== console (mcp/plugin lines) ===");
console.log(
    logs
        .filter((l) => /mcp|plugin|token/i.test(l))
        .slice(0, 25)
        .join("\n") || "(none)"
);
console.log(`\n--- ${logs.length} lines total; last 8 ---\n` + logs.slice(-8).join("\n"));

await ctx.close();
wss.close();
process.exit(0);
