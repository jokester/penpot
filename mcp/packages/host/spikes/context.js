// Browser setup for the spikes.
//
// Kept as a thin re-export so the spikes and the host cannot drift apart on
// origin, browser channel, profile directory or MCP topology. The reasoning
// behind each of those lives in ../config.js.
export {
    ORIGIN,
    PROFILE,
    WS_PORT,
    CHANNEL,
    MCP_MODE,
    INJECT_WS_URI,
    isPluginSocket,
    openContext,
    sessionCookie,
    describe,
} from "../config.js";

// NOTE on checking authentication: do not probe the API from page context.
// Against penpot cloud a synthetic fetch to /api/rpc/command/* is answered by a
// Cloudflare challenge ("Just a moment...") even when the app's own traffic is
// fine, and the app's requests are not visible to page.on("response") either.
// The URL is no good as a signal either: the SPA stays on the workspace URL
// while failing.
//
// The reliable signal is the plugin WebSocket connecting with a userToken --
// the plugin only has that token after an authenticated get-access-tokens
// call. Use that as the readiness signal in the host, too.
