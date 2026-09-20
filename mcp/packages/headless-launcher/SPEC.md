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

1. **A long-running supervisor with a TUI**, holding many lanes at once, each on
   its own port, in one process, in one terminal.
2. **Total ownership.** Every lane the supervisor creates, it also ends.
   Quitting stops everything. There is no orphan by design.
3. **Nothing ever `exec`s.** The supervisor never replaces itself, so you never
   lose the TUI to the thing it started.
4. **It starts from a clean slate and says so.** Leftovers from a previous run
   are found and reaped, not inherited (§6).
5. **The invariants become tested code**, not comments in a shell script.
6. **No build step.**

## 4. Non-goals

- **Not a container manager.** The `penpot-mcp` container is someone else's;
  the launcher `exec`s into it and nothing more.
- **Not a deployment tool.** `deploy/home-cluster/` owns the stock containers
  and is on its way to k8s. The launcher must not care which it is talking to.
- **Not a manager-style CLI.** A non-interactive path exists for scripting and
  systemd (§9), but the TUI is the product, not a fallback.
- **Not multi-host.** Lanes run where the launcher runs.

## 5. The supervision model

One process owns everything. A lane is a task, not a process:

```
        ┌──────────── penpot-headless-mcp-launcher ─────────────┐
        │  supervisor                                           │
        │    ├── lane 4601  task ──▶ chromium A (child)          │
        │    ├── lane 4603  task ──▶ chromium B (child)          │
        │    └── lane 4605  task ──▶ chromium C (child)          │
        │  TUI renders supervisor state, sends intents           │
        └───────────────────────────────────────────────────────┘
                   │ ExecBackend: compose exec | kubectl exec
                   ▼
        penpot-mcp container/pod: three `node index.js` on 4601/4603/4605
```

Several lanes run concurrently in one Node process as structured concurrency —
coroutines under a parent that can cancel them — not one OS process each. That
is what "not necessarily an OS process" means here: the supervised unit is the
lane, and only its two halves are real processes.

### The execution backend is pluggable

The containers are stock and someone else's, and they are moving from Docker
Compose to Kubernetes. The launcher must not notice. Everything it needs from a
container runtime goes through one interface:

```ts
interface ExecBackend {
  readonly kind: "compose" | "kubectl";
  /** Run a short command in the MCP container and collect its output. */
  run(argv: string[], signal: AbortSignal): Promise<ExecResult>;
  /** Start a long-lived process there; resolves once its in-container pid is known. */
  start(argv: string[], env: Env, signal: AbortSignal): Promise<RemoteProcess>;
  /** Kill an in-container pid (invariant 6 — the exec client dying is not enough). */
  kill(pid: number): Promise<void>;
  /** Ports listening inside the container, IPv4 and IPv6 (invariant 4). */
  listening(): Promise<number[]>;
  /** Make an in-container port reachable locally. */
  expose(port: number, signal: AbortSignal): Promise<Exposure>;
}
```

`expose` is the method that earns the abstraction, because the two runtimes
differ in kind rather than in syntax:

| | **compose** | **kubectl** |
| --- | --- | --- |
| reach a port | already published (`4601-4608`) — `expose` is a no-op | **`kubectl port-forward` — a child process per lane** |
| target | a service name | a pod resolved by label selector, re-resolved each call |
| port constraint | must sit in the published range (invariant 3) | any free in-pod port; the *local* port is ours to choose |
| a restart means | the container keeps its name | the pod name changes |

So under Kubernetes a lane owns **three** things, not two: the in-pod MCP
server, the port-forward, and the browser. That fits the generator unchanged —
one more resource acquired in sequence and released in `finally` — but the
port-forward is the flakiest of the three and needs its own health signal: if it
dies, the lane is `failed` even though both real halves are alive and well.

Invariant 3 is therefore backend-specific and belongs to the backend, not to
`core/ports.ts`: the rule is *the agent must be able to reach the lane's MCP
port*, and each backend says how.

### Ownership is total, and that is the simplification

Browsers are **children**, started with `launchPersistentContext`. MCP servers
live in the container but their in-container pid is recorded and killed on the
way out. Quitting the supervisor ends every lane it opened.

An earlier draft had browsers survive the supervisor and be re-adopted over CDP.
That is dropped. It bought detachment nobody wants, and it cost a second port
range, a tab-verification step, an "is this browser ours" problem, and the loss
of Playwright's own context API. Total ownership removes all four.

### A lane is an async generator

```ts
type LaneEvent =
  | { state: "opening";   detail: string }
  | { state: "connected"; port: number; document: DocumentRef }
  | { state: "failed";    reason: string; log: string[] };

async function* openLane(
  spec: LaneSpec,
  deps: LaneDeps,
  signal: AbortSignal,
): AsyncGenerator<LaneEvent>;
```

The sequence *is* the state machine: the generator yields each transition, and
the supervisor `for await`s it and mirrors the last event into the record the
TUI renders. `deps` carries the I/O edges (docker, penpot rpc, browser) so the
generator is testable with fakes and `core/` stays pure.

Three properties, all load-bearing:

