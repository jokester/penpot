# penpot-worker — architecture and spec

Status: **proposed**. Nothing is implemented yet; this document is the thing to
argue with before any code exists.

## 1. Why replace what works

The worker itself is settled. What surrounds it is not:

| file | lines | language | role |
| --- | --- | --- | --- |
| `deploy/home-cluster/run-mcp-worker` | 404 | bash | launcher: ports, server lifecycle, browser, cleanup |
| `deploy/home-cluster/run-mcp-worker.py` | 514 | python + curses | interactive front end that shells out to the above |
| `deploy/home-cluster/provision-worker` | 178 | python | worker accounts, invitations, MCP tokens |
| `mcp/packages/host/host.js` + `config.js` | 233 | node | the browser itself |
| `mcp/packages/host/spikes/*.js` | 465 | node | login, diagnostics, and four historical probes |

Three languages, two directories, one job. The costs are not aesthetic:

- **The seams are where the bugs live.** Every defect this month sat on a
  boundary: bash computing a port that only the container can validate, bash
  exporting env that `config.js` reads by a name written in a third file, a
  `trap` in bash meant to reap a process inside Docker. Four of them shipped and
  had to be fixed — an IPv6-blind port probe, an `exec` that discarded cleanup,
  the fall-through that spawned a second browser, and a `--port` that started an
  unreachable server.
- **Nothing is testable.** 1 100 lines of bash and python with no test of any
  kind. The port allocator and the URL rewriter are pure functions that were
  each wrong in production.
- **The Python front end can only express what the bash flags allow**, so every
  new capability is edited into two files, in two languages, twice.
- **Running workers are invisible.** There is no inventory: finding them means
  `ps`, `/proc/<pid>/environ`, and `docker compose exec … /proc/net/tcp`.
- **The picker replaces itself with the thing it launched.**
  `run-mcp-worker.py:510` ends in `os.execvpe`, so the TUI *becomes* the bash
  script, which in turn becomes the browser's parent. Everything is then welded
  into one process chain and one terminal: closing the picker, losing the shell
  or hitting the wrong key takes the browser with it, and there is no way back
  to the picker without killing the worker. This is the worst of the five.

## 2. Goals

1. **One package, one language, one entry point.** `penpot-worker <command>`.
2. **The invariants become code with tests**, not comments in a shell script.
3. **The launcher never replaces itself.** No `exec`, at any layer. A worker
   outlives the thing that started it, and the picker survives the worker.
4. **Running workers are addressable** — list them, stop them, read their logs,
   reattach from a new terminal.
5. **The interactive picker is a view over the same core**, not a second
   implementation that shells out to the first.
6. **No build step.** The container mounts the repo read-only and runs `node`
   directly; a `dist/` would break that and add a stale-artifact failure mode.

## 3. Non-goals

- Not a supervisor. No restart policies, no daemon. A worker is a foreground
  process; `systemd --user` or the TUI owns longevity.
- Not a Penpot admin tool. `provision` covers worker accounts only.
- Not multi-host. Everything assumes the workers run where the CLI runs.
- **Not an upstream contribution.** See §4.

## 4. Where it lives

**Proposed: `deploy/home-cluster/mcp-worker/`,** absorbing `mcp/packages/host/`
entirely.

The repository is a clone of upstream `penpot/penpot`. Everything we have added
must be excisable before any PR, and today that means remembering two places —
`deploy/home-cluster/` and `mcp/packages/host/`. Consolidating leaves **one**
directory to quarantine.

The alternatives, and why not:

- **`mcp/packages/worker/`** (grow the existing host package). Honest about what
  the thing is, and a natural sibling of `server` and `plugin`. But it keeps two
  quarantine zones and adds weight to upstream's tree.
- **`tools/penpot-worker/`** — a *new* top-level directory in someone else's
  repository. Strictly worse for the same reason.
- **A separate repository.** The right long-term answer, and the one to take
  when this stops changing daily. Until then the code and the compose file it
  drives are edited together, and splitting them adds a sync problem.

The path says `home-cluster`, which is a mild lie when the target is cloud. The
package takes its deployment coupling as configuration (§8), so the name is the
only thing that is wrong, and a directory rename is cheap.

