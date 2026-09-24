# Handoff: headless MCP host

Everything a fresh session needs to continue this work on another machine.
Written 2026-09-15, branch `exp/headless-mcp`, head `667f45a`.

## 1. The goal

**Run the Penpot MCP server without binding it to a user's browser tab.**

The stock MCP server is a bridge, not a design engine. Every design-touching
tool (`execute_code`, and `export_shape` / `import_image`, which synthesise JS
and send it through the same path) bottoms out in `ExecuteCodeTaskHandler`
running code against the `penpot` object _inside a Penpot tab the user keeps
open_. That object is a facade over the running frontend —
`frontend/src/app/plugins/api.cljs` is wall-to-wall `st/emit!` of workspace
events — so it needs a loaded file, the notification socket, layout, fonts and
wasm.

The user's requirement: the headless session must be **fully functional**, not a
degraded subset.

## 2. Approach chosen

Three options were considered:

|       | approach                                                                             | verdict                                                                       |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **A** | Server owns a headless browser                                                       | **chosen** — days of work, full API fidelity, no Penpot changes               |
| B     | Run the frontend in Node                                                             | rejected — stubs the parts that matter (layout, text, wasm)                   |
| C     | Reimplement the plugin API server-side on `app.common.files.builder` + `update-file` | deferred — cheap multiplicity, but owns `revn` reconciliation and text layout |

"Headless browser" is not a compromise here: the point is that the browser stops
being _the user's_ and becomes infrastructure the server starts, pools and kills.
`exporter/` already ships this pattern in production (Playwright + injected auth
cookie), so there is precedent in-repo.

## 3. What is built (committed in `667f45a`)

`mcp/packages/host/` — experimental, self-contained, **not** in
`mcp/pnpm-workspace.yaml` (keeps Playwright out of the main MCP lockfile).

| file        | role                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `host.js`   | owns the browser: persistent profile, permission grant, URI injection, waits for the plugin WebSocket |
| `smoke.js`  | acceptance test — drives the MCP server as a real MCP client                                          |
| `README.md` | usage, configuration, authentication rationale, limitations                                           |
| `spikes/`   | the probes that established the design, each with its verdict                                         |

Verified end to end: an MCP client called `execute_code`, which read the file
name and created a rectangle in a cloud Penpot file, with no user tab involved.

## 4. Findings that must not be re-litigated

Each is measured, not assumed; the probe is in `spikes/`.

1. **Penpot's deployed bundle reads `window.penpotMcpServerURI`**
   (`app.config/mcp-ws-uri`, `frontend/src/app/config.cljs:185`). Injecting it
   before page load redirects Penpot's _own bundled_ MCP plugin to a local
   server. No plugin needs to be served or hand-installed, and the plugin's
   version check passes automatically because the plugin comes from Penpot.

2. **Private Network Access blocks `ws://localhost` from a public https origin.**
   Baseline Chromium 151 fails with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
   The fix is `context.grantPermissions(["local-network-access"], {origin})` —
   scoped, and immune to flag renames. `--disable-features=PrivateNetworkAccessChecks`
   is a **no-op** on current Chromium; the flag was renamed to
   `LocalNetworkAccessChecks`. Do not trust flag names from documentation.

3. **Cookie auth is required; a personal access token is not enough.**
   `Authorization: Token ...` authenticates every HTTP path (the app boots and
   the plugin starts with no cookie at all) but **not**
   `wss://.../ws/notifications`, which fails auth and reconnect-loops. Browsers
   do not send custom headers on a WS upgrade. That socket carries other
   sessions' edits, so losing it means the page silently goes stale while the
   agent writes. Token-only auth needs an upstream Penpot change: accept a token
   as a query param on `/ws/notifications`, which already takes `?session-id=`.

