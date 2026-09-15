// Does the cookie-authenticated headless session get a WORKING notifications
// socket? PAT auth reaches the app's HTTP calls but not the WebSocket
// handshake, so this is the control case for "fully functional".
import { WebSocketServer } from "ws";
import { openContext, sessionCookie, WS_PORT } from "./context.js";

const FILE_URL = process.env.PENPOT_FILE_URL;
if (!FILE_URL) {
    console.error("Set PENPOT_FILE_URL to a workspace URL.");
    process.exit(2);
}

const seen = { mcp: false };
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", () => (seen.mcp = true));

const ctx = await openContext({ headless: true });
await ctx.addInitScript((port) => {
    window.penpotMcpServerURI = `ws://localhost:${port}`;
}, WS_PORT);

const page = await ctx.newPage();
const notif = { opened: 0, errors: [], closed: 0, framesIn: 0 };
page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws/notifications")) return;
    notif.opened++;
    ws.on("socketerror", (e) => notif.errors.push(String(e).slice(0, 90)));
    ws.on("close", () => notif.closed++);
    ws.on("framereceived", () => notif.framesIn++);
});

await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
const deadline = Date.now() + 60000;
while (!seen.mcp && Date.now() < deadline) await page.waitForTimeout(500);
await page.waitForTimeout(8000);

console.log(`cookie present:        ${(await sessionCookie(ctx)) ? "yes" : "no"}`);
console.log(`MCP plugin connected:  ${seen.mcp}`);
console.log(`notifications opened:  ${notif.opened}`);
console.log(`notifications errors:  ${notif.errors.length ? notif.errors.join(" | ") : "(none)"}`);
console.log(`notifications closed:  ${notif.closed}`);
// Zero inbound frames is normal on an idle file: the server pushes only when
// something happens elsewhere. Health is "stayed open without erroring", not
// "received traffic".
console.log(`frames received:       ${notif.framesIn} (0 is expected when nobody else is editing)`);
console.log(
    `\nverdict: ${
        notif.opened > 0 && notif.errors.length === 0 && notif.closed === 0
            ? "notifications socket is HEALTHY (open, no auth error, never dropped)"
            : "notifications socket is NOT healthy"
    }`
);

await ctx.close();
wss.close();
process.exit(0);
