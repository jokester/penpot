# mcp-headless — architecture and spec

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

## 3b. Scope: v1 implements `exec` against self-hosted, and only that

The driving goal is **decoupling the worker from the operator's own interactive
tabs**. That single requirement decides the mode:

| mode | decoupled from your tabs? | why |
| --- | --- | --- |
| `builtin` | **no** | routes by the account's `userToken`; one token is one plugin slot, so a worker and a human tab contend for it |
| `exec` | yes | its own single-user server per lane; the token is never used |
| `local` | yes | same, but needs a build, and is broken against 2.17 today |
| `image` | yes | same, but needs a container of your own — redundant where you already control the containers |

So `exec` is not a default among equals; it is the only mode that meets the goal
without a build or an extra container. v1 implements it and nothing else.

**The other modes stay in the map and in the types.** `Mode` remains the full
union and `core/topology.ts` wires all four, because that part is pure, cheap,
and is the map made executable. What v1 omits is the *lane* implementation for
the other three, which fails with a reason naming this section rather than a
`TODO`. Two of them are small when wanted: `builtin` is a one-half lane needing
no backend at all, and `image` is a third `ExecBackend` beside `compose` and
`kubectl`.

Deferring them is not a bet that they are unimportant. `ARCHITECTURE.md` §4
exists precisely so the next person can see what was left on the table and why,
rather than rediscovering the axis.

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
        ┌──────────────────── mcp-headless ────────────────────┐
        │  supervisor                                          │
        │    ├── lane 4601  task ──▶ chromium A (tab)          │
        │    ├── lane 4603  task ──▶ chromium A (tab)          │
        │    └── lane 4605  task ──▶ chromium B (tab, headed)  │
        │  TUI renders supervisor state, sends intents         │
        └──────────────────────────────────────────────────────┘
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

`expose` is the method that earns the abstraction, but **not** because
Kubernetes needs a tunnel. It earns it because "how does this port become
reachable" has a different answer per deployment, and the launcher should ask
rather than assume:

| | **compose** | **kubectl** |
| --- | --- | --- |
| target | a service name | a pod resolved by label selector, re-resolved each call |
| a restart means | the container keeps its name | the pod name changes |
| port constraint | inside the published range (invariant 3) | any free in-pod port |
| reachability | already published | **depends on the deployment, not on kubectl** |

### Exposure is a deployment property, not a launcher job

Two things need to reach a lane's ports, and they sit in different places:

- **the browser → the WebSocket port.** The browser runs wherever the launcher
  runs, so this is reachable whenever the launcher shares a network with the
  pod.
- **the agent → the HTTP port.** The agent runs on someone's laptop. That is an
  ingress question, it is already solved with an SSH forward today, and moving
  to Kubernetes does not change it.

So `kubectl port-forward` is needed in exactly one topology — launcher outside
the cluster, ports not otherwise exposed — and is the worst of the options
because it adds a flaky child process per lane. The configured strategy is:

| `exposure` | when | what `expose` does |
| --- | --- | --- |
| `none` *(default)* | compose published range; `hostNetwork` pod on the launcher's node; NodePort; launcher running in-cluster | **nothing but verify.** Connect once and fail the lane early if the port is unreachable |
| `port-forward` | laptop with a remote cluster and no exposure for these ports | spawn `kubectl port-forward` as a lane-owned child, and supervise it |

Default `none`, because the deployments that matter here all satisfy it. This
host already runs a `k3s agent`, so the likely shape after the migration is the
launcher on a node beside the pod — the same position it has today relative to
the container, and the same no-op `expose`.

### Why node-local ports matter more than reachability

A NodePort (or `hostPort`, or `hostNetwork`) does not merely make the port
reachable. It makes it reachable **as `localhost` on the node**, and that is
what keeps invariant 7 satisfied.

The rule is not really about the MCP port — it is about the origin the browser
loads Penpot from. Hardened session cookies are `Secure`, so the browser keeps
them only for a trustworthy origin: `http://localhost:9001` qualifies,
`http://10.43.x.y:9001` does not, and the cookie is dropped silently while login
appears to succeed. So the frontend, not just the MCP server, has to arrive on
the node's loopback. A tunnel would satisfy that too — the only reason
`port-forward` was ever a candidate — but a node-local Service satisfies it with
no moving parts.

