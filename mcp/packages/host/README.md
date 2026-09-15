# Penpot MCP browser host (experimental)

Runs the Penpot MCP plugin in a **server-owned headless browser** instead of a
user's tab, so the MCP server no longer depends on someone keeping Penpot open,
focused and unfrozen.

Nothing in Penpot is modified. The page loads stock cloud Penpot, and Penpot's
own bundled MCP plugin connects to the local MCP server exactly as it would
from a real tab — because the host injects `window.penpotMcpServerURI` before
the app boots. The MCP server is unmodified too: it cannot tell the difference.

## Status

v0: a single browser page on a single file, driven by one MCP server. Proven
end to end against `design.penpot.app` (Penpot 2.18.0-RC5, MCP server 2.17.0).
See `spikes/README.md` for the evidence behind each design decision.

## Prerequisites

- Google Chrome installed (the host uses `channel: "chrome"`; Playwright's
  headless shell gets challenged by Cloudflare).
- MCP enabled in the Penpot account's settings. Without it the bundled plugin
  never starts and no WebSocket is attempted.
- A logged-in profile: `pnpm run login` (once; the session lasts 7 days).

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

## Configuration

| Variable                    | Description                         | Default                            |
| --------------------------- | ----------------------------------- | ---------------------------------- |
| `PENPOT_FILE_URL`           | Workspace URL to open (required)    | —                                  |
| `PENPOT_ORIGIN`             | Penpot origin                       | `https://design.penpot.app`        |
| `PENPOT_PROFILE_DIR`        | Browser profile holding the session | `~/.cache/penpot-headless/profile` |
| `PENPOT_MCP_WEBSOCKET_PORT` | MCP server's WebSocket port         | `4402`                             |
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
