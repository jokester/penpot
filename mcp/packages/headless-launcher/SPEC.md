# penpot-headless-mcp-launcher — architecture and spec

Status: **proposed**. Nothing is implemented; this document is the thing to
argue with before any code exists.

## 1. Vocabulary

Earlier drafts muddled these. The rest of the document depends on them.

| term | meaning |
| --- | --- |
| **worker** | the browser tab that hosts Penpot's MCP plugin. Nothing more. |
| **MCP server** | `node index.js` inside the already-running `penpot-mcp` container, one per port |
| **container** | stock `penpotapp/mcp`. Already running. **We do not start or own it.** |
| **lane** | one MCP server port **plus** the worker that serves it, driving one document |
| **launcher** | this package: opens lanes, supervises them, closes them |

A lane is identified by its **MCP port**. That is the address an agent connects
to, the thing the TUI lists, and the key everything else hangs off.

"Lane" is a coined term, used because the pair needs a name and every obvious
candidate is taken: *worker* is the tab, *session* means both a Penpot auth
session and an MCP session id, and *process* is wrong — a lane is not
necessarily an OS process of the launcher (§5).

## 2. What this replaces

| file | lines | language | role |
| --- | --- | --- | --- |
| `deploy/home-cluster/run-mcp-worker` | 404 | bash | ports, server lifecycle, browser, cleanup |
| `deploy/home-cluster/run-mcp-worker.py` | 514 | python + curses | picker that `exec`s the above |
| `deploy/home-cluster/provision-worker` | 178 | python | worker accounts, invitations, MCP tokens |
| `mcp/packages/host/host.js` + `config.js` | 233 | node | the browser itself |
| `mcp/packages/host/spikes/*.js` | 465 | node | login, diagnostics, four historical probes |

Three languages, two directories, one job, no tests. The specific failures:

- **The picker destroys itself to launch.** `run-mcp-worker.py:510` is
  `os.execvpe`, so the TUI *becomes* the bash script, which becomes the
  browser's parent. One chain, one terminal: closing the picker, losing the
  shell or hitting the wrong key takes the browser with it, and there is no way
  back to the picker without killing the lane. **This is the pain that motivates
  the rewrite.**
- **One lane at a time.** Driving two documents means two terminals, two
  invocations, and manual port bookkeeping.
- **Lanes are invisible.** Finding what is running means `ps`,
  `/proc/<pid>/environ`, and `docker compose exec … /proc/net/tcp`.
- **Every bug lived on a seam** — bash computing a port only the container can
  validate, bash exporting env that `config.js` reads by a name written in a
  third file, a bash `trap` reaping a process inside Docker. Four shipped this
  month and had to be fixed.
- **Nothing is testable.** The port allocator and the URL rewriter are pure
  functions, and each was wrong in production.

## 3. Goals

1. **A TUI that supervises many lanes at once**, each on its own port, in one
   process, in one terminal.
2. **Nothing ever `exec`s.** The launcher never replaces itself.
3. **It opens on what already exists.** Lanes that survived a previous launcher
   are discovered and adopted, not duplicated (§6).
4. **Lanes can outlive the launcher** — quitting the TUI is not a kill switch
   unless you ask for one.
5. **The invariants become tested code**, not comments in a shell script.
6. **No build step.** A `dist/` would break the read-only container mount and
   add a stale-artifact failure mode.

## 4. Non-goals

- **Not a container manager.** The `penpot-mcp` container is someone else's;
  the launcher `exec`s into it and nothing more.
- **Not a deployment tool.** `deploy/home-cluster/` owns the stock containers
  and is on its way to k8s. The launcher must not care which it is talking to.
- **Not a manager-style CLI.** A non-interactive path exists for scripting and
  systemd (§9), but the TUI is the product, not a fallback.
- **Not multi-host.** Lanes run where the launcher runs.

## 5. The supervision model

The unit is a lane, not a process. A lane's two halves live in different places
and have different lifetimes:

