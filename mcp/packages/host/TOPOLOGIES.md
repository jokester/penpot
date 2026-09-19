# Topologies: inject vs builtin, cloud vs self-hosted

A study note for future experiments. Everything here was measured on a running
system; where a number appears, it came from a probe, not from reading code.
Last measured 2026-09-20 against penpot cloud (2.18.0-RC5) and a self-hosted
stack on the 2.17 images (`deploy/home-cluster/`).

## 1. The one idea worth keeping

**Nothing in Penpot is modified, and no plugin is ever installed.** The worker
opens stock Penpot in a real browser; Penpot loads *its own* bundled MCP plugin;
that plugin connects to an MCP server. The spike replaces exactly one thing — the
human who would otherwise have to keep a tab open.

Everything below is a consequence of that. In particular: the plugin always ships
from the instance you point at, which is why the worker survives Penpot upgrades,
and why the *server* is the piece that can fall out of step.

## 2. Two axes, not one

The word "inject" names only the browser half. It is easy to conflate with "who
runs the server", which is a separate decision.

```
        who runs the MCP server?            where does the plugin dial?
        ────────────────────────            ───────────────────────────
   the instance already does          ──▶   its own origin      = builtin
   you start one (stock, in-container) ─▶   wherever you say    = inject
   you start one (your build, on host) ─▶   wherever you say    = inject
```

`PENPOT_MCP_MODE` (read by `config.js`) is the second column only. It decides
whether `window.penpotMcpServerURI` is injected before page load. The first
column is chosen by `run-mcp-worker --mcp`, which has **three** values:

| `--mcp` | server process | whose code | `PENPOT_MCP_MODE` | plugin dials | MCP client connects to |
| --- | --- | --- | --- | --- | --- |
| `builtin` | already running | the instance's | `builtin` | `<origin>/mcp/ws` | `<origin>/mcp/stream?userToken=…` |
| `exec` | you start it, in the stock container | **stock, same image** | `inject` | `ws://localhost:<ws>` | `127.0.0.1:<port>/mcp` |
| `local` | you start it, on the host | **your build of this repo** | `inject` | `ws://localhost:<ws>` | `<host>:<port>/mcp` |

So "inject mode means I run my own MCP server" is only half right. Under `exec`
you run *Penpot's* server — a second copy of the stock bundle whose ports and
lifecycle you own. That is the entire point of `exec`: it makes version skew
structurally impossible (§5).

## 3. The wire picture

```
  MCP client (an LLM agent)
        │  HTTP, streamable  (/mcp or /mcp/stream)
        ▼
  MCP server
        │  WebSocket  ( = "the plugin dials …" )
        ▼
  ┌─────────────────────────────────────────────── the browser page ──┐
  │  plugins/mcp/index.js   the plugin's IFRAME. Owns the WebSocket   │
  │        ▲                and the heartbeat. No penpot API.         │
  │        │ postMessage                                              │
  │        ▼                                                          │
  │  plugins/mcp/plugin.js  the plugin SANDBOX. Owns the `penpot`     │
  │        │                API. No network of its own.               │
  │        ▼                                                          │
  │  stock Penpot workspace, cookie-authenticated                     │
  └───────────────────────────────────────────────────────────────────┘
        │
        ▼
  Penpot backend
```

### What "the plugin" actually is

Penpot's own MCP plugin, served as static assets from whichever origin the page
loaded — `<origin>/plugins/mcp/`. We never build, serve or install it; that is
the whole reason the worker survives Penpot upgrades.

It is two artifacts, and confusing them wastes time:

| file | runs in | has | size (2.17) |
| --- | --- | --- | --- |
| `plugin.js` | Penpot's plugin sandbox | the `penpot` API, no network | 11.3 KB |
| `index.js` (+ `index.html`) | an iframe the sandbox opens | **the WebSocket** and the heartbeat | 3.8 KB |

`manifest.json` names `plugin.js` as the entry point; that code calls
`penpot.ui.open("Penpot MCP Plugin", …)` to create the iframe (hidden in
headless use) and then relays messages to it. So **"the plugin dials X" always
means index.js opened a WebSocket to X**, and a heartbeat measurement belongs to
index.js — `plugin.js` carries none on either cloud or self-hosted.

