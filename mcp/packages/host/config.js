// Shared configuration for the host and the spikes.
//
// Two topologies are supported, and they differ in who runs the MCP server:
//
//   builtin  A self-hosted Penpot serves its own MCP server at <origin>/mcp/ws
//            (docker/images/docker-compose.yaml ships a penpot-mcp service and
//            nginx proxies it). Nothing is injected: app.config/mcp-ws-uri
//            already resolves there. Clients connect to <origin>/mcp/stream.
//
//   inject   The MCP server runs separately, so window.penpotMcpServerURI is
//            injected before page load to redirect Penpot's own bundled plugin
//            at it. Required against penpot cloud, and useful locally when the
//            point is to hack on the server itself.
//
// The default follows the origin: a loopback Penpot has its own MCP service.
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

export const ORIGIN = (process.env.PENPOT_ORIGIN ?? "https://design.penpot.app").replace(/\/$/, "");

export const IS_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(ORIGIN);

// Cloudflare fronts design.penpot.app and challenges Playwright's headless
// shell, so the cloud path needs stock Chrome. A self-hosted instance has no
// such gate, so the bundled Chromium is fine -- and does not require Chrome to
// be installed at all. Set PENPOT_BROWSER_CHANNEL="" to force the bundled build.
export const CHANNEL = process.env.PENPOT_BROWSER_CHANNEL ?? (IS_LOOPBACK ? "" : "chrome");

// One profile per origin: the session cookie is origin-scoped, and mixing a
// cloud and a local session in one profile directory only causes confusion.
export const PROFILE =
    process.env.PENPOT_PROFILE_DIR ??
    path.join(os.homedir(), ".cache", "penpot-headless", IS_LOOPBACK ? "profile-local" : "profile");

export const WS_PORT = Number(process.env.PENPOT_MCP_WEBSOCKET_PORT ?? 4402);

export const MCP_MODE = process.env.PENPOT_MCP_MODE ?? (IS_LOOPBACK ? "builtin" : "inject");

/** The URI the plugin should dial, or null when the app's own default is used. */
export const INJECT_WS_URI =
    MCP_MODE === "inject" ? (process.env.PENPOT_MCP_WS_URI ?? `ws://localhost:${WS_PORT}`) : null;

/**
 * True when `url` is the socket the MCP plugin uses, in either topology.
 *
 * The port comes from the injected URI rather than WS_PORT, because
 * PENPOT_MCP_WS_URI can name a different one -- which is exactly what running
 * several single-document servers side by side does. Getting this wrong
 * reports a healthy connection as a timeout.
 */
export function isPluginSocket(url) {
    if (!INJECT_WS_URI) return url.includes("/mcp/ws");
    let port = String(WS_PORT);
    try {
        port = new URL(INJECT_WS_URI).port || port;
    } catch {
        /* fall back to WS_PORT */
    }
    return url.includes(`:${port}`);
}

// Nobody can click a headless tab to wake it, so make sure Chromium never
// decides the page is backgrounded and throttles the plugin's heartbeat timer.
// Measured note: timers were NOT in fact throttled here -- a "plugin tab
// appears to be suspended" error means a version-skewed plugin that sends no
// heartbeat at all (see README). These stay as cheap insurance.
const NO_THROTTLE_ARGS = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
];

// Penpot serves its MCP plugin as a static asset, so the profile caches it. When
// the instance runs a mounted plugin build, a stale copy survives the remount
// and the symptom points elsewhere entirely: the old plugin sends no heartbeat,
// and the server blames a suspended tab. Dropping the HTTP cache at launch costs
// one cold load and removes the whole class of problem. Cookies are untouched --
// only the cache directories go.
const CLEAR_CACHE = process.env.PENPOT_CLEAR_CACHE ? process.env.PENPOT_CLEAR_CACHE !== "false" : IS_LOOPBACK;

function clearHttpCache() {
    for (const dir of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage"]) {
        fs.rmSync(path.join(PROFILE, "Default", dir), { recursive: true, force: true });
    }
}

// Extra Chromium flags, space separated. Playwright forces software WebGL
// (--use-angle=swiftshader-webgl), which Penpot's wasm renderer cannot use:
// export_shape then fails with `WASM Error (wasm-critical)` from
// _render_shape_pixels. Overriding the GL backend is the lever for that, e.g.
//   PENPOT_BROWSER_ARGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist"
// Reaching the real GPU additionally needs the invoking user in the `render`
// group that owns /dev/dri/renderD128; without it ANGLE lands on llvmpipe,
// which is still software.
const EXTRA_ARGS = (process.env.PENPOT_BROWSER_ARGS ?? "").split(/\s+/).filter(Boolean);

export async function openContext({ headless }) {
    if (CLEAR_CACHE) clearHttpCache();

    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless,
        ...(CHANNEL ? { channel: CHANNEL } : {}),
        args: [...NO_THROTTLE_ARGS, ...EXTRA_ARGS],
        viewport: { width: 1440, height: 900 },
    });

    // A ws://localhost dialled from a public https origin is a private-network
    // request, refused with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS without
    // this grant. Unnecessary when both ends are loopback, but harmless.
    if (INJECT_WS_URI) {
        await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN });
    }

    if (INJECT_WS_URI) {
        // Read by app.config/mcp-ws-uri at boot, so it must precede page script.
        await ctx.addInitScript((uri) => {
            window.penpotMcpServerURI = uri;
        }, INJECT_WS_URI);
    }

    return ctx;
}

/** Returns the session cookie, or undefined when not logged in. */
export async function sessionCookie(ctx) {
    const cookies = await ctx.cookies(ORIGIN);
    return cookies.find((c) => c.name === "auth-token");
}

export function describe() {
    return [
        `origin   ${ORIGIN}`,
        `browser  ${CHANNEL || "playwright chromium"}`,
        `profile  ${PROFILE}`,
        `mcp      ${MCP_MODE}${INJECT_WS_URI ? ` -> ${INJECT_WS_URI}` : ` (${ORIGIN}/mcp/ws)`}`,
    ].join("\n         ");
}