- **Cleanup lives in `finally`, and only runs if the iterator finishes or is
  `.return()`d.** Dropping the reference never runs it. The supervisor therefore
  owns every iterator and always returns it — on abort, on quit, on failure.
  That single discipline replaces the `trap`, the `exec` and the fall-through
  this rewrite exists to delete, and it is what makes goal 2 true rather than
  aspirational.
- **Generators are pull-based**, so a slow consumer stalls the producer at the
  `yield`. Once a lane reaches `connected` the generator stops yielding and
  parks on a promise that settles on abort or failure, while a separate watcher
  pushes health into the record.
- **Shutdown is ordered and bounded.** `.return()` on every lane concurrently,
  each `finally` closing the browser then killing the in-container server, all
  under one deadline. Past it, the remaining pids are killed outright and the
  TUI reports what needed forcing rather than hanging on a wedged browser.

### Lane states

```
  requested ──▶ opening ──▶ connected ──▶ closing ──▶ closed
                    │            │
                    └──▶ failed ─┘
```

- **opening** — server up, browser up, plugin has not dialled yet
- **connected** — the plugin WebSocket is open. The only trustworthy readiness
  signal (invariant 10)
- **failed** — carries a reason and the last log lines; stays listed so the TUI
  can show why, and is retryable in place
- **closing / closed** — both halves reaped, port released

Transitions are the only way state changes, each is logged, and the TUI renders
the machine rather than inferring it from side effects.

## 6. Startup hygiene

The supervisor does not adopt anything. It does check, before drawing, whether a
previous run left wreckage — because a `SIGKILL`, a crashed terminal or a
laptop lid can end a process without running any `finally`.

1. **In-container servers.** `docker compose exec penpot-mcp`, read
   `/proc/net/tcp` *and* `/proc/net/tcp6` (invariant 4), and map listening ports
   in the published range to pids.
2. **Stray browsers.** Chromium processes holding one of our profile
   directories.

Anything found is reported as a **leftover**, never as a lane, and offered for
one-key reaping:

```
  2 leftovers from a previous run
    :4601  node index.js   in penpot-mcp, pid 348      [r] reap  [i] ignore
    :4603  chromium        profile-fdbdf01d, pid 91204 [r] reap  [i] ignore
```

Ignoring is allowed — they might be someone else's — but they are never counted
as lanes, never supervised, and the ports they hold are excluded from
allocation. This is hygiene, not inheritance: the supervisor's list contains
only what it started.

## 7. The TUI

One screen, two regions.

```
  LANES                                                     penpot-headless-mcp-launcher
  port  state       document              account       browser   uptime
  4601  connected   LLM session viewer    mcp-worker    headed    2h14m
  4603  connected   diagrams              mcp-worker    headless  11m
  4605  failed      onboarding            mcp-worker    headless  —
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
- **Quitting stops everything, and says so first.** `q` shows what will be
  closed and asks once; `q` again, or `--yes`, skips the prompt. There is no
  "leave it running" — the supervisor owns what it started (§3.2), and a lane
  that outlived its supervisor would be exactly the leftover §6 exists to clean
  up.
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

This became easy for a second reason: v1 launches browsers on the host (§14.3),
so no launcher code runs inside a container and nothing has to care whether an
image can run TypeScript.

Dependency budget: **`playwright` at runtime, `typescript` in dev, nothing
else.** The supervisor is hand-rolled (§14.1).

## 9. Running without a TUI

The supervisor is the product; the TUI is its face. Both survive without the
other, but the process is the same long-running thing either way.

```
penpot-headless-mcp-launcher                    # supervise, with the TUI
penpot-headless-mcp-launcher --no-tui [lanes…]  # supervise, logging to stdout
penpot-headless-mcp-launcher --check            # report leftovers and exit
```

`--no-tui` is the systemd shape: open the lanes named on the command line or in
the config, hold them, log transitions, and shut them all down on `SIGTERM`. It
is not a different program and not a different code path — the same supervisor
with a log writer where the renderer would be.

A lane is named with `--account`, `--file-id`, `--team-id`, and optionally
`--port`, `--mode`, `--headed`, `--display`. Repeat the group for more lanes.

There is deliberately **no `open` or `close` subcommand**: a one-shot process
that starts a lane and exits is precisely the detached model that was dropped,
and it would leave something nobody owns.

Account provisioning (`provision-worker` today) is the one genuinely separate
job and stays a subcommand:
`penpot-headless-mcp-launcher account <name> [--invite …] [--reset-password]`.

## 10. Configuration

Three layers, most specific wins:

1. **Deployment** — `deployment.json`, which selects and configures the exec
   backend and is the only place that knows a container runtime exists:

   ```json
   { "backend": "compose", "projectDir": "../../deploy/home-cluster",
     "service": "penpot-mcp", "portRange": [4601, 4608] }
   ```
   ```json
   { "backend": "kubectl", "context": "home", "namespace": "penpot",
     "selector": "app=penpot-mcp", "localPortRange": [4601, 4608] }
   ```

   Absent ⇒ `--mode exec` is unavailable and everything else still works, which
   is what keeps the package honest about cloud.
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
3. In exec mode **the agent must be able to reach the lane's MCP port**, HTTP
   and WebSocket alike, or the server runs perfectly and nothing can reach it.
   How is the backend's business: compose requires both ports inside the
   published range; kubectl requires a live port-forward.
4. Busy-port detection reads **`/proc/net/tcp` *and* `tcp6`** — HTTP binds IPv4,
   the WebSocket binds IPv6.
5. Ports are probed **inside the container**, never from the host. Docker
   publishes the whole range, so every host-side check says "in use"; under
   kubectl the host cannot see them at all.
6. **An exec client dying does not stop what it started**, with either backend.
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
      leftovers.ts     §6: find wreckage from a previous run, reap on request
    core/
      target.ts        account + file + team → workspace URL   (inv. 1, 2)
      ports.ts         allocation and validation               (inv. 3, 4, 5)
      topology.ts      builtin | exec | local                  (inv. 9, 11)
      config.ts        the three layers of §10
    browser/
      launch.ts        launchPersistentContext, owned as a child (inv. 7)
      session.ts       cookie, login, profile                  (inv. 8)
      page.ts          open, readiness, reload                 (inv. 10)
    docker/
      compose.ts       exec, /proc probes, in-container pids    (inv. 5, 6)
    penpot/
      rpc.ts           login, teams, files, tokens
    tui/                list · form · fields · render
  test/                 node:test, one file per core module
```

