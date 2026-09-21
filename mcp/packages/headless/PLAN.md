# Plan: mcp-headless

Executable task list for building the launcher. One task is one worktree and
one merge. `code-impl` runs a task in a fresh context, so everything it needs
is here or in References.

## Goal

A long-running TUI that supervises several **lanes** — one MCP server port plus
the browser tab that serves it — against the self-hosted stack, replacing the
bash + curses + node split that exists today.

Done, for v1 (SPEC §3b narrows this):

- The TUI opens, closes and retries `exec` lanes against self-hosted Penpot.
- Quitting ends every lane and leaves nothing in the container.
- Leftovers from a killed supervisor are reported, never adopted, and reapable.
- `core/`, the lane state machine and the port parser are unit tested.
- `run-mcp-worker`, `run-mcp-worker.py`, `provision-worker` and
  `mcp/packages/host/` are gone.

**Non-goals.** The `builtin`, `local` and `image` lane implementations stay
unbuilt; `core/topology.ts` still wires all four, and a lane in an unbuilt mode
fails with a reason naming SPEC §3b. Not a container manager, not a deployment
tool, not multi-host.

## References

- [SPEC.md](SPEC.md) — what the launcher is and how it supervises. §3b is the
  scope, §11 the eleven invariants, §14 the settled decisions.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the system it drives; the four modes.
- [API.md](API.md) — the directory-level interfaces and why each is shaped so.
- [IMPL-HANDOFF.md](IMPL-HANDOFF.md) — live environment, verification commands,
  traps that cost hours the first time. Read §2, §3 and §6 before any task.
- `mcp/packages/host/config.js`, `host.js` — the working reference for
  `browser/`. Port from these; do not reinvent.
- `deploy/home-cluster/run-mcp-worker` — the reference for ports, the exec
  lifecycle and cleanup. `ports_busy_in_container` and the range guard are the
  two functions being replaced by tested code.
- `mem:workflow/creating-commits`, `mem:workflow/updating-pnpm`, `mem:testing`.

## Conventions & constraints

**The stack on this host is the user's real instance. Treat it as production.**
Never kill a worker you did not start (IMPL-HANDOFF §2).

- **Package**: `@penpot/mcp-headless` in `mcp/packages/headless`, bin
  `mcp-headless`. Standalone pnpm: its own `pnpm-workspace.yaml` **and** its own
  `pnpm-lock.yaml`, a member of nothing. It carries the repo-wide
  `packageManager` field, which `mcp/packages/host` lacks — without it
  `corepack use` stamps an ancestor and the package silently never gets swept
  (`mem:workflow/updating-pnpm`).
- **Playwright is pinned to `1.62.1` exactly**, matching the root workspace's
  devDependency and its `overrides` entry. Not a caret: the browser build is
  pinned on purpose.
- **Runtime**: TypeScript run directly by Node (v24.20.0 strips types natively).
  No build step, no `tsx`, no loader. Imports carry the `.ts` extension.
  `tsc --noEmit --strict` type-checks and never emits.
- **Tests**: `node:test` + `node:assert/strict`, co-located as `src/**/*.test.ts`
  the way `packages/server` and `packages/plugin` do it. There is no Makefile
  here; the commands are `pnpm -C mcp/packages/headless run test` and
  `… run types:check`. Formatting is the parent's:
  `pnpm -C mcp run fmt` uses `mcp/.prettierrc`.
- **Every task's tests run with no service, no secret and no network.** A
  worktree gets a fresh `pnpm install` and nothing copied from the main
  checkout. Live verification is a separate, explicitly marked step run from
  the main checkout after a merge.
- **Style** (`mem:mcp/core`): idiomatic object-oriented TypeScript; prefer an
  explicitly typed interface over a bare function for any non-trivial seam.
  Doc comments open with an elliptical phrase saying what the thing *is*.
  Comments carry *why*; code carries what and how.
- **Commits**: subject ≤70 chars with an allowed `:emoji:`, body wrapped ≤76,
  `./scripts/check-commit` exit 0. Trailers `AI-assisted-by: claude-opus-5` and
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Stage by
  explicit path. **Never push** — `origin` is upstream `penpot/penpot`.