4. **The mcp-type token is not an API credential.** `decode-token` pins
   `:iss "access-token"` (`backend/src/app/http/access_token.clj:19`) while the
   mcp token is issued as `urn:penpot:mcp-token`. It authenticates nothing in
   the backend; it is only the routing key the plugin sends as `userToken`.
   **Never call `create-access-token` with `type "mcp"`** — it deletes the
   user's existing one (`sql:clean-old-mcp-tokens`) and breaks MCP in their real
   Penpot tab. Read it with `::get-current-mcp-token`.

5. **`design.penpot.app` is behind Cloudflare.** Stock Chrome
   (`channel: "chrome"`) is not challenged; Playwright's headless shell and
   synthetic `fetch` calls are. Anything bypassing the app's own code paths will
   see "Just a moment...".

6. **Three readiness signals lie**, and each cost time to learn:
    - the **URL** — the SPA stays on the workspace URL while every request fails;
    - a **synthetic RPC probe** — Cloudflare-challenged even when the app is fine;
    - **`page.on("response")`** — never sees the app's RPC traffic at all.

    The trustworthy signal is **the plugin WebSocket connecting with a
    `userToken`**, which requires an authenticated `get-access-tokens`. `host.js`
    uses exactly that.

7. **Versions.** npm's `@penpot/mcp` `latest` is 2.15.4 and `next` is 2.17.0;
   **there is no 2.18.x published**, though cloud runs 2.18.0-RC5. This branch is
   reset to the `2.17.0` tag, the newest published MCP. The mismatch only affects
   `ApiDocs` drift, not compatibility, because the plugin ships from cloud.

## 4b. Findings added 2026-09-18 (self-hosted instance)

A local Penpot removes most of section 4 rather than adding to it. Measured on
the official 2.17 images (`docker/images/docker-compose.yaml`, which already
ships a `penpot-mcp` service and the `enable-mcp` flag):

8. **Nothing needs injecting.** nginx proxies the MCP server at the app's own
   origin (`/mcp/ws`, `/mcp/stream`), which is exactly where
   `app.config/mcp-ws-uri` already resolves. Finding 1 is moot locally.

9. **No private-network block and no Cloudflare.** Page and socket are both
   loopback, so findings 2 and 5 do not apply — and Playwright's bundled
   Chromium works, so Google Chrome need not be installed at all.

10. **A workspace URL needs `team-id`, not just `file-id`.** Without it the page
    loads, authenticates, opens the notifications socket and reports no error,
    but `team-container*` (`frontend/src/app/main/ui.cljs:187`) renders nothing,
    so the plugin never starts. A fourth lying readiness signal, and the most
    convincing one yet: the console is clean.

11. **Onboarding blocks a fresh account.** `manage.py create-profile` leaves the
    questionnaire pending, and it renders *instead of* the app. Clear it with
    the `onboardingViewed` profile prop — and set `releaseNotesViewed` to the
    release (`"2.17"`), not the build (`"2.17.2"`), or the what's-new modal
    takes its place.

12. **The MCP server and the MCP plugin are one version-matched pair.** The
    plugin ships inside the *frontend*, so mounting a develop-built server into
    a 2.17 stack breaks it: develop added a plugin heartbeat that 2.17 never
    sends, and the server then rejects every tool call with "the Penpot plugin
    tab appears to be suspended … click the tab to wake it". Nothing is
    suspended and there is no tab to click. Mount both builds, or neither.

13. **The browser profile caches the plugin, and hides a fixed bug.** After
    mounting a matching plugin build, the stale cached copy kept loading and
    kept producing finding 12's error, which sent the investigation back to
    throttling and tab visibility (both measured, both innocent: timers tick 12
    times in 12 seconds in every frame, plugin iframe included). `config.js`
    now clears the profile's cache directories at launch for a loopback origin.

14. **Cookie auth stays required, but stops hurting.** Finding 3 holds, yet a
    local password account makes the login non-interactive
    (`PENPOT_EMAIL`/`PENPOT_PASSWORD`), which retires next step 4 for local use.

A working instance lives in `~/penpot-local` on the original machine; its
README carries the day-to-day commands and the mount recipe.

## 5. Setting up the new machine

Prerequisites: Node 22+, pnpm, and **Google Chrome installed** (the host uses
`channel: "chrome"`).