One caveat to verify on the real cluster rather than trust from here:
**NodePort answering on `127.0.0.1` is kube-proxy behaviour, not a guarantee.**
iptables mode has historically allowed it by setting
`net.ipv4.conf.all.route_localnet=1`; nftables mode does not, and the behaviour
has been treated as a wart to remove. `hostPort` and `hostNetwork` bind the node
directly and are deterministic. On the node:

```sh
kubectl -n penpot get svc penpot-mcp -o wide
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<nodePort>/mcp
```

If that answers, `exposure: "none"` is right and nothing else is needed. If it
does not, prefer `hostPort` over a tunnel.

A third shape is worth noting because it is the tidiest: **the launcher as a
sidecar in the MCP pod.** The WebSocket is then `localhost` inside the pod,
which satisfies invariant 7 by construction rather than by careful arrangement,
and nothing needs exposing for the browser at all. It costs headed mode, which
wants a display the pod does not have.

**Both halves of a lane are exposed together.** `expose` takes the pair, not a
port: the agent connects to the HTTP port and the browser dials the WebSocket,
and a lane with only the first forwarded opens, answers, and never becomes
ready.

**A local range need not be the container's.** `upstreamPortRange` maps one
onto the other by a constant offset, for the case where the range you want is
taken on the host running the launcher. Measured: an unrelated Docker stack
held 127.0.0.1:4601-4616 on this host, accepted connections and reset them.

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

### Lanes share a browser; each owns a tab

A lane does **not** get a Chromium. It gets a **page** in a browser shared with
every other lane on the same account and mode. Measured on this host:

| | RSS |
| --- | --- |
| browser + first tab | 527 MB |
| each additional tab | **94 MB** |
| 3 lanes as tabs | ≈ 715 MB |
| 3 lanes as separate browsers | ≈ 1581 MB |

Two things had to be true for this, and both were measured rather than assumed:

- **Per-page injection works.** `page.addInitScript()` runs before page scripts
  and is scoped to that page, so three tabs in one context booted with three
  different `window.penpotMcpServerURI` values. This is the whole trick: the
  injected URI is what binds a tab to its MCP server (invariant 11), and it
  turns out to be per-tab, not per-browser.
- **Background tabs are not throttled** under the existing no-throttle flags:
  three tabs each ticked 30 times in 3 s, the two backgrounded ones included.
  That matters because a throttled tab stops sending heartbeats and the server
  reports it as suspended — the error that cost a day once already.

The pool is keyed by **(account, headed, browser flavour)**, because those are
the things a browser cannot vary per tab: the profile holds one session, and
headed and headless are different processes. One worker account driving five
documents headless is therefore one Chromium with five tabs. A browser is
created with its first lane and closed with its last.

**This dissolves invariant 8.** "One profile per document" existed only because
one Chromium per lane meant N processes contending for one profile directory.
Sharing the instance removes the contention and the workaround together.

The cost is shared fate: if the browser dies, every lane on it fails at once.
The supervisor watches `context.on("close")` and fails that group together,
which is at least honest — with one browser per lane the same crash produced a
single mysteriously dead lane.

### A lane is a plain async function

```ts
async function runLane(
  spec: LaneSpec,
  deps: LaneDeps,
  onEvent: (e: LaneEvent) => void,
  signal: AbortSignal,
): Promise<void>;
```

An async generator yielding transitions was the first design and is dropped. It
looked elegant, but the value it adds is cleanup attached to acquisition — and
that comes from `try/finally`, not from `yield`:

```ts
const server = await deps.backend.start(argv, env, signal);
try {
  const exposure = await deps.backend.expose(server.port, signal);
  try {
    const page = await deps.browsers.lease(spec, signal);
    try {
      onEvent({ state: "connected", ... });
      await until(signal);            // park here for the life of the lane
    } finally { await page.close(); }
  } finally { await exposure.close(); }
} finally { await deps.backend.kill(server.pid); }
```

