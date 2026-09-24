// Spike 3: can a public https origin reach ws://localhost from Chromium, and under which launch flags?
// Origin under test: https://design.penpot.app (public, unauthenticated login page).
// Target: a local WebSocket listener on 4402 (and an http listener on 4400).
import { chromium, firefox } from "playwright";
import { WebSocketServer } from "ws";
import http from "http";

const WS_PORT = 4402;
const HTTP_PORT = 4400;
const ORIGIN = "https://design.penpot.app/";

const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (ws) => ws.send("hello"));

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true" });
    res.end("ok");
});
httpServer.listen(HTTP_PORT);

// Probe executed inside the page: attempt both a WebSocket and a plain fetch to localhost.
const probe = async ([wsPort, httpPort]) => {
    const wsResult = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        setTimeout(() => done("timeout"), 8000);
        try {
            const ws = new WebSocket(`ws://localhost:${wsPort}`);
            ws.onopen = () => done("open");
            ws.onerror = () => done("error");
            ws.onclose = (e) => done(`closed(${e.code})`);
        } catch (e) {
            done(`throw:${e.name}`);
        }
    });

    let fetchResult;
    try {
        const r = await fetch(`http://localhost:${httpPort}/`, { mode: "cors" });
        fetchResult = `ok(${r.status})`;
    } catch (e) {
        fetchResult = `fail:${e.message}`;
    }
    return { ws: wsResult, fetch: fetchResult };
};

const VARIANTS = [
    { name: "baseline (no flags)", args: [] },
    { name: "disable PrivateNetworkAccessChecks", args: ["--disable-features=PrivateNetworkAccessChecks"] },
    { name: "disable LocalNetworkAccessChecks", args: ["--disable-features=LocalNetworkAccessChecks"] },
    {
        name: "disable both + insecure-private-network",
        args: [
            "--disable-features=PrivateNetworkAccessChecks,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessPermissionPrompt",
        ],
    },
    { name: "baseline + grantPermissions", args: [], grant: true },
    { name: "--disable-web-security", args: ["--disable-web-security"] },
];

const results = [];

for (const variant of VARIANTS) {
    const browser = await chromium.launch({ headless: true, args: variant.args });
    const context = await browser.newContext();
    if (variant.grant) {
        try {
            await context.grantPermissions(["local-network-access"], { origin: "https://design.penpot.app" });
        } catch (e) {
            variant.grantError = e.message.split("\n")[0];
        }
    }
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
    });
    let outcome;
    try {
        await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
        outcome = await page.evaluate(probe, [WS_PORT, HTTP_PORT]);
    } catch (e) {
        outcome = { ws: `nav-failed:${e.message.split("\n")[0]}`, fetch: "-" };
    }
    results.push({
        engine: `chromium ${browser.version()}`,
        variant: variant.name,
        ...outcome,
        grantError: variant.grantError,
        consoleErrors: consoleErrors.slice(0, 2),
    });
    await browser.close();
}

// Firefox fallback: does not implement PNA at all.
try {
    const browser = await firefox.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
    const outcome = await page.evaluate(probe, [WS_PORT, HTTP_PORT]);
    results.push({ engine: `firefox ${browser.version()}`, variant: "baseline", ...outcome });
    await browser.close();
} catch (e) {
    results.push({ engine: "firefox", variant: "baseline", ws: `unavailable: ${e.message.split("\n")[0]}` });
}

console.log(JSON.stringify(results, null, 2));
wss.close();
httpServer.close();
process.exit(0);
