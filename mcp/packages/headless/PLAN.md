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

- [ ] **T2.2 `exec/backend.ts` + `exec/compose.ts` + the contract test.** The
  `ExecBackend` interface, a compose implementation, an in-memory fake, and one
  suite both must satisfy: start a process, see its port in `listening()`,
  expose it, kill it, see the port released. `start` resolves with an
  in-container pid (invariant 6). — acceptance: the contract suite passes
  against the fake with no Docker. The compose run is gated behind
  `MCP_HEADLESS_E2E=1` and skips by default.

## Milestone 3 — Supervision

- [ ] **T3.1 `supervisor/lane.ts`.** `runLane` as a plain async function over
  nested `try`/`finally`, with fake `LaneDeps`. — acceptance: tests assert the
  event sequence to `connected`; that aborting runs **every** `finally` in
  reverse order of acquisition (assert the recorded order, not just that
  cleanup happened); that a throw from `expose` still kills the server; and
  that an unbuilt mode fails with a reason naming SPEC §3b.

- [ ] **T3.2 `supervisor/supervisor.ts`.** The lane set, cancellation scopes,
  subscriptions. — acceptance: tests assert `open` rejects a second `builtin`
  lane on one account and a second lane on one document, each with a reason;
  that subscribers see every transition; and that `shutdown` past its deadline
  kills what remains and reports the forced count instead of hanging.

- [ ] **T3.3 `supervisor/leftovers.ts`.** `scan` and `reap`, with `Leftover`
  deliberately not a `LaneRecord`. — acceptance: tests find an in-container
  server through a fake backend and a stray browser by profile directory
  through an injected process lister; assert a leftover's port is excluded from
  allocation; and assert nothing in the module can turn a `Leftover` into a
  supervised lane.

## Milestone 4 — Browser and Penpot

- [ ] **T4.1 `browser/launch.ts` + `browser/pool.ts`.** Ported from
  `mcp/packages/host/config.js`. Leases keyed by (account, headed, flavour);
  the browser closes with its last lease. — acceptance: refcount and key
  equality tested against a fake launcher, including a lease failure not
  leaking a browser. The three-tabs-three-injected-URIs regression runs for
  real behind `MCP_HEADLESS_E2E=1`.

- [ ] **T4.2 `browser/session.ts` + `browser/page.ts`.** The session store and
  `waitForPluginSocket`, the single readiness signal (invariant 10). —
  acceptance: against a fake `Page` emitting websocket events, the wait resolves
  on a matching URL, ignores a non-matching one, times out with `null`, and
  rejects promptly on abort rather than at the deadline.

- [ ] **T4.3 `penpot/rpc.ts`.** Login, teams, recent files, read the MCP token —
  with an injected `fetch` and the cookie passed explicitly, because Node will
  not send a `Secure` cookie over loopback http. — acceptance: tests drive
  captured `get-teams` and `get-team-recent-files` responses; a 401 surfaces as
  a typed error naming the origin; and a test asserts the module exports no
  token-creating function (API.md: `create-access-token` with `type: "mcp"`
  deletes the account's existing token).

## Milestone 5 — The front end

- [ ] **T5.1 `tui/render.ts`.** A pure function from `Screen` and a terminal
  size to a string. — acceptance: snapshot tests at 80×24 for an empty list, a
  mixed list of states, and a leftovers section; long document names truncate
  rather than wrap; no ANSI escape leaks into the snapshot's measured width.

- [ ] **T5.2 `tui/run.ts` + `main.ts`.** The input loop, `--no-tui`, `--check`,
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

- [ ] **T6.2 Live acceptance run.** *(human-verified, from the main checkout —
  not a worktree task.)* IMPL-HANDOFF §8: open two lanes on two documents, quit,
  confirm both browsers and both in-container servers are gone and both ports
  free. Then `SIGKILL` the supervisor, restart it, confirm the leftovers are
  **reported rather than adopted**, reap them, confirm the container is clean.

- [ ] **T6.3 Delete the old tooling.** `run-mcp-worker`, `run-mcp-worker.py`,
  `provision-worker`, `mcp/packages/host/`, and the `deploy/home-cluster/HANDOFF.md`
  sections that describe them — one commit, because two launchers in the tree is
  the state being left. — acceptance: `rg` finds no live reference to any
  deleted path outside journals and the design docs' history sections.

## Open questions

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