## Milestone 1 — Toolchain and pure core

- [x] **T1.1 Package skeleton.** `package.json`, `tsconfig.json`, `.gitignore`,
  `README.md`, the lockfile from a real install, and one trivial test so the
  runner is proven. Amend SPEC §8 (npm → standalone pnpm, with the reason) and
  SPEC §12's tree (`docker/` → `exec/`, which its own prose already says) in the
  same commit. — acceptance: `pnpm -C mcp/packages/headless run types:check` and
  `… run test` both exit 0, and `git check-ignore` confirms `node_modules` is
  ignored while `pnpm-lock.yaml` is tracked.

- [x] **T1.2 `core/target.ts`.** `AccountRef`, `DocumentRef`, `workspaceUrl`,
  `parseWorkspaceUrl`. `teamId` is non-optional (invariant 1); blank and absent
  ids throw rather than returning an empty string (invariant 2). — acceptance:
  tests cover a round trip, an optional `page-id`, `file-id=` with an empty
  value, a missing `team-id`, a non-UUID id, and a URL with no hash query. Each
  failure names the offending field.

- [x] **T1.3 `core/ports.ts`.** `allocate(range, busy)` and
  `assertUsable(pair, range, busy)`. Pure — `busy` arrives as an argument
  because only the container can answer it (invariant 5). — acceptance: tests
  cover a pair skipped because only its WebSocket half is busy (the IPv6 case,
  invariant 4), a request outside the published range (invariant 3), an
  exhausted range, and an odd-sized range where the last port has no partner.
  The out-of-range and busy errors name the free ports.

- [x] **T1.4 `core/topology.ts`.** `Mode` is the four-member union;
  `wire(mode, account, ports, userToken)` returns the `Wiring` every URL comes
  from, and `isPluginSocket(url, wiring)` derives from the same value. —
  acceptance: tests assert `builtin` needs no server and matches `/mcp/ws`; that
  `exec`, `local` and `image` inject and match **the injected port, not the
  default** (invariant 11); and that `needsUserToken` is true only for
  `builtin`.

- [x] **T1.5 `core/config.ts`.** The three layers of SPEC §10. Takes an injected
  `ConfigIo` port (`read`, `list`) so `core/` keeps its no-`fs` rule while the
  directory-walking and precedence stay testable — see the Decision log. —
  acceptance: tests parse the real `provision-worker` env shape from an
  in-memory `ConfigIo` (quoted values, `#` comments, `$HOME` expansion), map the
  flat `deployment.json` of SPEC §10 onto the nested `Deployment` with
  `exposure` defaulting to `none`, and return `deployment: undefined` when the
  file is absent.

## Milestone 2 — The container edge

- [x] **T2.1 `exec/procnet.ts`.** `parseListeningPorts(tcp, tcp6)`, pure and
  fixture-tested, because this parser is where the IPv6 bug lived. Capture the
  fixtures once with the command in IMPL-HANDOFF §3 and commit them. —
  acceptance: the captured pair yields both the IPv4 HTTP port and the
  IPv6-only WebSocket port, non-`0A` rows are ignored, duplicates collapse, and
  a truncated file throws rather than returning a short list.

- [x] **T2.2 `exec/backend.ts` + `exec/compose.ts` + the contract test.** The
  `ExecBackend` interface, a compose implementation, an in-memory fake, and one
  suite both must satisfy: start a process, see its port in `listening()`,
  expose it, kill it, see the port released. `start` resolves with an
  in-container pid (invariant 6). — acceptance: the contract suite passes
  against the fake with no Docker. The compose run is gated behind
  `MCP_HEADLESS_E2E=1` and skips by default.

## Milestone 3 — Supervision

- [x] **T3.1 `supervisor/lane.ts`.** `runLane` as a plain async function over
  nested `try`/`finally`, with fake `LaneDeps`. — acceptance: tests assert the
  event sequence to `connected`; that aborting runs **every** `finally` in
  reverse order of acquisition (assert the recorded order, not just that
  cleanup happened); that a throw from `expose` still kills the server; and
  that an unbuilt mode fails with a reason naming SPEC §3b.