The worker (`host.js`) owns none of this. It is a Playwright persistent context
with a logged-in session, holding a workspace URL open; Penpot loads the plugin
by itself once the account has it enabled.

## 4. How `config.js` decides

```js
ORIGIN      = PENPOT_ORIGIN            ?? "https://design.penpot.app"
IS_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(ORIGIN)
CHANNEL     = PENPOT_BROWSER_CHANNEL   ?? (IS_LOOPBACK ? "" : "chrome")
PROFILE     = PENPOT_PROFILE_DIR       ?? ~/.cache/penpot-headless/profile[-local]
MCP_MODE    = PENPOT_MCP_MODE          ?? (IS_LOOPBACK ? "builtin" : "inject")
WS_PORT     = PENPOT_MCP_WEBSOCKET_PORT ?? 4402
CLEAR_CACHE = PENPOT_CLEAR_CACHE       ?? IS_LOOPBACK
```

Every default keys off one predicate, `IS_LOOPBACK`. That is deliberate — point
`PENPOT_ORIGIN` somewhere and the rest follows. `run-mcp-worker` overrides
`PENPOT_MCP_MODE` explicitly, so the script always wins over the default.

`isPluginSocket(url)` decides when the page is ready. It matches on the **injected
URI's port**, not `WS_PORT`, because `PENPOT_MCP_WS_URI` can name a different one
— which is exactly what running several single-document servers side by side
does. Getting this wrong reports a healthy connection as a 90-second timeout.

## 5. Version skew: the server and the plugin are one pair

The plugin comes from the instance. The server may not. When the two disagree
about the heartbeat protocol, every tool call fails with a message that blames
something else entirely:

> The Penpot plugin tab appears to be suspended by the browser (no heartbeat
> for 107s). Please click/focus the Penpot tab to wake it, then retry.

This is a lie in both directions: the tab is fine, and focusing it changes
nothing. Measured plugin builds:

| instance | `/plugins/mcp/index.js` (the iframe bundle) | sends heartbeat |
| --- | --- | --- |
| penpot cloud (2.18.0-RC5) | 4724 bytes | **yes** |
| self-hosted 2.17 images | 3822 bytes | **no** |

Measure `index.js`, not `plugin.js`: the sandbox half is ~11.3 KB on both and
has never carried a heartbeat, so comparing it tells you nothing.

The server side of this repo (`develop`) *requires* heartbeats
(`mcp/packages/server/src/PluginBridge.ts`). Therefore:

- `--mcp local` against **cloud** → matched pair, works.
- `--mcp local` against **self-hosted 2.17** → broken pair, every call fails.
- `--mcp exec` against self-hosted → same bundle serves both halves, cannot skew.

This is counterintuitive and worth remembering: **your local build works against
cloud and not against your own instance.** `run-mcp-worker` probes the served
plugin at startup and warns before you waste time on it.

A second-order trap: after fixing the pair, the **browser profile HTTP cache**
keeps serving the old plugin. `CLEAR_CACHE` drops `Cache`, `Code Cache`,
`GPUCache` and `Service Worker/CacheStorage` at launch for this reason. Cookies
are untouched.

## 5b. Where the browser comes from

A third axis, independent of the two above: the *browser* the worker drives.

| | host | container |
| --- | --- | --- |
| binary | Playwright's cache, e.g. `~/.cache/ms-playwright/chromium-1243` | `/ms-playwright` inside `mcr.microsoft.com/playwright:v<x>-noble` |
| pinned by | whatever `playwright install` last fetched | the image tag |
| headed | yes | yes — mount `/tmp/.X11-unix`, set `DISPLAY` |

Neither is the distribution's `/usr/bin/chromium`; Playwright never uses that.
`run-mcp-worker --browser container` selects the second, and the image tag
defaults to the *installed client's* version, because the Playwright client and
the browser build must agree.

Verified: a container launched with `--network host --ipc host --user $(id -u)`,
`/tmp/.X11-unix` and `~/.Xauthority` mounted, and `DISPLAY=:3`, put a visible
Chromium window on the host's TigerVNC display and drove a real document through
it. `xwininfo -root -tree -display :3` showed the window with profile `/profile`,
and the process was `/ms-playwright/chromium-1243/chrome-linux64/chrome`.

Two traps found while building it:

