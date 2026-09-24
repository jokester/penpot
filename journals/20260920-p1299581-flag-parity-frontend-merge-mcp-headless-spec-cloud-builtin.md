---
date: 2026-09-20 17:00
branch: exp/headless-mcp
host: twlight-sparkle
user: mono
tldr: Closed the gap to cloud's flag set, merged the two frontends into one, fixed four launcher bugs, drew a diagram through MCP, then specced mcp-headless and verified builtin mode against penpot cloud.
---

# Journal: flag parity, one frontend, and the mcp-headless design

Continues the session journalled in
`20260920-p1083625-selfhost-deploy-headless-mcp-worker-authelia-sso-tui-launcher.md`.

## Intent

Started as "study the remaining points" after the self-hosting spike. Turned
into four threads: bring the deployment to cloud's flag set, shrink the
container count, use the worker for real work, and design the replacement for
the bash/python launcher.

## What happened

**Flag parity.** Diffed the live cloud `penpotFlags` against ours and enabled the
non-SaaS half: `auto-file-snapshot`, `audit-log`, `audit-log-gc`, `rpc-climit`,
`file-validation`, `soft-file-schema-validation`,
`sec-fetch-metadata-middleware`, `access-tokens`, `webhooks`. Left
`audit-log-archive` off — it ships events to an external collector.

**Two frontends became one.** I had documented the split as necessary. It was
not: unset `PENPOT_PUBLIC_URI` and `app.config/public-uri` falls back to
`location.origin`, so one nginx serves both the public hostname and the worker's
loopback path. Verified by driving a real document through a throwaway
origin-agnostic frontend before touching the running one. Also removed the
worker container, merged its capability into `run-mcp-worker --browser
container`, and dropped the stale `CLOUDFLARED_TOKEN`, `PLAYWRIGHT_VERSION`,
`PENPOT_SRC` and an unreferenced `x-flags-base` anchor.

**Four launcher bugs, three of them mine.** A `--port` outside the published
range started a server nothing could reach. `ports_busy_in_container` read only
`/proc/net/tcp`, so every WebSocket port looked free. Removing `exec` from the
host branch restored the cleanup trap but let execution fall through and spawn a
*second* browser. Each is now a guard with a message.

**Drew a diagram through MCP.** A 43-shape architecture board in the `diagrams`
file, built with `createRectangle`/`createText` and SVG arrows. `export_shape`
failed, so reviewing it needed `generateMarkup` → a local HTTP sink → Playwright
screenshot.

**Specced `mcp-headless`.** Four documents: SPEC (the launcher), ARCHITECTURE
(the system and its four modes), API (directory-level interfaces), IMPL-HANDOFF
(for a session without this context). Plus DEPLOY-HANDOFF for the k8s migration.

**Verified builtin against cloud.** Logged into `design.penpot.app` in a
Playwright profile, and a headless worker drove a scratch document with no
server of ours.

## Discoveries / Quirks

- **`PENPOT_PUBLIC_URI` is optional and that changes the topology.** The
  frontend entrypoint writes the origin into `config.js` only when the variable
  is non-empty; absent it, the app uses `location.origin`. One container, two
  ports, and the Cloudflare edge-cache trap disappears because `config.js` no
  longer differs by origin.
- **The MCP server binds HTTP on IPv4 and its WebSocket on IPv6.** Reading only
  `/proc/net/tcp` reports every WebSocket port free — the root cause of a
  port collision that produced `HTTP 426` from a client.
- **Removing `exec` needs an explicit `exit`.** Without it the branch falls
  through into the next one. Killing a worker started a second browser.
- **`enable-rpc-climit` crash-loops the backend** unless `climit.edn` exists.
  The source tree's copy is an example, excluded from the uberjar.
- **`export_shape` cannot work from a worker without `enable-wasm-export`**: it
  round-trips through the exporter and returns an asset URL on the *public*
  host, which a worker on localhost cannot fetch. With the flag it renders to a
  `blob:` URI — but `_render_shape_pixels` then fails under software GL, headed
  and headless, on a host whose user is not in the `render` group.
- **The MCP plugin is two files.** `plugin.js` owns the `penpot` API and no
  network; `index.js` is an iframe owning the WebSocket and the heartbeat.
  Heartbeat comparisons must use `index.js` — `plugin.js` has none on either
  cloud or self-hosted.
- **Injection is per *page*.** `page.addInitScript` gives each tab its own
  `penpotMcpServerURI`, so lanes can share one Chromium. Background tabs are not
  throttled under the no-throttle flags (30/30/30 ticks). 527 MB for a browser
  plus its first tab, **94 MB** per tab after.
- **Cloud no longer challenges the bundled Chromium.** Six runs, login page,
  authenticated dashboard and workspace, all clean. The `channel: "chrome"`
  default was not merely stale but actively breaking on a host without Chrome.
- **One `userToken` is one plugin slot, and the slot is sticky.** The token
  belongs to an *account*. A human tab and a worker on the same account compete;
  the second connection is accepted, the first keeps routing, and the error
  blames a suspended tab. Regenerating the token is the reliable reset.
- **`chromium.connectOverCDP` detaches on `close()`** rather than killing —
  measured while evaluating an adoption model that was then dropped.
- **`kubectl port-forward` is not required for k8s.** Exposure is a deployment
  property; a node-local port satisfies the `Secure`-cookie rule with no moving
  parts.

## Changes

**Deployment** — `docker-compose.yaml`: merged frontends, removed the worker
service and `penpot_worker_profile`, added `climit.edn` mount,
`PENPOT_MCP_REPL_PORT` to suppress the REPL, `enable-wasm-export` scoped to the
frontend alone. `.env`/`.env.example`: nine flags added, four dead variables
removed. New `climit.edn`. `HANDOFF.md`: §2 rewritten (it argued the wrong
thing), plus the export limitation and the port-range trap. New
`DEPLOY-HANDOFF.md` for k8s.

**Launcher (current)** — `run-mcp-worker`: `--browser host|container`,
`PENPOT_BROWSER_ARGS`, port-range and busy-port guards, IPv6 probe fix, the
`exec`/fall-through fix, secrets through a mode-600 `--env-file`.

**Launcher (next)** — new `mcp/packages/headless/` with SPEC, ARCHITECTURE, API
and IMPL-HANDOFF. No code yet, by design.

**Host package** — `config.js`: `PENPOT_BROWSER_ARGS`, `CHANNEL` defaulted to
the bundled build. `TOPOLOGIES.md` marked superseded with two claims corrected
in place. README prerequisite corrected.

## Open threads

- **No backups.** `auto-file-snapshot` now gives in-app version history, but it
  lives in the same Postgres volume as everything else. Still the thing I would
  do next.
- **`export_shape` from a worker.** Needs the user in the `render` group and a
  retest with `PENPOT_BROWSER_ARGS`; may simply need a GPU the worker cannot
  have. `generateMarkup` → SVG works today.
- **`mcp-headless` is unimplemented.** Build order in SPEC §14, narrowed to
  `exec` + self-hosted by §3b.
- **42+ commits unpushed** on `exp/headless-mcp`; `origin` is upstream.
  `deploy/home-cluster/`, `mcp/packages/headless/`, `mcp/packages/host/` and
  `journals/` must never ride along in a PR.
- **Cloud MCP token** was regenerated during testing and passed through a
  transcript; worth regenerating again.