## 5. Language and runtime

**Node ≥ 22, plain JavaScript with JSDoc types, checked by `tsc --checkJs`.**

- JS, not TS: no build step (§2.5), and the browser half is already JS.
- Types anyway: the bugs were type-shaped — a port that was a string, an id that
  was empty, a URL that was `undefined`. `checkStrict` in CI catches those.
- Dependencies: **`playwright` only** at runtime. The TUI is written against
  `node:readline` and ANSI escapes rather than a framework, matching what the
  curses version already proved is enough.
- Test runner: `node:test`. Already a devDependency pattern in this repo.
- Kept out of the `mcp/` pnpm workspace, exactly as `packages/host` is today, so
  Playwright stays out of the MCP server's lockfile.

## 6. What is absorbed, and what is dropped

| source | disposition |
| --- | --- |
| `run-mcp-worker` | → `src/commands/run.js` + `src/core/*` |
| `run-mcp-worker.py` | → `src/tui/` |
| `provision-worker` | → `src/commands/provision.js` |
| `host.js`, `config.js` | → `src/browser/` |
| `spikes/login.js` | → `src/commands/login.js` |
| `spikes/diagnose.js`, `verify.js` | → `src/commands/doctor.js` |
| `spikes/spike-pat.js`, `spike-pna.js`, `spike-ws.js` | **deleted** |

The three deleted spikes are one-shot experiments whose conclusions are already
written down — PAT auth cannot carry the notifications socket, Private Network
Access needs a scoped grant, cookie auth gives a working socket. The findings
live in `mcp/packages/host/HANDOFF.md` §4 and `TOPOLOGIES.md` §7. Keeping the
probes as runnable code implies they are maintained, and they are not.

## 7. Command surface

```
penpot-worker                      # no args → the picker (§12)
penpot-worker start [target]       # detached worker; prints its id and exits
penpot-worker run [target]         # same, but in the foreground (Ctrl-C stops)
penpot-worker ps                   # running workers, their ports and documents
penpot-worker logs <id> [-f]       # a detached worker's output
penpot-worker stop <id|--all>      # stop, and reap what it left behind
penpot-worker ls                   # teams and documents the account can see
penpot-worker doctor [id]          # why is a worker not connected
penpot-worker login [account]      # put a session in the browser profile
penpot-worker provision <account>  # create/repair a worker account
```

`start` and `run` differ only in who owns the process. `run` is for watching one
worker in a terminal; `start` is what the picker uses, and what a `systemd
--user` unit would wrap. Both take the same target.

`run` keeps today's flags (`--mcp`, `--browser`, `--headed`, `--file-id`,
`--team-id`, `--port`, `--profile`, `--multi-user`, `--repl`) and adds
`--account` in place of `--env-file`, because an account is the concept and the
env file is how it happens to be stored.

`ps` and `stop` are new and are the point of the rewrite: today a worker that
dies badly leaves a server inside a container that only `/proc` will show you.

## 8. Configuration

Three layers, most specific wins:

1. **Deployment** — `deployment.json` beside the compose file: compose project
   directory, service name for the MCP container, published port range. This is
   the only place that knows about Docker. Absent ⇒ `--mcp exec` is unavailable
   and the rest still works, which is what makes the package usable against
   cloud.
2. **Account** — `accounts/<name>.env`, mode 600, exactly the shape
   `provision-worker` writes today: origin, email, password, MCP token, profile
   directory. Unchanged so existing files keep working.
3. **Invocation** — flags, then the picker's saved state.

Secrets stay in mode-600 files and are passed to child processes by `--env-file`
or inherited env, **never on a command line** — a container's argv is world
readable in `ps`, which is how the worker's password ended up there once.

## 9. Invariants the implementation must preserve

Each cost real time to learn. Each becomes an assertion with a test.

1. **A workspace URL needs `team-id` as well as `file-id`.** With only the file
   id the page loads, authenticates, opens the notifications socket, reports no
   error, and renders nothing.
2. **Blank ids are refused.** `file-id=` with an empty value silently drives the
   wrong thing; the regex that rewrote it used `+` where it needed `*`.
