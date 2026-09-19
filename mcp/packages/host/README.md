# Penpot MCP browser host (experimental)

Runs the Penpot MCP plugin in a **server-owned headless browser** instead of a
user's tab, so the MCP server no longer depends on someone keeping Penpot open,
focused and unfrozen.

Nothing in Penpot is modified. The page loads stock Penpot, and Penpot's own
bundled MCP plugin connects to the MCP server exactly as it would from a real
tab. The MCP server is unmodified too: it cannot tell the difference.

Two topologies are supported, and `config.js` picks between them by origin:

| | **builtin** (self-hosted) | **inject** (cloud) |
| --- | --- | --- |
| who runs the MCP server | the instance, at `<origin>/mcp/ws` | you, separately |
| injection | none — `app.config/mcp-ws-uri` already points there | `window.penpotMcpServerURI` before boot |
| browser | Playwright's bundled Chromium | stock Chrome (Cloudflare) |
| client endpoint | `<origin>/mcp/stream?userToken=…` | `http://localhost:4401/mcp` |

A loopback `PENPOT_ORIGIN` selects **builtin**, because the stock self-hosting
compose (`docker/images/docker-compose.yaml`) ships a `penpot-mcp` service and
nginx proxies it at the app's own origin. Override with `PENPOT_MCP_MODE`.

## Status

v0: a single browser page on a single file, driven by one MCP server. Proven
end to end against `design.penpot.app` (Penpot 2.18.0-RC5, MCP server 2.17.0).
See `spikes/README.md` for the evidence behind each design decision.

## Prerequisites

