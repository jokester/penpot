# Architecture: modes, mechanism, and what each one can do

How a headless browser lets an agent drive Penpot, what the three modes actually
differ in, and where each one stops. Everything marked *verified* was driven end
to end and dated; everything else says so.

Companion to [SPEC.md](SPEC.md), which specifies the launcher. This document
describes the system the launcher drives.

## 1. The one idea

**Nothing in Penpot is modified, and no plugin is ever installed.** A browser
opens stock Penpot; Penpot loads *its own* bundled MCP plugin; the plugin
connects to an MCP server. The only thing replaced is the human who would
otherwise keep a tab open.

Everything below follows from that. In particular the plugin always ships from
the instance you point at, which is why the worker survives Penpot upgrades —
and why the *server* is the piece that can fall out of step.

## 2. The pieces

```
  MCP client  (the agent)
        │  HTTP, streamable:  /mcp  or  /mcp/stream
        ▼
  MCP server
        │  WebSocket   ← "what the plugin dials"
        ▼
  ┌───────────────────────── the browser tab ─────────────────────────┐
  │  plugins/mcp/index.js    the plugin's IFRAME                      │
  │        ▲                 owns the WebSocket and the heartbeat     │
  │        │ postMessage     no penpot API                            │
  │        ▼                                                          │
  │  plugins/mcp/plugin.js   the plugin SANDBOX                       │
  │        │                 owns the `penpot` API, no network        │
  │        ▼                                                          │
  │  stock Penpot workspace, authenticated by the session cookie      │
  └───────────────────────────────────────────────────────────────────┘
        │
        ▼
  Penpot backend
```

**"The plugin" is two files**, and confusing them wastes time:

| file | runs in | owns | size (2.17) |
| --- | --- | --- | --- |
| `plugin.js` | Penpot's plugin sandbox | the `penpot` API; no network | 11.3 KB |
| `index.js` + `index.html` | an iframe the sandbox opens | **the WebSocket** and the heartbeat | 3.8 KB |

`manifest.json` names only `plugin.js`, which is why the iframe is easy to miss.
`plugin.js` calls `penpot.ui.open(…)` — hidden in headless use — and relays over
`postMessage`. So **"the plugin dials X" always means `index.js` opened a
WebSocket to X**, and heartbeat questions are about `index.js` alone.

## 3. Two axes

The mode names only one of them.

```
   who runs the MCP server?                where does the plugin dial?
   ────────────────────────                ───────────────────────────
   the instance already does        ──▶    its own origin        = builtin
   you start one                     ─▶    wherever you say      = inject
```

and when you start one, two further questions — **whose code**, and **whose
container** — which is what actually separates the named modes:

| | whose code | where it runs | name |
| --- | --- | --- | --- |
| the instance's | — | the instance's own | `builtin` |
| stock, pinned | the *target's* container | self-hosted only | `exec` |
| stock, pinned | **a container of yours** | anywhere, incl. cloud | **`image` (§4b)** |
| **your build** | the host | anywhere | `local` |

`exec` and `image` are the same idea — run the published image, never your own
build — differing only in whose container it lands in. `local` is the only mode
that runs code this repo compiled.

`PENPOT_MCP_MODE` is the second column only: whether
`window.penpotMcpServerURI` is injected before page load. Who runs the server is
a separate decision. **Injection is per-page**, not per-browser, which is what
lets several tabs in one Chromium each drive their own server.

## 4. The modes

| | **builtin** | **exec** | **local** |
| --- | --- | --- | --- |
| who starts the server | nobody; already running | you, inside the stock container | you, on the host |
| whose code | the instance's | **stock, same image** | **your build of this repo** |
| server mode | multi-user, shared | single-user, one per lane | single-user, one per lane |
| plugin dials | `<origin>/mcp/ws` | `ws://localhost:<ws>` injected | `ws://localhost:<ws>` injected |
| client connects to | `<origin>/mcp/stream?userToken=…` | `127.0.0.1:<port>/mcp` | `<host>:<port>/mcp` |
| needs a `userToken` | **yes** | no | no |
| needs published ports | no | yes | yes |
| needs container access | no | **yes** | no |
| needs a local build | no | no | **yes** |
| version skew possible | never | never | **yes** |

