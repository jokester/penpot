// One interactive login into the persistent profile.
//
// Self-verifying: waits until the session cookie actually exists rather than
// trusting the window close, then shuts the context down cleanly so Chrome
// flushes the cookie jar to disk.
import { openContext, sessionCookie, PROFILE, ORIGIN } from "./context.js";

const ctx = await openContext({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(`${ORIGIN}/#/auth/login`, { waitUntil: "domcontentloaded" });

console.log(`profile: ${PROFILE}`);
console.log("Log in to Penpot. Leave the window open — it closes itself once the session is stored.");
console.log("While you are there, make sure MCP is enabled in Settings, then open your scratch file.");

const deadline = Date.now() + 10 * 60 * 1000;
let cookie;
while (!(cookie = await sessionCookie(ctx))) {
    if (Date.now() > deadline) {
        console.error("Timed out waiting for login (10 min).");
        await ctx.close();
        process.exit(1);
    }
    if (ctx.pages().length === 0) {
        console.error("Browser closed before a session cookie appeared — not logged in.");
        await ctx.close();
        process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
}

const expires =
    cookie.expires === -1 ? "session-only (will NOT survive restart)" : new Date(cookie.expires * 1000).toISOString();
console.log(`\nsession cookie stored: len=${String(cookie.value).length} expires=${expires}`);
console.log("Give it a few seconds to settle, then closing…");
await new Promise((r) => setTimeout(r, 5000));
await ctx.close();
console.log("Done. Session is on disk; `node verify.js` can now run headless.");
process.exit(0);