- **Against cloud only:** Google Chrome installed (`channel: "chrome"`;
  Playwright's headless shell gets challenged by Cloudflare). A self-hosted
  instance has no such gate and uses the bundled Chromium.
- MCP enabled in the Penpot account's settings. Without it the bundled plugin
  never starts and no WebSocket is attempted.
- A logged-in profile: `pnpm run login` (once; the session lasts 7 days).
  Set `PENPOT_EMAIL` and `PENPOT_PASSWORD` to skip the interactive window —
  practical for a local instance, not for SSO or 2FA accounts.

## Authentication: why a cookie, and what that costs

The host authenticates with a **Penpot session cookie**, held in the browser
profile. A personal access token cannot be substituted, and this is a hard
constraint rather than a preference:

- Token auth (`Authorization: Token ...`) works for every HTTP path — the app
  boots, authenticates and starts the MCP plugin with no cookie present.
- It does **not** authenticate `wss://.../ws/notifications`, which fails with
  `HTTP Authentication failed` and reconnect-loops. Browsers do not send custom
  headers on a WebSocket upgrade, and nothing outside the browser can add them
  to a TLS-encrypted handshake.
- That socket delivers other sessions' edits. Without it the page's view of the
  file silently goes stale while the agent keeps writing to it.

See `spikes/spike-pat.js` for the measurement and `spikes/README.md` for the
full reasoning, including the upstream change that would allow token auth.

Consequences to plan around:

- **A live credential sits on disk.** The profile directory holds a session
  cookie; treat it as you would a password file.
- **Re-login is periodic, not never.** Sessions are 7 days rolling and 30 days
  absolute, but they renew on use, so a host that runs at least weekly only
  needs a fresh login monthly.
- **SSO and 2FA accounts need a human** for that login. Password accounts can
  be automated by driving the login form headlessly, which is not implemented
  here yet.

## Usage

    pnpm install
    pnpm run login                     # once, interactive

    # terminal 1: the stock MCP server
    node ../server/dist/index.js

    # terminal 2: the host
    PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' pnpm start

    # terminal 3: drive it as an MCP client
    pnpm run smoke

Point any MCP client at `http://localhost:4401/mcp`.

Against a self-hosted instance there is no server to start and nothing to
inject, so it is two steps, not three:

    PENPOT_ORIGIN=http://localhost:9001 \
    PENPOT_EMAIL=you@example.com PENPOT_PASSWORD=... pnpm run login

    PENPOT_ORIGIN=http://localhost:9001 \
    PENPOT_FILE_URL='http://localhost:9001/#/workspace?team-id=...&file-id=...' pnpm start

The client endpoint is then `http://localhost:9001/mcp/stream?userToken=...`,
exactly the string Penpot shows under Settings > Integrations.

**The workspace URL needs `team-id` as well as `file-id`.** With only a file-id
the page loads, authenticates and opens its websockets, but `team-container*`
renders nothing and the plugin never starts — a blank page with a clean
console.

## Watching it work

`host.js` runs the browser and nothing else. To run it together with an MCP
server in the foreground — the shape you want when observing rather than
deploying — use `deploy/home-cluster/run-mcp-worker`, which wraps both and
stops both on Ctrl-C:

    ./run-mcp-worker --env-file worker/worker.env --mcp builtin --headed
    ./run-mcp-worker --env-file worker/worker.env --mcp local --host 0.0.0.0 --port 4501

`--mcp builtin` starts no server and lets the plugin use the one the instance
already serves. `--mcp local` starts the build in `../server/dist` and injects
its address, which is the mode to use when hacking on the server itself;
`--host`, `--port` and `--ws-port` only mean anything there.

It starts the server from the directory holding `index.js`, because
`ConfigurationLoader` resolves `data/` against `process.cwd()`. It also checks
the plugin the instance serves against the server build and warns when they are
skewed, since that mismatch reports itself as a suspended browser tab.

`--headed` needs a DISPLAY you are authorised on, so run it from inside the VNC
session or export that session's `DISPLAY` **and** `XAUTHORITY`. When the cookie
does not match, Playwright reports only "Target page, context or browser has
been closed" with empty browser logs; the real message is on the browser's
stderr, `Authorization required, but no authorization protocol specified`.

## Configuration

| Variable                    | Description                         | Default                            |
| --------------------------- | ----------------------------------- | ---------------------------------- |
| `PENPOT_FILE_URL`           | Workspace URL to open (required)    | —                                  |
| `PENPOT_ORIGIN`             | Penpot origin                       | `https://design.penpot.app`        |
| `PENPOT_PROFILE_DIR`        | Browser profile holding the session | `~/.cache/penpot-headless/profile`, or `profile-local` for a loopback origin |
| `PENPOT_MCP_MODE`           | `builtin` or `inject`               | by origin (loopback ⇒ `builtin`)   |
| `PENPOT_MCP_WS_URI`         | URI to inject (`inject` mode only)  | `ws://localhost:<port>`            |
| `PENPOT_MCP_WEBSOCKET_PORT` | MCP server's WebSocket port         | `4402`                             |
| `PENPOT_BROWSER_CHANNEL`    | Browser channel; empty ⇒ bundled    | `chrome`, or empty for loopback    |
| `PENPOT_EMAIL` / `PENPOT_PASSWORD` | Non-interactive login        | unset (interactive)                |
| `PENPOT_CLEAR_CACHE`        | Drop the profile HTTP cache at launch | on for a loopback origin  |
| `PENPOT_HOST_HEADLESS`      | Set to `false` to watch the browser | `true`                             |

## How it works

1. Launches Chrome against a persistent profile that already holds a Penpot
   session cookie.
2. Grants `local-network-access` for the Penpot origin — without it Chromium
   refuses `ws://localhost` from a public https page
   (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`).
3. Injects `window.penpotMcpServerURI` before page scripts run, so
   `app.config/mcp-ws-uri` resolves to the local server instead of Penpot's
   hosted one.
4. Opens the workspace and waits for the page to open that WebSocket, which is
   the only trustworthy readiness signal (see `spikes/README.md`).

## Version skew: the server and the plugin are one pair

They speak a private protocol that changes between releases, and the plugin
ships inside the **frontend**, not with the server. Pairing a newer server with
an older plugin fails in a way that reads as an environment problem: develop
added a plugin heartbeat that 2.17 never sends, so the server rejects every
tool call with *"the Penpot plugin tab appears to be suspended … click the tab
to wake it"*. There is no tab to click, and nothing is actually suspended.

When running a locally built server against official images, mount the matching
plugin build (`mcp/packages/plugin/dist` over `/var/www/app/plugins/mcp`) as
well, or run the stock server.

**The browser profile caches the plugin.** It is an ordinary static asset, so a
stale copy outlives the remount and reproduces the same misleading error after
you have already fixed the version skew. The host therefore drops the profile's
HTTP cache at launch whenever the origin is loopback; cookies are untouched.
Override with `PENPOT_CLEAR_CACHE=false`, or force it on for a remote origin
with `PENPOT_CLEAR_CACHE=true`.

## Known limitations

- One file per host process; the file is chosen by configuration, since there
  is no user to navigate. A document-selection tool needs server changes.
- Tasks are not serialised per connection, so concurrent `execute_code` calls
  can interleave and corrupt each other's captured logs and flag restoration.
  This is a pre-existing server issue that matters more under an agent.
- Cookie auth only — see the section above. A personal access token cannot
  authenticate the notifications socket.
- The session expires after 7 days (30 absolute, renewed on use); re-run
  `pnpm run login`.
- Not wired into `mcp/pnpm-workspace.yaml`: it keeps its own lockfile so that
  Playwright stays out of the main MCP dependency set while this is
  experimental.