- **The X socket, not TCP.** TigerVNC listens on 5903 for VNC but publishes no
  X11 TCP port, so `DISPLAY=host:3` cannot work; the unix socket must be bind
  mounted. The xauth cookie is keyed by hostname, which `--network host`
  preserves anyway.
- **Never pass secrets with `docker run -e`.** A container's command line is
  world-readable in `ps` for the life of the process, and the worker's env
  carries `PENPOT_PASSWORD`. Use a mode-600 `--env-file` and delete it on exit.

### Cloud needs Google Chrome, which is a separate install

For a non-loopback origin `config.js` sets `CHANNEL = "chrome"`, and that means
*stock Google Chrome*, not the bundled build and not distro chromium:

```
browserType.launch: Chromium distribution 'chrome' is not found
                    at /opt/google/chrome/chrome
```

So experiment 1 below needs `npx playwright install chrome` first — or
`PENPOT_BROWSER_CHANNEL=""` to force the bundled build, which is untested
against Cloudflare. The measured finding is only that the *headless shell* is
challenged; whether bundled Chromium in headed mode passes was never
established. The `--browser container` path does not help here: the Playwright
image ships Chromium, not Google Chrome.

## 6. What differs between cloud and self-hosted

| | penpot cloud | self-hosted |
| --- | --- | --- |
| MCP endpoint exists | yes — `/mcp/ws` → 426, `/mcp/stream` handshakes | yes, with `enable-mcp` |
| browser | **stock Chrome** — Cloudflare challenges Playwright's headless shell | bundled Chromium is fine |
| `ws://localhost` from the page | needs a `local-network-access` grant | same-origin loopback, no grant needed |
| session cookie | ordinary `Secure` over https | `Secure` over `http://localhost`, which Chromium treats as trustworthy |
| login | SSO in practice; no `manage.py`, no PREPL | password via RPC, or `manage.py`, or PREPL |
| server mode | multi-user, shared | image default is `--multi-user`; `exec`'d servers are single-user |
| plugin version | tracks cloud, ahead of npm | pinned to your image tag |

### Private Network Access

A `ws://localhost` dialed from an `https://` page is a private-network request
and is refused with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. The fix is
`context.grantPermissions(["local-network-access"], { origin })` — scoped, and
immune to flag renames. `--disable-features=PrivateNetworkAccessChecks` is a
**no-op** on current Chromium; the feature was renamed `LocalNetworkAccessChecks`.
Do not trust flag names from documentation.

### Trustworthy origins

Hardened Penpot sessions set `Secure` cookies. A browser keeps those only for a
trustworthy origin. `http://localhost` qualifies; `http://some-lan-name` does
not. This is why the self-hosted worker talks to `localhost:9001` even from
another machine — it SSH-forwards the port and still calls it localhost — and why
the containerized worker uses `network_mode: host`.

Python's `http.cookiejar` does **not** implement this rule: it stores a `Secure`
cookie received over loopback http and then refuses to send it, yielding 401s
that look like an auth bug. Scripts must carry the `auth-token` header by hand.

## 7. Auth: three unrelated layers

Confusing these costs hours.

1. **Cloudflare Access** (`CF_Authorization`) — gates the hostname. Browser
   oriented; a machine client needs a service token.
2. **Penpot session** (`auth-token` cookie) — what the page and the notifications
   socket authenticate with. A personal access token is *not* a substitute:
   `Authorization: Token …` works on every HTTP path but not on
   `wss://…/ws/notifications`, because browsers do not send custom headers on a
   WebSocket upgrade. Losing that socket means the page silently goes stale while
   the agent writes.
3. **MCP `userToken`** — a routing key, not a credential. `decode-token` pins
   `:iss "access-token"` (`backend/src/app/http/access_token.clj:20`) while the
   mcp token is issued as `urn:penpot:mcp-token`. It authenticates nothing; it
   tells a multi-user MCP server which browser to talk to.

**Never call `create-access-token` with `type "mcp"` on an account you care
about** — it deletes the existing one
(`backend/src/app/rpc/commands/access_token.clj:25`, `sql:clean-old-mcp-tokens`) and breaks MCP
in that user's real tab.

## 8. Enabling MCP is per-account, not global

Two things must both hold before the page loads the plugin at all
(`frontend/src/app/main/data/workspace/mcp.cljs:200,223`):

1. profile prop `mcpEnabled`
2. an unexpired access token of type `mcp` on that profile