### 4b. `image`: a stock server of your own, against any target

**Not implemented. Recorded so the map is complete.**

Nothing stops you running `docker run penpotapp/mcp:<tag>` on your own host and
pointing a worker at **cloud** through it. The plugin still comes from cloud; the
server is a pinned published image rather than something you built. That is the
missing cell in the table above, and it would give cloud what `exec` gives
self-hosted: **many documents on one account, no token, no slot contention** —
without needing a build, and without needing a shell on the instance.

Whether the pairing works is a version question, and the answer is probably yes:

| | newest published image | what the target's plugin is |
| --- | --- | --- |
| `penpotapp/mcp` | **2.17.2** (2026-08-27) | cloud serves **2.18.0** |

That looks like skew, but it is the *harmless* direction. The failure we measured
is a server that **requires** heartbeats meeting a plugin that sends none. Here
it is reversed — a 2.17 server that never checks, meeting a 2.18 plugin that
sends them anyway — and a server that does not look at a message is not broken
by receiving it. The expected cost is `ApiDocs` drift: the tool descriptions
would describe 2.17's API while the document is 2.18's.

Skipped because there is little appetite for driving cloud here, and because
`builtin` already covers the one-document cloud case with no infrastructure at
all. If that changes, this is a smaller step than it looks: the `ExecBackend`
interface already abstracts "start a process in a container and tell me its
pid", and a `docker run` backend is a third implementation beside `compose` and
`kubectl` rather than a new concept.

The name is provisional — raised as *local-container*, which collides awkwardly
with `local` (your build) and with `--browser container` (where the browser
runs). `image` says the distinguishing thing: it runs the published image.

### Where each one is available

| | self-hosted | penpot cloud | in the launcher |
| --- | --- | --- | --- |
| **builtin** | ✅ verified 2026-09-20 | ✅ verified 2026-09-20 | deferred — contends with your tabs |
| **exec** | ✅ verified | ✗ needs your container | **implemented (v1, the only one)** |
| **local** | ✗ broken today (§6) | ✅ verified, prior session | deferred |
| **image** | redundant with `exec` | ○ untested, would work (§4b) | deferred |

The mechanism works in every cell marked verified; the last column is a scoping
choice, not a capability claim. See [SPEC.md](SPEC.md) §3b for why `exec` is the
only one v1 builds: the goal is decoupling a worker from the operator's own
tabs, and `builtin` is the one mode that cannot do that, because it routes by an
account's token and a token has one plugin slot.

Note the diagonal: **`exec` is the self-hosted answer and `local` is the cloud
answer**, for the same reason in mirror image — each gives a lane its own
single-user server, and a single-user server needs no token and has no slot to
contend over.

## 5. Capability and limitation

| | builtin | exec | local | image (§4b) |
| --- | --- | --- | --- | --- |
| documents at once | **1 per account** | many | many | many |
| a second lane on one account | breaks quietly (§7) | fine | fine | fine |
| ports to manage | none | a published range | host ports | host ports |
| deployment config needed | **none** | compose/k8s access | a build | docker on your host |
| survives a Penpot upgrade | yes | yes | only if rebuilt | only if retagged |
| competes with your own tabs | **yes** (§7) | no | no | no |
| runs code you compiled | no | no | **yes** | no |

**`builtin` is the simplest and the least scalable.** It needs nothing — no
ports, no container, no build, no `deployment.json` — so it is the mode that
works against any Penpot, including one you have no shell on. It buys that by
using the instance's shared multi-user server, which is where its one-document
ceiling comes from.

**`exec` is the workhorse** where you control the containers: many documents,
no token, and version skew is structurally impossible because the server is the
same bundle that served the plugin.