- [x] **T3.2 `supervisor/supervisor.ts`.** The lane set, cancellation scopes,
  subscriptions. — acceptance: tests assert `open` rejects a second `builtin`
  lane on one account and a second lane on one document, each with a reason;
  that subscribers see every transition; and that `shutdown` past its deadline
  kills what remains and reports the forced count instead of hanging.

- [x] **T3.3 `supervisor/leftovers.ts`.** `scan` and `reap`, with `Leftover`
  deliberately not a `LaneRecord`. — acceptance: tests find an in-container
  server through a fake backend and a stray browser by profile directory
  through an injected process lister; assert a leftover's port is excluded from
  allocation; and assert nothing in the module can turn a `Leftover` into a
  supervised lane.

## Milestone 4 — Browser and Penpot

- [x] **T4.1 `browser/launch.ts` + `browser/pool.ts`.** Ported from
  `mcp/packages/host/config.js`. Leases keyed by (account, headed, flavour);
  the browser closes with its last lease. — acceptance: refcount and key
  equality tested against a fake launcher, including a lease failure not
  leaking a browser. The three-tabs-three-injected-URIs regression runs for
  real behind `MCP_HEADLESS_E2E=1`.

- [x] **T4.2 `browser/session.ts`.** The session store: does this profile hold
  a session, log in by password, log in interactively. (`browser/page.ts` moved
  into T4.1 — the pool cannot open a tab without it.) — acceptance: the cookie
  check and both login paths are driven against a fake context; the interactive
  path waits for the cookie to exist rather than for the window to close.