Both are per-profile. A human account with neither will never join an MCP
session, which is the cleanest way to keep your own tabs from competing with a
worker. Conversely, enabling it on your everyday account means *every* tab
logged in as you loads the plugin.

## 9. Sharp edges that cost time

- **A workspace URL needs `team-id` as well as `file-id`.** With only `file-id`
  the page loads, authenticates, opens the notifications socket, reports no error
  and renders nothing (`frontend/src/app/main/ui.cljs:51`, `team-container*`).
- **Three readiness signals lie**: the URL (the SPA stays put while every request
  fails), a synthetic RPC probe (Cloudflare-challenged even when the app is
  fine), and `page.on("response")` (never sees the app's RPC traffic). The only
  trustworthy signal is the plugin WebSocket connecting with a `userToken`.
- **One document per worker.** Penpot's plugin API has no `openFile`; every
  accessor reads a single global current-file-id. Scale by running more workers,
  not by asking one to switch files.
- **`clientsByToken` is per-process**, so N single-user servers in one container
  are genuinely independent. This is what makes multi-document work with zero
  code changes.
- **Docker publishing a port range hides which ports are really bound.** Probe
  from inside the container (`/proc/net/tcp`), not from the host.
- **Penpot UUIDs are time-ordered**, so same-session ids share long prefixes.
  Disambiguate on the tail.

## 10. Verified, and not

**Verified end to end** — an MCP client calling `execute_code` and getting a real
answer from a real document, no human tab open:

- cloud, own server + injected URI (`local`-equivalent)
- self-hosted, `exec`, headless and headed, one and two documents at once
- self-hosted, containerized browser on the host X server (`--browser container --headed`)

**Not driven yet:**

- **cloud with `--mcp builtin`.** The endpoint is live — an anonymous
  `initialize` against `design.penpot.app/mcp/stream` returns a session id — but
  nothing has driven a document through it. This is the most interesting gap,
  because it is the only shape that needs no server of your own at all.
- self-hosted `builtin` beyond a handshake. It reaches the image's default
  `--multi-user` process, so it needs `?userToken=` and shares one server across
  all documents.
- long-lived sessions: the notifications socket across a multi-hour Access
  session, and whether the worker's cookie survives it.
- large imports through Cloudflare's request-body cap.

## 11. Experiments worth running

1. **Drive cloud in `builtin` mode.** Needs `mcpEnabled` + an `mcp` token on the
   account, both set through the UI, **and Google Chrome installed** (§5b). If
   it works, the worker reduces to "a browser and a URL" — no server, no ports,
   no injection.
2. **Two workers, one account, cloud.** Does cloud's multi-user server route
   correctly when two browsers present the same `userToken`, or does the second
   displace the first? This is the shared-server limitation that pushed the
   self-hosted setup to `exec`; measure whether it actually bites.
3. **Skew on purpose.** Point a `develop` server at a 2.17 plugin and confirm the
   heartbeat failure reproduces, then bisect what the server actually requires.
   The error message is misleading enough to be worth documenting precisely.
4. **Drop the browser.** The plugin is a small bundle talking a WebSocket
   protocol. How much of it could a Node client speak directly, and where does
   that stop working — presumably at anything needing the render/WASM path?
5. **Token-as-query-param on `/ws/notifications`.** The upstream change that
   would make PAT-only auth viable and remove the cookie dependency entirely.
   `/ws/notifications` already accepts `?session-id=`.

## Source map

| what | where |
| --- | --- |
| mode selection, defaults, cache clearing | `mcp/packages/host/config.js` |
| the browser itself | `mcp/packages/host/host.js` |
| three-mode launcher | `deploy/home-cluster/run-mcp-worker` |
| document picker TUI | `deploy/home-cluster/run-mcp-worker.py` |
| deployment, flags, ports | `deploy/home-cluster/HANDOFF.md` |
| `mcp-ws-uri` resolution | `frontend/src/app/config.cljs:185` |
| per-account MCP gating | `frontend/src/app/main/data/workspace/mcp.cljs:200` |
| mcp-token issuer pin | `backend/src/app/http/access_token.clj:20` |
| server ports, REPL construction | `mcp/packages/server/src/PenpotMcpServer.ts:157` |
| prior spike findings | `mcp/packages/host/HANDOFF.md` |