**`local` is for hacking on the server itself**, and is today the only
*implemented* cloud mode that scales past one document. `image` (§4b) would be
the better answer there — same stock-code guarantee as `exec`, no build — and is
unbuilt only because cloud is not the target here.

## 6. Mechanism: version pairing

The plugin comes from the instance. The server may not. When the two disagree
about the heartbeat protocol, every call fails with a message that blames
something else:

> The Penpot plugin tab appears to be suspended by the browser (no heartbeat
> for 107s). Please click/focus the Penpot tab to wake it, then retry.

The tab is fine, and focusing it changes nothing. Measured:

| instance | `/plugins/mcp/index.js` | sends heartbeat |
| --- | --- | --- |
| penpot cloud (2.18.0) | 4724 bytes | **yes** |
| self-hosted 2.17 images | 3822 bytes | **no** |

This repo's server *requires* heartbeats. Therefore:

- `local` against **cloud** → matched pair, works.
- `local` against **self-hosted 2.17** → broken, every call fails.
- `exec` → same bundle both ends, cannot skew.

Counterintuitive and worth remembering: **your local build works against cloud
and not against your own instance.** Measure `index.js`, never `plugin.js` — the
sandbox half has no heartbeat on either and comparing it tells you nothing.

A second-order trap: after fixing the pair, the **browser profile's HTTP cache**
keeps serving the old plugin. Clear it at launch; cookies are unaffected.

## 7. Mechanism: token routing, and the sticky slot

Only `builtin` uses a `userToken`, and it is **not a credential**. `decode-token`
pins `iss: "access-token"` while the mcp token is issued as
`urn:penpot:mcp-token`; it authenticates nothing. It is the routing key a
multi-user server uses to decide which browser a call belongs to.

**One token is one plugin slot, and the slot is sticky.** The token belongs to an
*account*, not a tab. So a human tab and a worker on the same account compete
for it, and the loser is silent: the second connection is **accepted**, the first
registration keeps routing, and the failure appears as the suspended-tab error
above — blaming the browser for server-side bookkeeping. Reconnecting does not
reclaim it. Measured across five calls, the reported "last heartbeat" kept
pointing at a moment *before* the current worker had connected. Regenerating the
token — a new routing key — cleared it instantly and the next run worked.

Consequences:

- **Give a worker its own account.** This is the whole reason
  `mcp-worker@…` exists self-hosted, and it applies identically on cloud.
- **Never call `create-access-token` with `type: "mcp"`** on an account you care
  about: it deletes the existing token (`sql:clean-old-mcp-tokens`) and breaks
  MCP in that user's real tab. Read it, don't mint it.
- A supervisor should **refuse** a second `builtin` lane on one account rather
  than let it half-work.

## 8. Mechanism: authentication, three unrelated layers

Confusing these costs hours.

1. **Cloudflare Access** (`CF_Authorization`) — gates a public hostname. Browser
   oriented; a machine client needs a service token.
2. **The Penpot session** (`auth-token` cookie) — what the page and the
   notifications socket authenticate with. A personal access token is *not* a
   substitute: `Authorization: Token …` works on every HTTP path but not on
   `wss://…/ws/notifications`, because browsers send no custom headers on a
   WebSocket upgrade. Lose that socket and the page silently goes stale while
   the agent writes.
3. **The MCP `userToken`** — routing only, as above.

### Trustworthy origins

Hardened sessions set `Secure` cookies, which a browser keeps only for a
trustworthy origin. `http://localhost:9001` qualifies; `http://a-lan-name:9001`
and `http://10.43.x.y:9001` do not, and the cookie is dropped **silently** while
login appears to succeed.

This is why the worker always talks to `localhost` — SSH-forwarding a port and
still calling it localhost — and why a Kubernetes deployment wants a NodePort,
`hostPort` or `hostNetwork` rather than a cluster IP.

Python's `http.cookiejar` does not implement this rule: it stores a `Secure`
cookie received over loopback http and then refuses to send it, producing 401s
that look like an auth bug.