```
  lane :4603
    ├── MCP server   node index.js, inside the penpot-mcp container
    │                started with `docker compose exec`, survives the launcher
    └── worker       Chromium + the workspace tab
                     started detached, adopted over CDP, survives the launcher
```

Neither half is a child of the launcher in the ownership sense. The launcher is
a **supervisor over logical lanes**: each lane is a task with an explicit state
machine, its own cancellation scope, and a health signal. Several run
concurrently in one Node process, in the shape of structured concurrency —
coroutines with a parent that can cancel them, not one OS process each.

```
        ┌──────────────── launcher process ────────────────┐
        │  supervisor                                      │
        │    ├── lane 4601  task  ──▶ CDP ──▶ chromium A    │
        │    ├── lane 4603  task  ──▶ CDP ──▶ chromium B    │
        │    └── lane 4605  task  ──▶ CDP ──▶ chromium C    │
        │  TUI renders supervisor state, sends intents      │
        └───────────────────────────────────────────────────┘
                   │ docker compose exec
                   ▼
        penpot-mcp container: three `node index.js`, ports 4601/4603/4605
```

### Why the worker survives

Chromium is launched detached with `--remote-debugging-port`, and the launcher
attaches with `chromium.connectOverCDP` rather than owning it as a child. That
one choice buys goals 3 and 4: the browser is not in the launcher's process
tree, so quitting the TUI leaves it alone, and a later launcher can reconnect to
the very same tab. Verified available in the pinned Playwright.

The cost is that `launchPersistentContext`'s conveniences are given up for
explicit CDP wiring, and a crashed launcher leaves browsers that only discovery
will find — which is exactly what discovery is for.

### A lane is an async generator

```ts
type LaneEvent =
  | { state: "opening";   detail: string }
  | { state: "connected"; port: number; cdpPort: number; document: DocumentRef }
  | { state: "failed";    reason: string; log: string[] };

async function* openLane(
  spec: LaneSpec,
  deps: LaneDeps,
  signal: AbortSignal,
): AsyncGenerator<LaneEvent>;
```

The sequence *is* the state machine: the generator yields each transition as it
happens, and the supervisor `for await`s it and mirrors the last event into the
record the TUI renders. `deps` carries the I/O edges (docker, penpot rpc,
browser) so the generator is testable with fakes and `core/` stays pure.

Three properties this shape has to respect, all of them load-bearing:

- **Cleanup lives in `finally`, and only runs if the iterator is finished or
  returned.** Dropping the reference never runs it. The supervisor therefore
  owns every iterator and always calls `.return()` — on abort, on quit, on
  failure. That single discipline replaces the `trap`, the `exec`, and the
  fall-through that this rewrite exists to delete.
- **Generators are pull-based**, so a slow consumer stalls the producer at the
  `yield`. Health must not depend on the TUI pulling. Once the lane reaches
  `connected` the generator does not keep yielding heartbeats; it parks on a
  promise that settles on abort or on failure, while a separate watcher pushes
  health into the record directly.
- **Adoption enters the same generator at a later state.** `spec` carries an
  optional existing CDP endpoint; with it, the generator skips launching and
  yields `connected` after verifying the tab (§6). One code path, one cleanup.

### Lane states

```
  discovered ──┐
               ├──▶ opening ──▶ connected ──▶ closing ──▶ closed
  requested ───┘        │            │
                        └──▶ failed ─┘
```

- **discovered** — found at startup, not yet adopted
- **opening** — server up, browser up, plugin has not dialled yet
- **connected** — the plugin WebSocket is open. The only trustworthy readiness
  signal (invariant 10)
- **failed** — carries a reason and the last log lines; stays listed so the TUI
  can show why, and is retryable in place
- **closing / closed** — both halves reaped, port released

Transitions are the only way state changes, each is logged, and the TUI renders
the machine rather than guessing from side effects.

## 6. Discovery and adoption