A plain function gets the same guarantee with none of the generator's problems.
It is not pull-based, so a slow renderer cannot stall a lane. There is no rule
that the supervisor must remember to call `.return()` or leak every resource.
And the awkward part of the generator design — that after `connected` it stops
yielding and parks on a promise — stops being awkward once you admit that a
thing which emits a few events and then waits is just a function.

Transitions go out through `onEvent`, which the supervisor mirrors into the
record the TUI renders. `deps` carries the I/O edges (backend, browser pool,
penpot rpc) so lanes are testable with fakes and `core/` stays pure.

Two properties remain load-bearing:

- **Cancellation is the only way out.** `signal` is passed to every await and
  to every child; aborting unwinds the stack and every `finally` runs in
  reverse order of acquisition. That single discipline replaces the `trap`, the
  `exec` and the fall-through this rewrite exists to delete.
- **Shutdown is ordered and bounded.** Abort all lanes concurrently under one
  deadline. Past it, remaining pids are killed outright and the TUI reports what
  needed forcing rather than hanging on a wedged browser.

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
  LANES                                                     mcp-headless
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
  → mcp-headless --account mcp-worker --file-id fdbd… --port 4607 --headed
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

**`mcp/packages/headless/`, package `@penpot/mcp-headless`, managed with pnpm.**

This is part of our MCP kit, alongside `server` and `plugin`, and it is about
the headless worker rather than about any deployment.
`deploy/home-cluster/` is about the *stock containers* and is heading for k8s;
the launcher must keep working across that move, so it cannot live there.

It is **not** a member of `mcp/pnpm-workspace.yaml` — that lists `common`,
`server` and `plugin` only. Staying out keeps Playwright out of the MCP
server's lockfile, which is why `packages/host` was kept out too. It does carry
the repo-wide `packageManager` field, without which `corepack use` stamps an
ancestor and this package never gets swept by a pnpm version update.

An earlier draft of this section said npm and a `package-lock.json`. That was
wrong twice over. The repo routes every dependency change through pnpm
(`mem:workflow/updating-pnpm`), so npm would add a third package manager and a
lockfile format that neither `scripts/clean-node-modules` nor the version sweep
knows about. And a directory that is neither a workspace member nor a workspace
root gets no lockfile at all: pnpm walks up, finds `mcp/pnpm-workspace.yaml`,
installs *that* workspace's four projects, and skips this one in silence. So
the package declares its own `pnpm-workspace.yaml`. That is what makes it a
root, points it at the shared store, and turns a plain `pnpm install` here into
the obvious thing. `packages/host` never did it, which is why its committed
lockfile can only have come from an `--ignore-workspace` run that nothing
records.

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
mcp-headless                    # supervise, with the TUI
mcp-headless --no-tui [lanes…]  # supervise, logging to stdout
mcp-headless --check            # report leftovers and exit
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

Account provisioning is the one genuinely separate job, and it is a subcommand:
`mcp-headless provision-worker-user --email E [--invite …] [--reset-password]
[--mint-token] [--name …] [--full-name …] [--origin …] [--file-name …]`. The
supervisor is named `server` beside it, and the bare invocation stays a synonym
for `server` -- it is in shell history and in MCP client configuration, which is
the thing this package exists to hold still.

Three rules the command follows, each of them a way it can do damage:

- **The password is never a flag.** It is read from
  `$MCP_HEADLESS_WORKER_PASSWORD`, then from the account file already there, and
  generated only if neither has it. `--password` is refused rather than ignored,
  so nobody believes a password in their shell history was used safely. It
  reaches `manage.py` on stdin, never on argv.
- **An existing profile keeps its password** unless `--reset-password` says
  otherwise; a generated password against an existing profile is refused, since
  the login that followed would fail for a reason nobody would guess.
- **An existing MCP token is kept** unless `--mint-token` says otherwise:
  minting deletes the previous one and breaks MCP wherever it is in use. A
  profile created a moment ago has none, so there minting is free and silent.