## 9. Mechanism: the browser

- **Injection is per-page.** `page.addInitScript()` runs before page scripts and
  is scoped to that page, so tabs in one browser can each dial a different
  server. Verified: three tabs, three different `penpotMcpServerURI` values.
- **Background tabs are not throttled** under
  `--disable-background-timer-throttling` and friends. Verified: three tabs each
  ticked 30 times in 3 s, the two backgrounded ones included. This matters
  because a throttled tab stops heartbeating and gets reported as suspended.
- **Tabs are far cheaper than browsers.** Measured: 527 MB for a browser and its
  first tab, **94 MB** per tab after that.
- **Google Chrome is not required for cloud.** An older measurement had
  Cloudflare challenging Playwright's headless shell. As of 2026-09-20 the
  bundled Chromium loaded the cloud login page, the authenticated dashboard and
  a workspace with no challenge, across six runs. `config.js` still defaults
  `CHANNEL` to `"chrome"` for non-loopback origins; that default is stale.
- **Readiness is the plugin WebSocket opening.** Three other signals lie: the
  URL (the SPA stays put while every request 401s), a synthetic RPC probe
  (answerable by an edge proxy), and `page.on("response")` (never sees the app's
  RPC traffic).

## 10. Known limitations

- **One document per worker tab.** Penpot's plugin API has no `openFile`; every
  accessor reads a single global current-file-id. Scale by adding tabs.
- **A workspace URL needs `team-id` as well as `file-id`.** With only the file
  id the page loads, authenticates, opens the notifications socket, reports no
  error and renders nothing.
- **`export_shape` is unreliable outside a human browser.** Without
  `enable-wasm-export` it round-trips through the exporter and returns an asset
  URL on the *public* hostname, which a worker on localhost cannot fetch. With
  the flag it renders in-browser to a `blob:` URI — but only for png/jpeg/webp,
  only on files carrying the `render-wasm/v1` feature, and on this host
  `_render_shape_pixels` fails under software GL in both headless and headed
  browsers. The working alternative is
  `penpot.generateMarkup([shape], {type:"svg"})` through `execute_code`.
- **MCP is enabled per account, not globally.** A workspace loads the plugin only
  when the profile prop `mcpEnabled` is set *and* an unexpired `mcp`-type token
  exists. An account with neither never joins a session — which is the cleanest
  way to keep your own tabs out of a worker's way.

## 11. What has been driven end to end

| target | mode | date | result |
| --- | --- | --- | --- |
| self-hosted 2.17 | `exec`, headless and headed | 2026-09-19/20 | ✅ repeatedly; two documents at once |
| self-hosted 2.17 | `builtin` | 2026-09-20 | ✅ `execute_code` returned the live document |
| self-hosted 2.17 | `exec`, browser in a container | 2026-09-20 | ✅ window on the host X server |
| penpot cloud 2.18.0 | `builtin` | 2026-09-20 | ✅ `{file: "scratch", shapes: 1}` |
| penpot cloud 2.18.x | own server + injected URI | prior session | ✅ read a file, created a rectangle |
| self-hosted 2.17 | `local` | — | ✗ heartbeat mismatch, §6 |

## Source map

| what | where |
| --- | --- |
| launcher design | [SPEC.md](SPEC.md) |
| mode selection, defaults, cache clearing | `mcp/packages/host/config.js` |
| deployment, flags, ports | `deploy/home-cluster/HANDOFF.md` |
| `mcp-ws-uri` resolution | `frontend/src/app/config.cljs:185` |
| per-account MCP gating | `frontend/src/app/main/data/workspace/mcp.cljs:200` |
| mcp-token issuer pin | `backend/src/app/http/access_token.clj:20` |
| token deletion on re-mint | `backend/src/app/rpc/commands/access_token.clj:25` |
| server ports, REPL construction | `mcp/packages/server/src/PenpotMcpServer.ts:157` |
