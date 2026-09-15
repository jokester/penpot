// Shared browser setup for the spikes.
//
// Uses the installed Google Chrome rather than Playwright's headless shell:
// design.penpot.app sits behind Cloudflare bot protection, and the stock
// browser build is far less likely to be challenged. Login and headless runs
// must use the same channel, since they share one profile directory.
import { chromium } from "playwright";
import os from "os";
import path from "path";

export const ORIGIN = "https://design.penpot.app";
export const PROFILE =
    process.env.PENPOT_PROFILE_DIR ?? path.join(os.homedir(), ".cache", "penpot-headless", "profile");
export const WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? 4402);

export async function openContext({ headless }) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless,
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
    });
    // Without this, ws://localhost is refused with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS.
    await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN });
    return ctx;
}

/** Returns the session cookie, or undefined when not logged in. */
export async function sessionCookie(ctx) {
    const cookies = await ctx.cookies(ORIGIN);
    return cookies.find((c) => c.name === "auth-token");
}

// NOTE on checking authentication: do not probe the API from page context.
// A synthetic fetch to /api/rpc/command/* is answered by a Cloudflare
// challenge ("Just a moment...") even when the app's own traffic is fine, and
// the app's requests are not visible to page.on("response") either. The URL is
// no good as a signal either: the SPA stays on the workspace URL while failing.
//
// The reliable signal is the plugin WebSocket connecting with a userToken --
// the plugin only has that token after an authenticated get-access-tokens
// call. Use that as the readiness signal in the host, too.