On start, before drawing anything, the launcher builds the truth:

1. **Servers** — `docker compose exec penpot-mcp` and read `/proc/net/tcp` *and*
   `/proc/net/tcp6` (invariant 4), then map listening ports to pids and their
   `PENPOT_MCP_SERVER_PORT`.
2. **Browsers** — probe `/json/version` on each candidate CDP port; a live
   endpoint with a Penpot workspace target is a worker.
3. **Pairing** — a server port with a matching worker is a *connected* lane; a
   server with no worker, or a worker with no server, is a **half lane** and is
   shown as such, because that is the orphan state this deployment hit twice.

Adoption is reconnecting, not restarting: `connectOverCDP` to the browser, read
the document from the open tab. Nothing is disturbed by looking.

`half lanes` get one-key repair: attach a worker to a lone server, or close a
lone server. That replaces today's `docker compose exec … kill <pid>`.

## 7. The TUI

One screen, two regions.

```
  LANES                                                     penpot-headless-mcp-launcher
  port  state       document              account       browser   uptime
  4601  connected   LLM session viewer    mcp-worker    headed    2h14m
  4603  connected   diagrams              mcp-worker    headless  11m
  4605  half        (server, no worker)   —             —         3m
  ─────────────────────────────────────────────────────────────────────
  [n] new lane   [enter] details   [s] stop   [r] retry   [l] logs   [q] quit

  NEW LANE
  account   ▸ mcp-worker
  document  ▸ diagrams · 00 · Explorations
  mode      ▸ exec         port ▸ 4607 (free)
  browser   ▸ headed       display ▸ :3
  → penpot-headless-mcp-launcher --account mcp-worker --file-id fdbd… --port 4607 --headed
```

- **The list is first.** The machine's real state before any form.
- **The form is prefilled from what is detectable** — accounts on disk,
  documents fetched live across every team, a free port from the published
  range, `DISPLAY` from the environment.
- **Impossible combinations are refused before launching**: a document already
  driven by a live lane, a port outside the published range, `--headed` with no
  display.
- **It prints the equivalent non-interactive command.** The curses version did
  this and it is how its flags got learned.
- **Quitting does not stop lanes.** `q` leaves them running and says so; `Q`
  offers to close them all.
- ANSI over `node:readline` in raw mode. No curses equivalent needed, and no TUI
  framework is worth a dependency for one list and one form.

## 8. Where it lives, and how it is built

**`mcp/packages/headless-launcher/`, package `penpot-headless-mcp-launcher`,
dependencies managed with npm.**

This is part of our MCP kit, alongside `server` and `plugin`, and it is about
the headless worker rather than about any deployment.
`deploy/home-cluster/` is about the *stock containers* and is heading for k8s;
the launcher must keep working across that move, so it cannot live there.

It is **not** in `mcp/pnpm-workspace.yaml` — that lists `common`, `server` and
`plugin` only. Staying out keeps Playwright out of the MCP server's lockfile,
which is why `packages/host` was kept out too, and it is what makes npm and its
`package-lock.json` unremarkable here.

Runtime: **TypeScript, run directly by Node, with no build step and no loader.**

Node strips types natively from 23.6 on; this host is v24.20.0 and
`node src/main.ts` runs unflagged. So the no-build-step goal and real TypeScript
are not in tension, and `tsx` is not needed — `mcp/packages/plugin` already
tests with `node --experimental-strip-types`, so the pattern has a precedent
here. `tsc --noEmit --strict` type-checks in CI and never produces output.

This became easy for a second reason: under the CDP model no launcher code runs
inside a container, so nothing has to care whether a container image can run
TypeScript.

Dependency budget: **`playwright` at runtime, `typescript` in dev, nothing
else.** The supervisor is hand-rolled (§14.1).

## 9. Non-interactive surface

Enough for systemd and scripts; deliberately small.