Creating the profile is the one step that shells into a container. There is no
RPC command for it -- self-registration is off on a private instance and a
worker has no mailbox to confirm from -- so provisioning runs `manage.py` in the
admin container (`adminService`, default `penpot-backend`) and talks RPC for
everything after.

## 10. Configuration

Three layers, most specific wins:

0. **The deployment as a whole** — `conf.yaml`, which describes the instance,
   the worker pool, the façade's address, the exec backend and the browser in
   one file a person writes by hand. No secrets live in it: a worker's password
   and MCP token stay in `accounts/<name>.env`. Unknown keys are refused rather
   than ignored. Where it and `deployment.json` speak about the same thing, the
   YAML wins; flags beat the file, and the file beats `$HOST` and `$PORT`,
   because an environment variable is ambient and the file was written for this
   deployment on purpose.
1. **Deployment** — `deployment.json`, the older spelling of `conf.yaml`'s
   `mcpBackend` alone, still read so an existing configuration keeps working:

   ```json
   { "backend": "compose", "projectDir": "../../deploy/home-cluster",
     "service": "penpot-mcp", "adminService": "penpot-backend",
     "portRange": [4601, 4608] }
   ```
   ```json
   { "backend": "kubectl", "context": "home", "namespace": "penpot",
     "selector": "app=penpot-mcp", "localPortRange": [4601, 4608] }
   ```

   Absent ⇒ `--mode exec` is unavailable and everything else still works, which
   is what keeps the package honest about cloud.
2. **Account** — `accounts/<name>.env`, mode 600, written by
   `provision-worker-user`: origin, email, password, MCP token, profile
   directory. The shape is the one the old `provision-worker` wrote, so existing
   files keep working.
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
   How is the deployment's business, declared as an `exposure` strategy, not
   inferred: compose requires both ports inside the published range; a cluster
   requires either that the launcher shares a network with the pod, or an
   opt-in port-forward.
4. Busy-port detection reads **`/proc/net/tcp` *and* `tcp6`** — HTTP binds IPv4,
   the WebSocket binds IPv6.
5. Ports are probed **inside the container**, never from the host. Docker
   publishes the whole range, so every host-side check says "in use"; under
   kubectl the host cannot see them at all.
6. **An exec client dying does not stop what it started**, with either backend.
   Record the in-container pid; kill it explicitly.
7. The worker talks to **`localhost`, never a LAN address** — hardened session
   cookies are `Secure` and only loopback is trustworthy.
8. **One Chromium per profile directory, never two.** Two instances on one
   profile fight over the lock. Sharing a browser between lanes (§5) satisfies
   this by construction, which is why the old "one profile per document" rule is
   gone rather than enforced.
9. The REPL is suppressed by aiming **`PENPOT_MCP_REPL_PORT` at a bound port**,
   because the 2.17 bundle has no switch.
10. **Readiness is the plugin WebSocket opening.** The URL, an RPC probe and
    `page.on("response")` all lie.
11. **`isPluginSocket` matches the injected URI's port**, not the default, or a
    healthy lane reports as a timeout.

## 12. Module layout

```
mcp/packages/headless/
  SPEC.md · README.md
  package.json          bin: mcp-headless; deps: playwright
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
      pool.ts          browsers keyed by account+mode, leased per lane (§5)
      launch.ts        launchPersistentContext, owned as a child (inv. 7)
      session.ts       cookie, login, profile                  (inv. 8)
      page.ts          open, readiness, reload                 (inv. 10)
    exec/
      backend.ts       the ExecBackend interface and its factory
      procnet.ts       /proc/net/tcp and tcp6 parsing           (inv. 4)
      compose.ts       docker compose exec, in-container pids   (inv. 5, 6)
    penpot/
      rpc.ts           login, teams, files, tokens
    tui/                list · form · fields · render
```

Tests sit beside the code as `*.test.ts`, which is what `packages/server` and
`packages/plugin` do. `node --test 'src/**/*.test.ts'` runs them.

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
- **Per-tab injection is a regression test**, because the shared browser rests
  on it: three pages in one context, three different injected URIs, each read
  back from its own page. It is one assertion and it protects the whole pool.
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

