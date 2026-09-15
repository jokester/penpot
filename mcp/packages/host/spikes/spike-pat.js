// Spike 4: can a personal access token replace the session cookie?
//
// The page cannot set an Authorization header itself, but Playwright can set it
// for the whole context. The backend accepts `Authorization: Token <pat>` (see
// wrap-auth in http/middleware.clj), so in principle no cookie is needed.
//
// Deliberately uses a FRESH profile directory, so nothing can fall back to the
// stored session cookie and give a false pass.
//
// Token is read from a file so it never passes through a shell history or a
// transcript:  ~/.cache/penpot-headless/token
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import fs from "fs";
import os from "os";
import path from "path";

const TOKEN_FILE = process.env.PENPOT_TOKEN_FILE ?? path.join(os.homedir(), ".cache", "penpot-headless", "token");
const FILE_URL = process.env.PENPOT_FILE_URL;
const ORIGIN = process.env.PENPOT_ORIGIN ?? "https://design.penpot.app";
const WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? 4402);
const PROFILE = path.join(os.tmpdir(), `penpot-pat-spike-${process.pid}`);

if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to a workspace URL.");
    process.exit(2);
}
if (!fs.existsSync(TOKEN_FILE)) {
    console.error(`No token at ${TOKEN_FILE}.`);
    console.error("Create a personal access token in Penpot (Settings -> Access tokens) and write it there:");
    console.error(`  mkdir -p $(dirname ${TOKEN_FILE}) && pbpaste > ${TOKEN_FILE}   # or your editor`);
    process.exit(2);
}
const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();

const seen = { mcp: false, userToken: null };
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (ws, req) => {
    seen.mcp = true;
    seen.userToken = new URL(req.url, "ws://localhost").searchParams.get("userToken");
});

// Fresh profile: no cookie can leak into this test.
const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
});
await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN });
await ctx.setExtraHTTPHeaders({ Authorization: `Token ${token}` });
await ctx.addInitScript((port) => {
    window.penpotMcpServerURI = `ws://localhost:${port}`;
}, WS_PORT);

const page = await ctx.newPage();
const sockets = [];
page.on("websocket", (ws) => {
    sockets.push(ws.url().slice(0, 70));
    ws.on("socketerror", (e) => sockets.push(`  ^ socketerror: ${String(e).slice(0, 80)}`));
    ws.on("close", () => sockets.push(`  ^ closed: ${ws.url().slice(0, 50)}`));
});

await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
const deadline = Date.now() + 60000;
while (!seen.mcp && Date.now() < deadline) await page.waitForTimeout(500);
await page.waitForTimeout(3000);

const cookies = await ctx.cookies(ORIGIN);
const loggedOut = page.url().includes("/auth/login");

console.log(`profile (fresh):        ${PROFILE}`);
console.log(`cookies present:        ${cookies.map((c) => c.name).join(", ") || "(none)"}`);
console.log(`redirected to login:    ${loggedOut}`);
console.log(
    `MCP plugin connected:   ${seen.mcp}${seen.userToken ? ` (userToken ${seen.userToken.slice(0, 8)}…)` : ""}`
);
console.log(`websockets opened:\n  ${sockets.join("\n  ") || "(none)"}`);
console.log(
    `\nverdict: ${
        seen.mcp
            ? "PAT auth WORKS for the app; check the notifications socket above to confirm it is not degraded"
            : loggedOut
              ? "PAT auth REJECTED — app redirected to login"
              : "PAT auth inconclusive — app loaded but plugin never started (MCP enabled on this account?)"
    }`
);

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
wss.close();
process.exit(0);
