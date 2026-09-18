// Put a session into the persistent profile, once.
//
// Interactive by default. When PENPOT_EMAIL and PENPOT_PASSWORD are set the
// login happens over the API instead and the cookie is planted directly, which
// is what you want against a self-hosted instance -- no window, no human. SSO
// and 2FA accounts still need the interactive path.
//
// Self-verifying either way: it waits until the session cookie actually exists
// rather than trusting the window close, then shuts the context down cleanly so
// the browser flushes the cookie jar to disk.
import { openContext, sessionCookie, PROFILE, ORIGIN, describe } from "./context.js";

const EMAIL = process.env.PENPOT_EMAIL;
const PASSWORD = process.env.PENPOT_PASSWORD;
const NON_INTERACTIVE = Boolean(EMAIL && PASSWORD);

console.log(describe());

const ctx = await openContext({ headless: NON_INTERACTIVE });

const fail = async (msg) => {
    console.error(msg);
    await ctx.close();
    process.exit(1);
};

if (NON_INTERACTIVE) {
    // The browser's own request context, so the Set-Cookie lands in the profile
    // cookie jar exactly as a real login would leave it.
    const res = await ctx.request.post(`${ORIGIN}/api/rpc/command/login-with-password`, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        data: { email: EMAIL, password: PASSWORD },
    });
    if (!res.ok()) await fail(`login failed: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    console.log(`logged in as ${EMAIL}`);
} else {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${ORIGIN}/#/auth/login`, { waitUntil: "domcontentloaded" });

    console.log(`profile: ${PROFILE}`);
    console.log("Log in to Penpot. Leave the window open — it closes itself once the session is stored.");
    console.log("While you are there, make sure MCP is enabled in Settings, then open your scratch file.");

    const deadline = Date.now() + 10 * 60 * 1000;
    while (!(await sessionCookie(ctx))) {
        if (Date.now() > deadline) await fail("Timed out waiting for login (10 min).");
        if (ctx.pages().length === 0) await fail("Browser closed before a session cookie appeared — not logged in.");
        await new Promise((r) => setTimeout(r, 2000));
    }
}

const cookie = await sessionCookie(ctx);
if (!cookie) await fail("No session cookie was stored.");

const expires =
    cookie.expires === -1 ? "session-only (will NOT survive restart)" : new Date(cookie.expires * 1000).toISOString();
console.log(`\nsession cookie stored: len=${String(cookie.value).length} expires=${expires}`);
console.log("Give it a few seconds to settle, then closing…");
await new Promise((r) => setTimeout(r, NON_INTERACTIVE ? 1000 : 5000));
await ctx.close();
console.log("Done. Session is on disk; `pnpm run verify` can now run headless.");
process.exit(0);