```
git checkout exp/headless-mcp
cd mcp && pnpm install && pnpm run build        # builds the stock 2.17.0 server
cd packages/host && pnpm install --ignore-workspace
pnpm run login                                  # interactive, once
```

Then, in three terminals:

```
node ../server/dist/index.js                    # MCP server: 4401 http, 4402 ws
PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' pnpm start
pnpm run smoke                                  # acceptance test
```

An MCP client connects to `http://localhost:4401/mcp`.

### What does not travel with the repo

- **The browser profile** (`~/.cache/penpot-headless/profile`) holds the session
  cookie. Do not copy it; just run `pnpm run login` again.
- **`~/.cache/penpot-headless/token`** — the PAT from spike 4. No longer used;
  safe to delete, and revoke it in Penpot if you like.
- **The scratch file URL** — set `PENPOT_FILE_URL`. Use a throwaway file: the
  agent has unrestricted edit rights over whatever you point it at.
- **Playwright browsers** — only `spikes/spike-pna.js` needs the bundled
  Chromium (`npx playwright install chromium`); the host uses system Chrome.

### Prerequisite on the Penpot account

**MCP must be enabled in Penpot Settings.** Without it the bundled plugin never
starts, no WebSocket is attempted, and the failure looks like a design flaw
rather than a missing toggle. `spikes/diagnose.js` distinguishes the cases.

## 6. Operational gotchas

- **Chrome locks the profile directory** — `host.js` and any spike using the
  same profile cannot run concurrently. Stop one first.
- **Port conflicts**: a spike and the real server both want 4402. Spikes accept
  `PENPOT_MCP_WEBSOCKET_PORT`.
- **The server must run with cwd = `packages/server`**; `ConfigurationLoader`
  reads `data/` relative to `process.cwd()`.
- **Do not pipe a long-running server through `tail`** — output buffers and you
  see nothing.
- `mcp`'s build scripts invoke `pnpm` directly, so it must be on PATH; corepack
  alone is not enough.
- Format with `pnpm exec prettier --write` on `*.js`/`*.md` only — never the
  generated lockfile.

## 7. Transferring the work

`origin` is **penpot/penpot upstream**, so `exp/headless-mcp` cannot be pushed
there. Either add your own fork as a remote, or move it as a bundle:

```
git bundle create headless-mcp.bundle develop..exp/headless-mcp
# on the new machine:
git fetch /path/to/headless-mcp.bundle exp/headless-mcp:exp/headless-mcp
```

## 8. Next steps, in order

1. **Per-connection task queue in `PluginBridge`.** Nothing serialises tasks:
   the bridge writes to the socket immediately and `plugin.ts` fires
   `handlePluginTaskRequest` without awaiting the previous one. Concurrent
   `execute_code` calls share one `context`, call `console.resetLog()` on each
   other, and clobber the non-reentrant `penpot.flags` save/restore.
   Pre-existing, but an unattended agent will hit it far more often than a human
   clicking.
2. **`open_file` tool.** With no human to navigate, document selection must be a
   tool. Lifts the one-file-per-process limit. `penpot.currentFile` reads a
   single global `:current-file-id`; there is no `openFile` in the plugin API,
   so the host must navigate the page.
3. **Session-expiry handling.** Detect the logged-out state and fail with "run
   login" instead of a silent 90s timeout.
4. **Optional: non-interactive login** by driving the login form headlessly for
   password accounts. Trades a password on disk for never logging in by hand;
   SSO/2FA accounts still need a human.

Beyond that lies the generalisation discussed but not started: re-key
`clientsByToken` to a lease id (today one connection per token is enforced and a
second is rejected), a lease manager with LRU eviction, and multi-document /
multi-session support. That is also where Linux and containers start to matter.

## 9. Open question not yet answered

The notifications socket is proven to **stay open and unerrored**, not proven to
**deliver frames** — zero inbound frames is expected on an idle file. A positive
liveness proof needs two concurrent sessions, one editing and one watching.
