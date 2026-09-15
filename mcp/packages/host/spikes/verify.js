// Spike 1 + Spike 2, headless, no interaction.
//   1. Does the stored session still authenticate after a headless relaunch?
//      (Checked at the API level — the SPA stays on the workspace URL even
//      when every request 401s, so the URL proves nothing.)
//   2. Does injecting window.penpotMcpServerURI make Penpot's bundled MCP
//      plugin dial our local WebSocket instead of Penpot's hosted server?
import { WebSocketServer } from "ws";
import { openContext, sessionCookie, WS_PORT } from "./context.js";

const FILE_URL = process.env.PENPOT_FILE_URL;
if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to a workspace URL, e.g.");
    console.error("  PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' node verify.js");
    process.exit(2);
}

const seen = { connected: false, userToken: null, firstMessage: null };
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (ws, req) => {
    seen.connected = true;
    seen.userToken = new URL(req.url, "ws://localhost").searchParams.get("userToken");
    ws.on("message", (d) => (seen.firstMessage ??= d.toString().slice(0, 200)));
});

const ctx = await openContext({ headless: true });
await ctx.addInitScript((port) => {
    window.penpotMcpServerURI = `ws://localhost:${port}`;
}, WS_PORT);

const cookie = await sessionCookie(ctx);
console.log(`stored session cookie: ${cookie ? "present" : "MISSING — run `node login.js` first"}`);

const page = await ctx.newPage();
await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);

// A connected plugin proves the session: the token it presents comes from an
// authenticated get-access-tokens call. See the note in context.js.
const deadline = Date.now() + 60000;
while (!seen.connected && Date.now() < deadline) await page.waitForTimeout(500);

console.log(`session works headless + plugin connected: ${seen.connected}`);
console.log(`userToken present: ${seen.userToken ? `yes (${seen.userToken.slice(0, 8)}…)` : "no"}`);
console.log(`first message: ${seen.firstMessage ?? "-"}`);
console.log(`override in page: ${await page.evaluate(() => window.penpotMcpServerURI ?? "(unset)")}`);

await ctx.close();
wss.close();
process.exit(seen.connected ? 0 : 1);