`core/`, `supervisor/lane.ts` and `exec/procnet.ts` are pure and fully tested.
`browser/`, the `exec/` backends and `penpot/` are the I/O edges. `tui/` is a renderer over supervisor
state and holds no logic of its own.

## 13. Testing

- **Pure units**: the URL rewriter against blank, absent and malformed ids; the
  port allocator against a busy list with IPv6-only entries and out-of-range
  requests; the lane state machine against every transition including failure
  and retry.
- **Edges against fixtures**: a captured `/proc/net/tcp` pair (including an
  IPv6-only WebSocket port), a captured `get-teams` / `get-team-recent-files`
  response, and a transcript per backend. No live stack.
- **Both backends run the same suite.** `ExecBackend` gets one contract test —
  start a process, see its port in `listening()`, expose it, kill it, see the
  port released — run against a fake, against compose, and against kubectl when
  a cluster is configured. That is what keeps the k8s move from being a rewrite.
- **The ownership contract gets its own test**, because it is the whole point:
  open two lanes, quit, and assert that both browsers and both in-container
  servers are gone and both ports are free. Then the ugly half: `SIGKILL` the
  supervisor, restart it, and assert the leftovers are *reported* (§6) rather
  than adopted, counted or silently reused.
- One opt-in end-to-end smoke against the real deployment that calls
  `execute_code`, which is what `smoke.js` does today.

## 14. Decisions and remaining questions

### 14.1 Supervisor: hand-rolled — decided

Roughly 150 lines over `AbortController` and async generators (§5). Effect is a
large TypeScript-first dependency for a package whose budget is one runtime
dependency, and the lane model is small enough to own. Revisit only if lane
composition outgrows it.

### 14.2 Ownership and quitting — decided

The supervisor owns every lane it opens and ends all of them on quit, headed and
headless alike. Detachment, CDP adoption and per-lane debugging ports are all
dropped with it; what remains of that idea is §6, which reports wreckage from a
previous run instead of inheriting it.

Measured before dropping it, so the option is costed rather than guessed: a
host-launched Chromium with `--remote-debugging-port` does adopt cleanly,
re-adopt after detach, and survive `browser.close()` — the model worked. It was
dropped because it is not wanted, not because it is impossible. A
container-launched one additionally needed crash-handler flags that a bare
`docker run` does not supply.

### 14.3 Container-launched browsers — deferred

v1 launches browsers on the host with `launchPersistentContext`. The container
path (`--browser container`, today's image-pinned browser) needs the crashpad
flags worked out and is worth revisiting only if host Playwright drifts from the
image often enough to matter.

### 14.4 Port-forward supervision — open

Under kubectl a lane's reachability is a child process that can die on its own,
and `kubectl port-forward` is known to drop on pod restarts and idle timeouts.
Restarting it transparently keeps the lane alive but hides a real fault;
failing the lane is honest but noisy. Proposed: restart it a bounded number of
times, surface the count in the TUI row, and fail the lane once it is exhausted.
Undecided until there is a cluster to measure against.

### 14.5 `--mode builtin` against cloud — still undriven

If it works, the worker reduces to a browser and a URL and `topology.ts` gets
simpler. Worth resolving before that module is written rather than after.

### 14.6 One account, many documents — open

Invariant 8 wants one profile per document, but the profile holds the session,
so N documents means N logins of the same account. It works; whether a shared
cookie jar with per-document profiles is better is unexplored.

### 14.7 The name — open, and not urgent

`penpot-headless-mcp-launcher` names the first half of the job. The thing
launches lanes and then supervises them for as long as it runs, and the second
half is where the design effort went. Keeping it is defensible — it is what you
type, and the first thing it does is launch — but `-supervisor`, or dropping the
verb entirely for `penpot-headless-mcp`, both describe it better. Cheap to
change before there is code; annoying after.