3. **In `exec` mode both ports must sit inside the published range**, HTTP and
   WebSocket alike, or the server runs perfectly and nothing can reach it.
4. **Busy-port detection reads `/proc/net/tcp` *and* `tcp6`.** The MCP server
   binds HTTP on IPv4 and its WebSocket on IPv6; reading one file reports every
   WebSocket port as free.
5. **Ports are probed inside the container**, never from the host: Docker
   publishes the whole range, so every host-side check says "in use".
6. **A `docker compose exec` client dying does not stop the process it started.**
   Record the in-container pid and kill it explicitly on the way out.
7. **The browser talks to `localhost`, never a LAN address.** Hardened session
   cookies are `Secure`; only a loopback origin is trustworthy.
8. **One browser profile per document.** Two workers on one profile directory
   fight over the Chromium lock. *(Not enforced today — a real gap.)*
9. **The REPL is suppressed by aiming `PENPOT_MCP_REPL_PORT` at a port already
   bound**, because the 2.17 bundle has no switch for it.
10. **Readiness is the plugin WebSocket opening.** The URL, an RPC probe and
    `page.on("response")` all lie.
11. **`isPluginSocket` matches the injected URI's port**, not the default, or a
    healthy worker is reported as a timeout.

## 10. Process model: nothing execs anything

This is the section the rewrite exists for.

Today the chain is `python → exec → bash → node → chromium`, welded into one
process group in one terminal. The next generation has no `exec` in it at any
layer, and a worker is **detached by default**.

### Starting

`start` double-forks the worker into its own session (`setsid`-equivalent:
`spawn(..., { detached: true, stdio: ['ignore', log, log] })` followed by
`unref()`), waits only long enough to confirm the plugin WebSocket opened, then
writes the registry entry and exits. The terminal is free; the worker is not
attached to it. Closing the shell, the picker, or the SSH session leaves it
running.

`run` is the same code path with `detached: false` and the log stream on stdout,
for when you want to watch one in a terminal and stop it with Ctrl-C.

### The worker process

One foreground process inside its own session, owning:

- optionally an **MCP server** — a child process (`local`) or a recorded
  in-container pid (`exec`),
- a **browser** — a Playwright context, or a `docker run` child,
- a **registry entry** at `$XDG_STATE_HOME/penpot-worker/workers/<id>.json`:
  id, account, file id, team id, ports, pids, in-container pid, browser mode,
  log path, start time,
- a **log file** beside it, which is what `logs` reads.

The entry is written once both halves are up, and removed by a single cleanup
path that runs on `SIGINT`, `SIGTERM` and normal exit.

### Stopping

`stop <id>` reads the entry, signals the worker, waits, and then — because a
`docker compose exec` client dying does not stop what it started (invariant 6) —
kills the recorded in-container pid explicitly. `stop --all` does that for every
live entry. `stop --prune` additionally scans the MCP container for
`node index.js` processes with no matching entry and offers to kill them, which
is the orphan class that bit this deployment twice.

### One exit point

The command layer returns an exit code to a single `main`. Nothing calls
`process.exit` from inside a branch, and no branch falls through into the next —
the bug that made killing a worker start a second browser was exactly that, a
branch that returned where it needed to stop.

## 11. Module layout

```
mcp-worker/
  SPEC.md              this document
  README.md            usage
  package.json         bin: penpot-worker, deps: playwright
  jsconfig.json        checkJs, strict
  src/
    cli.js             argv → command, single exit point
    commands/          start · run · ps · logs · stop · ls · doctor · login · provision
    core/
      config.js        the three layers of §8
      target.js        account + file + team → workspace URL   (invariants 1, 2)
      ports.js         allocation and validation               (invariants 3, 4, 5)
      registry.js      the worker inventory                    (§10)
      spawn.js         detached vs foreground launch, no exec   (§10)
      topology.js      builtin | exec | local                  (invariants 9, 11)
    browser/
      launch.js        host or container                       (invariant 7)
      session.js       cookie, login, profile                  (invariant 8)
      page.js          open, readiness, reload                 (invariant 10)
    docker/
      compose.js       exec, probe, in-container pids          (invariants 5, 6)
    penpot/
      rpc.js           login, teams, files, tokens
    tui/               form, fields, render
  test/                node:test, one file per core module
```