## 13b. Diagnostics — specified, not built

`mcp/packages/host/spikes/` answered three questions the launcher cannot. They
go at cutover, and nothing replaces them yet. This is the specification, so the
capability is not lost with the code.

`--check` already reports leftovers, and the façade already distinguishes a
plugin that never dialled from one whose socket closed. What is missing is
everything about an account *before* a lane is attempted.

**`mcp-headless doctor [--account NAME]`** — one read-only command, exit 0 when
it finds nothing wrong, non-zero and specific when it does. It should answer, in
this order, because each answer makes the next meaningful:

1. **Configuration.** Is there a deployment? Does its `portRange` match what the
   compose file publishes? That pair is declared twice and checked nowhere, and
   a mismatch surfaces much later as "outside the published range".
2. **Reachability.** Does the container answer, and how many lanes does the
   published range allow? Is the instance's own MCP endpoint answering?
3. **The account.** Does the profile hold a session, and does it still
   authenticate — the old `verify` spike's question, which matters because a
   cookie can be present and stale. Does the account have an MCP token, and does
   that token authenticate the REST API?
4. **The document list.** Can teams and files be listed, and how many are there?
   An empty list with a working token means the worker was never invited.
5. **A lane, end to end** (opt-in, because it costs 10-20 seconds and opens a
   browser). Open one, call `execute_code`, close it — the old `smoke` spike.

The old `diagnose` spike additionally dumped browser console output and the
profile's `mcp-enabled` prop. Console capture is worth keeping as a flag; the
profile prop is reachable through the REST API now and belongs in step 3.

Nothing here needs a lane except step 5, which is what makes the command useful
when a lane is exactly what will not start.

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

### 14.3 Container-launched browsers — deferred, and worth keeping described

v1 launches browsers on the host with `launchPersistentContext`. The launcher
pins `playwright` to an exact version, so the browser build is already fixed by
the lockfile rather than by whatever is installed — which was most of the reason
the container path existed.

What it bought on top, and what would have to be rebuilt to get it back:

- **The version comes from an image tag, not a lockfile plus an install step.**
  `run-mcp-worker --browser container` ran the browser inside the pinned
  Playwright image, overridable with `PENPOT_WORKER_IMAGE`. A fresh machine
  needed no `pnpm exec playwright install`, and two machines could not drift.
- **Headed still worked**, by mounting the host's X socket into the container so
  it drew on the operator's display. That was measured working, not assumed.
- **The browser's dependencies stayed off the host** — useful where the host is
  not the operator's workstation.

Against that: the container needs `--no-sandbox` or a suitable seccomp profile,
the crashpad flags have to be worked out, and the profile directory has to be
mounted so a session survives. It is worth revisiting only if the pinned
Playwright proves awkward to install somewhere it matters.

This is recorded here because `deploy/home-cluster/run-mcp-worker` is deleted at
cutover, and its `--browser container` implementation is the only description of
how this was made to work.

### 14.4 Port-forward supervision — deferred, and probably moot

Only `exposure: "port-forward"` has this problem, and that is not the default
(§5). If it is ever used: `kubectl port-forward` drops on pod restarts and idle
timeouts, restarting transparently hides a real fault, and failing the lane is
noisy. Proposed then — bounded restarts, count visible in the TUI row, fail once
exhausted. Not worth building until a deployment actually needs the strategy.

### 14.5 `--mode builtin` — resolved, both targets

**Self-hosted: verified working**, 2026-09-20. A worker opened with
`--mcp builtin` dialled `ws://localhost:9001/mcp/ws`, an MCP client connected to
`http://localhost:9001/mcp/stream?userToken=…`, and `execute_code` returned the
real document. So builtin is a proven third mode, not a hypothesis, and
`topology.ts` has three real branches rather than two plus a guess.