- [x] **T4.3 `penpot/rpc.ts`.** Login, teams, recent files, read the MCP token —
  with an injected `fetch` and the cookie passed explicitly, because Node will
  not send a `Secure` cookie over loopback http. — acceptance: tests drive
  captured `get-teams` and `get-team-recent-files` responses; a 401 surfaces as
  a typed error naming the origin; and a test asserts the module exports no
  token-creating function (API.md: `create-access-token` with `type: "mcp"`
  deletes the account's existing token).

## Milestone 5 — The front end

- [x] **T5.1 `tui/render.ts`.** A pure function from `Screen` and a terminal
  size to a string. — acceptance: snapshot tests at 80×24 for an empty list, a
  mixed list of states, and a leftovers section; long document names truncate
  rather than wrap; no ANSI escape leaks into the snapshot's measured width.

- [x] **T5.2 `tui/run.ts` + `main.ts`.** The input loop, `--no-tui`, `--check`,
  and the single exit point. — acceptance: argv table tests including repeated
  lane groups and `--headed` with no `DISPLAY`; `main` returns a code and calls
  `process.exit` nowhere; `--check` against a fake backend prints leftovers and
  returns a non-zero code when it finds any.

## Milestone 6 — Cutover

- [ ] **T6.1 `mcp-headless account`.** Port `provision-worker`. The
  token-creating call lives here alone, behind an explicit flag, because it
  deletes the account's existing token. — acceptance: the flow is tested
  against a fake `PenpotApi`; the env file is written mode 600; a run without
  the flag never calls `create-access-token`.

- [~] **T6.2 Live acceptance run.** *(human-verified, from the main checkout —
  not a worktree task.)* Run 2026-09-20 against the real stack and the
  `mcp-worker` account's own documents. **Passed:** a lane opens, logs in,
  starts its server, opens the tab, the plugin dials, and an agent's
  `execute_code` returns real data from the document; `SIGTERM` leaves the
  container at baseline with no browser; `SIGKILL` leaves wreckage that
  `--check` reports as **leftovers rather than lanes** and that `reap` clears;
  two lanes take distinct ports and share one browser, and both are torn down
  cleanly. **Failed:** with two lanes, only the first has a live plugin
  connection — see Open questions.

- [ ] **T6.3 Delete the old tooling.** `run-mcp-worker`, `run-mcp-worker.py`,
  `provision-worker`, `mcp/packages/host/`, and the `deploy/home-cluster/HANDOFF.md`
  sections that describe them — one commit, because two launchers in the tree is
  the state being left. — acceptance: `rg` finds no live reference to any
  deleted path outside journals and the design docs' history sections.

## Milestone 7 — The TUI as asked for

Raised 2026-09-21 after the first proper look at the interface.

- [x] **T7.1 `core/columns.ts`, a configurable list, and a status bar.** Columns
  become data: a catalogue of named columns — port, state, document, team,
  account, browser, display, mode, uptime, client — each with a width and an
  accessor. Which appear, and in what order, comes from `tui.json` beside the
  other configuration, or from `--columns`. The status bar under the list
  carries what the columns truncate. — acceptance: an unknown column is refused
  naming the ones that exist; the default set renders as it does today; a custom
  order renders in that order; the status bar shows the selected lane's
  `file-id`, `team-id` and client URL; no line runs past the terminal at any of
  five widths.

- [x] **T7.2 Carry `--display` through to the browser.** It is parsed,
  validated and then dropped: `display` appears nowhere outside `args.ts`, so a
  headed lane can only ever use the ambient `DISPLAY`. — acceptance: the display
  reaches `launchPersistentContext`'s environment; it is part of the browser key,
  so two lanes on different displays do not share a process; `--headed` with no
  display is still refused at parse.

- [x] **T7.3 `penpot/catalogue.ts` — teams and documents by name.** A uuid is
  not something anyone recognises. The RPC to list them already exists and is
  tested; nothing calls it yet. — acceptance: against a fake `PenpotApi`,
  documents come back as team name plus file name carrying both ids; one login
  per account, cached across calls; a failure degrades to typing ids by hand
  rather than to an empty picker.

- [x] **T7.4 Expandable choices, `start` as a row, `enter` for details.** Three
  separate complaints, one shape. In the form, `enter` currently starts the
  lane, which spends the key that should open a list; starting moves to its own
  row. In the list, `enter` does nothing while the footer advertises details. —
  acceptance: `enter` on a choice expands it and `up`/`down` move within the
  expansion; `enter` picks and collapses, `escape` collapses without picking; a
  lane starts only from the `start` row; `enter` on a lane opens a details view;
  the footer says only what is true.

## Milestone 8 — The MCP façade

Design: [FACADE.md](FACADE.md). One endpoint for every document, with the
document chosen through the protocol instead of through a port number. Nothing
here changes upstream code or runs non-stock code in the container.

- [ ] **T8.1 Make readiness mean connected.** `PluginWatch` tracks `dropped` and
  nothing reads it, so a socket that opens and immediately closes satisfies
  `waitForPlugin`. Under the TUI that is a wrong row; under the façade, which
  opens lanes with nobody watching, it is a failed tool call blaming the wrong
  thing. Settle briefly after the socket opens and re-check before reporting.
  **This blocks T8.3 and T8.4.** — acceptance: against a fake `Page`, a socket
  that opens and closes within the settle window resolves `null` with a reason
  naming the drop; one that opens and stays resolves its URL; one that closes
  *after* the settle still reports connected, since that is the lane's own
  business; aborting mid-settle rejects promptly rather than at the deadline.

- [ ] **T8.2 Widen the published port range.** `4601-4608` is four lanes, which
  is too few once the façade allocates one per session and document. — 
  acceptance: `core/ports.ts` allocates twenty pairs from `4601-4640` and
  refuses the twenty-first naming the range; `.env.example`,
  `deploy/home-cluster/HANDOFF.md` and the `deployment.json` example in
  `README.md` all agree on the new bound. *(Recreating `penpot-mcp` to publish
  it is human-verified, from the main checkout.)*

- [ ] **T8.3 `facade/leases.ts` — lanes as a resource, and the tab lock.**
  Resolves a document to a lane, holds a lease per `(session, document)`,
  releases on disconnect, session close or idle, and serialises calls per lane.
  The lock is per tab, not per document, and is required even for one agent:
  `plugin.ts:68` dispatches without awaiting, so two concurrent calls from one
  client interleave in one JS context (FACADE.md §6). — acceptance: with fake
  lanes, two sessions on one document get their own lanes by default and share
  one under the flag; a shared lane runs one call at a time in FIFO order and
  reports the queue depth; a call that never returns is timed out and releases
  the lock rather than wedging the next caller; a lease outlives one of two
  sessions and the lane goes with the last; an idle lease is collected.

- [ ] **T8.4 `facade/server.ts` — the MCP endpoint.** Stateful, matching
  Penpot's own choice, with `document` as an optional override on every tool so
  a lost session is recoverable (FACADE.md §3). Mirrors the backend's tools by
  acting as an MCP client to a lane. — acceptance: against a fake backend,
  `list_documents` returns team and file names; `connect_doc` binds the session
  and does not return until the lane is connected; a tool call with no
  `document` uses the session's and one with `document` overrides it; an unknown
  document is refused naming the known ones; a closed session releases its
  lease; nothing calls `process.exit`.

- [ ] **T8.5 Live acceptance.** *(human-verified, from the main checkout.)* One
  static endpoint in the agent's configuration; `list_documents` shows real
  names; `connect_doc` on a cold document blocks and then works; two documents
  driven concurrently through the one endpoint; two sessions on one document do
  not interleave; quitting the launcher leaves the container at baseline.

## Open questions

- **Two lanes, one plugin connection.** *(blocks T6.3.)* With two lanes in one
  browser, only the first ends up with an established WebSocket. Measured
  2026-09-20: lanes on 4601 and 4603 both reported connected, the container
  showed exactly one established socket on 4602, and the server on 4603
  answered a tool call with "No Penpot plugin instances are currently
  connected". One browser was shared, as designed, and both tabs did open a
  socket — the second one closed again. Two things follow, and the first is
  worth doing whatever the cause turns out to be:
  1. **Readiness is too eager.** A socket that opens and immediately closes
     satisfies `waitForPlugin`, so a lane reports connected when it is not.
     `PluginWatch` already tracks `dropped` and nothing reads it. The lane
     should settle briefly and re-check, which turns a false "connected" into
     an honest failure with a reason.
  2. **Root cause unknown.** Whether a Penpot profile can host two MCP plugin
     instances at once is not established. Two separate browsers cannot be
     tested with one account — one profile directory holds one Chromium — so
     answering it needs either a second worker account or a per-lane browser
     flavour.
- **The supervisor refuses a second lane on one document** —
  `lane ${id} already drives that document`. Right for hand-driven lanes, wrong
  once the façade allocates them per session (FACADE.md §9). T8.3 has to make it
  opt-out.
- **Nothing non-interactive reaps.** `--check` reports leftovers and the TUI's
  `r` clears them, but a script has no way to. A `--reap` flag is the obvious
  addition.
- ~~**`recentFiles` returns an empty `modifiedAt`.**~~ Answered 2026-09-21:
  Penpot takes kebab-case parameters and answers in camelCase, so every
  kebab-spelled field read as absent and `isDefault` was always false.

- ~~**Worktree install cost.**~~ Answered in T1.1: a sibling worktree does get
  its own store. Installing this package alone costs 5 packages and under a
  second, because `allowBuilds` blocks the browser download and the browsers in
  `~/.cache/ms-playwright` are shared. The 265 MB figure only appears if
  something installs the whole `mcp` workspace, which nothing here needs to.
- ~~**Playwright's install script under pnpm.**~~ Answered in T1.1: this
  package's own `pnpm-workspace.yaml` sets `allowBuilds: playwright: false`, so
  the download is skipped on purpose. A machine without the browsers runs
  `pnpm exec playwright install chromium` once.
- **`--check` output for scripting.** Whether leftovers need a `--json` form for
  systemd. Deferred; not in v1's acceptance.

## Decision log

- 2026-09-20: **Standalone pnpm with its own lockfile**, not npm (SPEC §8) and
  not a workspace member. Keeps Playwright out of `mcp/pnpm-lock.yaml` without
  adding a third package manager the repo's dep tooling does not know. It does
  carry the `packageManager` field, which fixes the corepack gotcha that
  `mcp/packages/host` silently has today. SPEC §8 is amended in T1.1.
- 2026-09-20: **`core/config.ts` takes an injected `ConfigIo`.** API.md §0 says
  `core/` has no `fs`, then declares `load(dir, env)` in it. The port
  reconciles the two: the rules stay in `core/` and testable, the syscalls
  happen in `main.ts`.
- 2026-09-20: **`Mode` has four members.** SPEC §3b says the full union stays
  and all four wire; API.md's three-member version is superseded. `image` wires
  identically to `exec`.
- 2026-09-20: **The account record carries `email`.** `PenpotApi.loginWithPassword`
  needs one and `provision-worker` writes `PENPOT_EMAIL` into every env file.
  It goes on the settings entry beside `password` and `mcpToken`, not on
  `AccountRef`.
- 2026-09-20: **`exec/`, not `docker/`.** SPEC §12's tree is stale; its own
  prose, API.md and IMPL-HANDOFF all say `exec/`. Fixed in T1.1.
- 2026-09-20: **The plan lives here, not in `docs/`.** `docs/` is Penpot's
  Eleventy documentation site.
- 2026-09-20: **Playwright stays pinned at `1.62.1`, and the browser is a
  one-time download.** The pin matches the root workspace *and* `frontend`;
  only `mcp/packages/host`'s caret floated to 1.63.0, which is why the browser
  on this host was revision 1243 and the pinned build had to be fetched. Run
  `pnpm exec playwright install chromium` once per machine — `allowBuilds`
  blocks the automatic download so a worktree install stays under a second.
- 2026-09-20: **`loginWithPassword` takes the whole `Account`.** API.md passed
  a loose password beside an `AccountRef`, which allows pairing a password with
  the wrong email and makes every caller handle a secret. The account file
  already carries both.
- 2026-09-20: **The supervisor allocates ports, not the lane.** Reversed after
  the first two-lane run: both lanes probed the container before either had
  started a server, and both took 4601. Choosing a port is a read followed by a
  write, and only the supervisor can see a lane's siblings — so `open` is
  serialised and holds a reservation until the lane is closed. The lane still
  checks a port it is handed, which is what catches an operator's mistake when
  `runLane` is used directly.
- 2026-09-20: **A session is ensured before any lane opens.** Also from the
  first live run: with no session the workspace URL redirects to the login
  page, nothing errors, and the lane waits ninety seconds before blaming the
  plugin. `ensureSession` runs once per account, before a browser holds the
  profile, and logs in when the account file has credentials.
- 2026-09-20: **`--no-tui` keeps itself alive, and exits non-zero when every
  lane has failed.** It exited 13 — Node's unsettled top-level await — the
  moment the last lane settled, which is neither actionable nor a hint.
- 2026-09-20: **The form is a pure model in `tui/form.ts`.** The first cut put
  key handling in the input loop and the form came out read-only. Moving the
  model and its `applyKey` out makes every key testable and leaves `run.ts`
  with no rules at all — the same reason `render` is a pure function.
- 2026-09-20: **`bin/mcp-headless.ts` is the only place that exits.** `main`
  returns a code; a test replaces `process.exit` and asserts nothing calls it.
- 2026-09-20: **`browser/page.ts` moved from T4.2 into T4.1.** The pool cannot
  open a tab without the readiness watch, so splitting them would have meant
  merging a pool that could not be used. `browser/session.ts` is T4.2 on its
  own.
- 2026-09-20: **The pool takes a `Launch` function, not a Playwright handle.**
  Refcounting, keying and close-with-the-last-lease are the parts that can be
  wrong, and they are now testable with no browser at all. The real browser
  appears in two opt-in tests, one of which is the per-tab injection
  measurement the whole sharing design rests on.
- 2026-09-20: **A lane is keyed by a handle, not by its port.** SPEC §1 says
  the port identifies a lane, but the port is not known until the lane has
  asked the container what is free — so `open` cannot return one. The
  supervisor hands out a counter id and the record carries the port once the
  lane reports it, which is what the TUI column shows. The `connected` event
  gained `port` for that reason.
- 2026-09-20: **Readiness is a method on the `Lease`, not a free function
  over a `Page`.** API.md put `waitForPluginSocket(page, wiring, …)` in
  `browser/page.ts`. A lease already knows the wiring it was opened with, so
  making it the one that answers means the question cannot be asked with
  someone else's ports — invariant 11 made structural rather than remembered.
  It also keeps Playwright's `Page` out of the lane entirely, so the state
  machine is testable without faking a browser.
- 2026-09-20: **`LaneDeps` carries no `PenpotApi`.** API.md listed one, but a
  lane makes no RPC call: teams and files are fetched when the TUI builds the
  form, long before a lane exists. `portRange` takes its place, since the lane
  is what allocates.
- 2026-09-20: **Reachability is an HTTP exchange, never a TCP connect.** The
  contract suite caught this against the live stack: Docker's proxy accepts a
  connection on every published port whether or not anything is behind it, so
  connecting to a free 4608 succeeded and the GET that followed failed with
  ECONNRESET. A connect-based check would have called every port in the range
  reachable — the same lie invariant 5 describes, from the other direction.
  Worth adding to SPEC §11 as a twelfth invariant when that section is next
  touched.
- 2026-09-20: **`ExecBackend` gained `log(pid)`.** A failed lane's event
  carries the last output lines (API.md), and only the backend has them. It
  also reads the in-container pid off the process's own stream rather than out
  of a pidfile: the wrapper shell prints `$$` and then `exec`s the real
  command, which removes the race the shell script had between writing the
  file and something reading it.
- 2026-09-20: **The fake refuses to expose a port nothing serves.** Caught by
  the contract suite on its first run: the double was more permissive than
  compose, which is the one way a shared double is worse than none.
- 2026-09-20: **`Wiring` also carries the server's environment.** SPEC §12
  assigns invariant 9 — REPL suppression by aiming `PENPOT_MCP_REPL_PORT` at an
  already-bound port — to `core/topology.ts`, and it belongs with the addresses
  for the same reason they belong together: one function decides them, so they
  cannot drift apart. `exec/` passes `wiring.serverEnv` through rather than
  rebuilding it.
- 2026-09-20: **`workspaceUrl` emits the legacy hash form, and
  `parseWorkspaceUrl` reads both.** Found in T1.2:
  `frontend/src/app/main/ui/routes.cljs` on `develop` has moved to
  query-string routing (`?screen=workspace&…`) and keeps `#/workspace?…` only
  "during the compatibility window", with a TODO to delete it. The deployed
  2.17 instances still answer the hash form, so that is what a worker is told;
  reading both costs nothing and is what an operator pasting a URL needs.
- 2026-09-20: **`no-team-id` became `missing-id` with the field in the
  detail.** One code for any absent id reads better than a code per field, and
  the message still names team-id where invariant 1 applies.
- 2026-09-20: **The package declares its own `pnpm-workspace.yaml`.** Found in
  T1.1: without one, pnpm walks up to `mcp/pnpm-workspace.yaml` and installs
  that workspace's four projects, skipping this directory in silence — no
  lockfile, no Playwright. Declaring a root is what makes a standalone lockfile
  reachable by a plain `pnpm install`. This is not the nested-workspace hazard
  `mem:workflow/updating-pnpm` warns about: that one is a workspace *member*
  that also declares itself a root, and this package is a member of nothing.
- 2026-09-20: **Tests sit beside the code**, not under `test/` as SPEC §12 drew
  it. `packages/server` and `packages/plugin` both co-locate `src/*.test.ts`,
  and matching the neighbours beats matching a diagram.
- 2026-09-20: **`pnpm-lock.yaml` added to `mcp/.prettierignore`.** `pnpm -C mcp
  run fmt` reformats everything under `packages/`, which today silently rewrites
  `packages/host/pnpm-lock.yaml`. Generated files should not be a diff after
  every install.
- 2026-09-20: **Live verification is never a worktree task's gate.** A worktree
  gets no secrets and no copied config (`spawn-worktree` §0/§1), so e2e runs
  from the main checkout after a merge. Opt-in live tests are gated behind
  `MCP_HEADLESS_E2E=1` and skip by default.