```
penpot-headless-mcp-launcher                       # the TUI
penpot-headless-mcp-launcher open  [target…]       # open a lane, print its port, exit
penpot-headless-mcp-launcher list  [--json]        # discovery output, no TUI
penpot-headless-mcp-launcher close <port|--all>    # close a lane and reap both halves
```

`open` takes `--account`, `--file-id`, `--team-id`, `--port`, `--mode`,
`--headed`, `--display`, `--browser`. It waits for *connected* so the exit code
means something, with `--no-wait` to opt out.

Account provisioning (`provision-worker` today) moves in as
`penpot-headless-mcp-launcher account <name> [--invite …] [--reset-password]`.

## 10. Configuration

Three layers, most specific wins:

1. **Deployment** — `deployment.json`: compose project directory, MCP service
   name, published port range. The only place that knows Docker exists. Absent
   ⇒ `--mode exec` is unavailable and everything else still works, which is what
   keeps the package honest about k8s and about cloud.
2. **Account** — `accounts/<name>.env`, mode 600, the shape `provision-worker`
   writes today: origin, email, password, MCP token, profile directory.
   Unchanged, so existing files keep working.
3. **Invocation** — flags, then the TUI's saved state.

Secrets live in mode-600 files and reach child processes by `--env-file` or
inherited env, **never on a command line** — a container's argv is world
readable in `ps`, which is how a worker password leaked once.

## 11. Invariants

Each cost real time to learn; each becomes an assertion with a test.

1. A workspace URL needs **`team-id` as well as `file-id`**, or the page loads,
   authenticates, opens the notifications socket, reports no error and renders
   nothing.
2. **Blank ids are refused.** `file-id=` with an empty value silently drives the
   wrong thing.
3. In exec mode **both ports must sit inside the published range**, HTTP and
   WebSocket alike, or the server runs perfectly and nothing can reach it.
4. Busy-port detection reads **`/proc/net/tcp` *and* `tcp6`** — HTTP binds IPv4,
   the WebSocket binds IPv6.
5. Ports are probed **inside the container**; Docker publishes the whole range,
   so every host-side check says "in use".
6. **A `docker compose exec` client dying does not stop what it started.**
   Record the in-container pid; kill it explicitly.
7. The worker talks to **`localhost`, never a LAN address** — hardened session
   cookies are `Secure` and only loopback is trustworthy.
8. **One browser profile per document.** Two workers on one profile directory
   fight over the Chromium lock. *Not enforced today; a real gap.*
9. The REPL is suppressed by aiming **`PENPOT_MCP_REPL_PORT` at a bound port**,
   because the 2.17 bundle has no switch.
10. **Readiness is the plugin WebSocket opening.** The URL, an RPC probe and
    `page.on("response")` all lie.
11. **`isPluginSocket` matches the injected URI's port**, not the default, or a
    healthy lane reports as a timeout.

## 12. Module layout

```
mcp/packages/headless-launcher/
  SPEC.md · README.md
  package.json          bin: penpot-headless-mcp-launcher; deps: playwright
  tsconfig.json         strict, noEmit
  src/
    main.ts             argv → TUI or one non-interactive command; one exit point
    supervisor/
      lane.ts          the state machine of §5
      supervisor.ts    the set of lanes, cancellation scopes, health
      discovery.ts     §6: find and adopt what is already running
    core/
      target.ts        account + file + team → workspace URL   (inv. 1, 2)
      ports.ts         allocation and validation               (inv. 3, 4, 5)
      topology.ts      builtin | exec | local                  (inv. 9, 11)
      config.ts        the three layers of §10
    browser/
      launch.ts        detached chromium with a CDP port       (inv. 7)
      adopt.ts         connectOverCDP, find the workspace tab
      session.ts       cookie, login, profile                  (inv. 8)
      page.ts          open, readiness, reload                 (inv. 10)
    docker/
      compose.ts       exec, /proc probes, in-container pids    (inv. 5, 6)
    penpot/
      rpc.ts           login, teams, files, tokens
    tui/                list · form · fields · render
  test/                 node:test, one file per core module
```