That has a design consequence worth stating: **a builtin lane has one half, not
two.** No server is started, so there is no port to allocate, no in-container
pid to reap, no exposure to arrange, and `ExecBackend` is not touched at all.
The lane reduces to a browser and a URL. That is also what makes §10's claim
true — with no `deployment.json` at all, builtin still works, which is the mode
that will run against cloud and against whatever replaces the compose file.

Its limits are the familiar ones: the server is shared and multi-user, so the
client must carry `userToken`, and two builtin lanes would contend for the same
server.

**Cloud: verified working, 2026-09-20.** A worker opened `--mcp builtin`
against `design.penpot.app`, its plugin connected to
`wss://design.penpot.app/mcp/ws`, and a client at `/mcp/stream?userToken=…`
returned `{file: "scratch", page: "Page 1", shapes: 1, version: "2.18.0"}` from
a real cloud document. Headless, bundled Chromium, no server of ours.

Two prerequisites turned out to be stale, and one constraint turned out to be
sharper than documented.

**Google Chrome is not required.** Playwright's bundled Chromium loaded the
login page, the authenticated dashboard and the workspace with no Cloudflare
challenge. `config.js` defaults `CHANNEL` to `"chrome"` for non-loopback origins
on the strength of an older measurement; that default, and the claim in
`TOPOLOGIES.md` §6, should be dropped.

**One `userToken` is one plugin slot, and the slot is sticky.** The token belongs
to an account, not a tab, so a human tab and a worker on the same account
compete for it — and the loser is silent. The second connection is *accepted*,
the first registration keeps routing, and the failure surfaces as `the Penpot
plugin tab appears to be suspended`, blaming the browser for server-side
bookkeeping. Reconnecting does not reclaim the slot: across five calls the
reported "last heartbeat" kept pointing at a moment before the current worker
had connected. Regenerating the token — a new routing key — cleared it
instantly, and the very next run worked first time.

Three consequences for this package:

1. **A cloud worker needs its own account**, exactly as the self-hosted worker
   does. Not a workaround: it is the reasoning that produced `mcp-worker@…`,
   applied one layer down.
2. **On cloud, `builtin` does not scale past one lane per account**, because the
   account has one token and the token has one slot. `local` does: each lane
   runs its own single-user server on its own port, which ignores `userToken`
   entirely. So the cloud shape for more than one document is `--mode local` —
   the mirror image of self-hosted, where `exec` scales and `builtin` does not,
   for the same underlying reason.
3. **The supervisor must refuse a second `builtin` lane on one account** and say
   why, rather than let it half-work. Silent half-working is the whole problem.

### 14.6 One account, many documents — decided

One browser per account, one tab per document, one login. The old worry — that
N documents meant N profiles and N logins of the same account — was an artifact
of one Chromium per lane and disappears with it (§5).

Two accounts still mean two browsers, because a persistent profile holds exactly
one session. If that ever becomes common, `chromium.launch()` with a context per
account and sessions kept as `storageState` would collapse them into one
process; not worth it for one worker account.

### 14.7 The name — decided

**Directory `mcp/packages/headless`, package `mcp-headless`.**

Dropping the verb was right: "launcher" named the first half of a job whose
second half — supervising lanes for as long as the process runs — is where the
design went. A noun describes it better than a verb, and `mcp/packages/headless`
stops the directory stuttering `mcp` at itself.

The package name follows the siblings rather than the originally proposed
`penpot-headless-mcp`. `common`, `plugin` and `server` are `mcp-common`,
`mcp-plugin` and `mcp-server`: bare directory noun, `mcp-` prefix, unscoped,
private. `@penpot/mcp-host` is the one exception, it is ours, inherited from the
spike, and about to be deleted. **If this is ever published to npm the name must
change** — `mcp-headless` is far too generic for a public registry — and
`penpot-headless-mcp` is the right public name at that point. One line, until
something imports it.

One honest wrinkle: the package supports `--headed`, and its most-used
debugging mode is a visible browser on a VNC display. "Headless" here means
*unattended* — no human keeping a tab open — which is how this project has used
the word since the `exp/headless-mcp` branch and the original host README. The
established meaning beats the literal one.