`core/` is pure and fully tested. `browser/`, `docker/` and `penpot/` are the
I/O edges. `tui/` and `commands/` are thin.

## 12. The picker

Same model as the curses version, which works: a field list (account, document,
mode, browser, port, headed, display), live values, arrow keys, Enter to launch.
What changes is everything about how it hands off.

**It never execs.** It calls `start` in-process, gets an id back, and returns to
its own list. Launching a second worker is another Enter, not another terminal.
Quitting the picker leaves every worker running.

- It **opens on what already exists**: the `ps` table first, with ports,
  documents and health, so the first thing you see is the truth about the
  machine rather than an empty form. Stopping one is a keystroke.
- Fields are prefilled from the last run and from what is detectable — accounts
  found on disk, documents fetched live across all teams, a port chosen from the
  free range, `DISPLAY` from the environment.
- It refuses impossible combinations before launching rather than after: a
  document already driven by a running worker, a port outside the published
  range, `--headed` with no `DISPLAY`.
- It prints the equivalent `penpot-worker start …` line before launching. The
  curses version did this and it is how its flags got learned.
- ANSI escapes over `node:readline` in raw mode. No curses equivalent is needed
  and no dependency is worth it for one form.

## 13. Testing

- `core/` gets unit tests. Specifically: the URL rewriter against blank, absent
  and malformed ids; the port allocator against a busy list including IPv6-only
  entries and out-of-range requests; the registry against stale and corrupt
  entries.
- `docker/` and `penpot/` are tested against recorded fixtures — a captured
  `/proc/net/tcp` pair, a captured RPC response — not a live stack.
- **The detachment contract gets its own test**, because it is the whole point:
  start a worker, kill the starting process, assert the worker and its browser
  are still alive and still in the registry; then `stop` it and assert both the
  host process and the in-container server are gone. A regression here is
  invisible until the day it eats a session.
- One end-to-end smoke, opt-in behind an env var, that starts a worker against
  the real deployment and calls `execute_code`. This is what `smoke.js` does now.

## 14. Migration

Four steps, each leaving the tree working:

1. Create the package with `core/` + tests. Nothing uses it yet.
2. Implement `run`, `ps`, `stop`. Keep `run-mcp-worker` in place; run both
   against the same deployment and compare.
3. Implement `ls`, `login`, `doctor`, `provision`, then the picker. Delete
   `run-mcp-worker`, `run-mcp-worker.py`, `provision-worker` and
   `mcp/packages/host/` in one commit, with the HANDOFF updated in the same one.
4. Fold `deploy/home-cluster/worker/*.env` into `mcp-worker/accounts/`, keeping
   the file format so nothing has to be re-provisioned.

Step 3 is the point of no return and should not be split: two launchers in the
tree is exactly the state we are leaving.

## 15. Open questions

1. **Package location** — §4 recommends consolidating under
   `deploy/home-cluster/`. The alternative is growing `mcp/packages/host/` into
   `mcp/packages/worker/` and keeping two quarantine zones.
2. **`--mcp builtin` against cloud is still undriven.** If it works, the worker
   reduces to a browser and a URL, and `topology.js` gets simpler. Worth
   resolving before the module is written rather than after.
3. **Does `stop` reap orphans it did not create?** A registry only knows what it
   wrote. A `--prune` that scans the container for `node index.js` processes
   with no matching entry would have saved this session twice.
4. **One account, many documents.** Invariant 8 says one profile per document,
   but the profile holds the session, so N documents means N logins of the same
   account. It works; whether a shared cookie jar and per-document profiles is
   better is unexplored.
5. **Log retention.** Detached workers write to files nobody rotates. A cap per
   worker with truncation is probably enough, but "probably" is why it is here.
6. **Should `start` wait for readiness?** Waiting means a useful exit code and a
   real error when the plugin never connects, at the cost of up to 90 seconds
   before the prompt returns. Proposed: wait, with `--no-wait` to opt out.