`core/` and `supervisor/lane.ts` are pure and fully tested. `browser/`,
`docker/` and `penpot/` are the I/O edges. `tui/` is a renderer over supervisor
state and holds no logic of its own.

## 13. Testing

- **Pure units**: the URL rewriter against blank, absent and malformed ids; the
  port allocator against a busy list with IPv6-only entries and out-of-range
  requests; the lane state machine against every transition including failure
  and retry.
- **Edges against fixtures**: a captured `/proc/net/tcp` pair, a captured RPC
  response, a captured CDP `/json/version`. No live stack.
- **The survival contract gets its own test**, because it is the whole point:
  open a lane, kill the launcher, assert the browser and the in-container server
  are still alive; start a new launcher, assert it *adopts* rather than
  duplicates; close the lane, assert both halves are gone.
- One opt-in end-to-end smoke against the real deployment that calls
  `execute_code`, which is what `smoke.js` does today.

## 14. Decisions and remaining questions

### 14.1 Supervisor: hand-rolled — decided

Roughly 150 lines over `AbortController` and async generators (§5). Effect is a
large TypeScript-first dependency for a package whose budget is one runtime
dependency, and the lane model is small enough to own. Revisit only if lane
composition outgrows it.

### 14.2 What `q` does to a headed browser — decided

`q` leaves every lane running, headed included, and prints what survived and how
to get back. Consistency wins: a rule of "headless survives, headed does not" is
one more thing to remember at the moment you least want a surprise, and a
visible window announces itself anyway. `Q` closes everything, and the quit
summary marks headed lanes so a forgotten window on a VNC desktop is stated
rather than discovered.

### 14.3 CDP port allocation — decided

**Derive from the MCP port with a configurable offset, default 10000**, so lane
4603 debugs on 14603. One allocator, one range to reason about, and the mapping
is legible in `ps` output. 14601-14608 sits well below Linux's ephemeral range
(32768-60999), so it cannot collide with an outbound socket. The derived port is
still probed before use.

**It binds `127.0.0.1` explicitly.** An open CDP endpoint is unauthenticated
total control of the browser — arbitrary navigation, cookie theft, code
execution in page context. `--remote-debugging-address=127.0.0.1` is not
optional, even on a trusted network.

### 14.4 Does adoption verify the tab — decided, yes

Cheaply, over plain HTTP before Playwright is involved: `GET /json/list` on the
CDP port returns every target with its URL. A lane is adopted only when a
`page` target's URL carries the expected `file-id`. That is one request, needs
no client library, and rejects the realistic accident — some other Chromium
happening to hold a port in our range.

Stricter checks exist (`Browser.getBrowserCommandLine` exposes the
`--user-data-dir`) and are not worth the session setup unless the URL check
proves insufficient.

### 14.5 Container-launched browsers — open, and currently blocked

Verified working: a **host**-launched Chromium with `--remote-debugging-port`,
adopted with `connectOverCDP`, re-adopted after detach, with `browser.close()`
detaching rather than killing. That is the whole model, and it works.

A **container**-launched Chromium does not come up yet: `chrome_crashpad_handler:
--database is required`, because Playwright normally supplies crash-handler
flags that a bare `docker run` does not. Solvable, but the obvious fix — run
Playwright inside the container to do the launching — puts a node process back
in there and with it the question of whether the image can run TypeScript.
Deferred: v1 launches browsers on the host, where version pinning is the only
thing lost, and `--browser container` returns once the flag set is worked out.

### 14.6 `--mode builtin` against cloud — still undriven

If it works, the worker reduces to a browser and a URL and `topology.ts` gets
simpler. Worth resolving before that module is written rather than after.

### 14.7 One account, many documents — open

Invariant 8 wants one profile per document, but the profile holds the session,
so N documents means N logins of the same account. It works; whether a shared
cookie jar with per-document profiles is better is unexplored.
