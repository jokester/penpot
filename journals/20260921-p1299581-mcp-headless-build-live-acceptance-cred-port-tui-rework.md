---
date: 2026-09-21 23:47
branch: exp/headless-mcp
host: twlight-sparkle
user: mono
tldr: Built mcp-headless from its handoff docs through milestones 1-5 in worktree-per-task, drove a real lane end to end and fixed four bugs only the live stack could find, ported the worker credentials to the launcher's config, then reworked the TUI for configurable columns, named documents and honest enter semantics.
---

# Journal: Building mcp-headless, and what the real stack found

## Intent

Continue from `mcp/packages/headless/IMPL-HANDOFF.md` — the previous session left
three design documents and no code. Then, in order as asked:

1. Port the previous generation's worker credentials to the new launcher.
2. Make the lane list configurable, show teams and documents by name, fix `enter`
   doing nothing in the list while starting a lane from the form, and make the X
   display configurable for headed lanes.

## What happened

### Process: the user's own skills, followed literally

The user pointed at `/home/mono/Projects/meta-skills/my` and said to read the
coding skills first. That changed the shape of the whole session:

- **`code-deps`** sends you to the repo's dependency machinery before writing a
  manifest. Doing that surfaced a conflict with SPEC §8 worth stopping for, and
  the user chose: standalone pnpm, own lockfile.
- **`code-plan`** wants `docs/plan-{topic}.md`, but `docs/` here is Penpot's
  Eleventy site — the plan went to `mcp/packages/headless/PLAN.md` instead.
- **`code-impl` / `code-merge`** gave the rhythm: one worktree per task, verify
  green, rebase, `--ff-only` merge, remove worktree and branch. Ran 16 times.

The user chose "auto-merge on clean checks" for the loop, so the milestones ran
without checkpoints.

### Milestones 1–5: 281 tests, no build step

Core (`target`, `ports`, `topology`, `config`), the container edge (`procnet`,
`ExecBackend`, compose), supervision (`lane`, `supervisor`, `leftovers`), the
browser and RPC, then the TUI and entry point. TypeScript run directly by Node
with `erasableSyntaxOnly` on, which caught constructor parameter properties twice
before they could reach a commit.

### The live acceptance run, which paid for itself

Driving the real stack against the worker's own `worker-scratch` document proved
the chain — `execute_code` returned `{ file: "worker-scratch", page: "Page 1" }`
through a lane's MCP endpoint — and found four bugs no unit test could:

1. **No session check.** A profile with no session redirects to the login page,
   nothing errors, and the lane waits 90s before blaming the plugin. `ensureSession`
   now runs once per account before any browser holds the profile.
2. **`--no-tui` exited 13** (unsettled top-level await) the moment the last lane
   settled.
3. **Both lanes took port 4601.** Each probed the container before the other had
   started a server. Allocation moved to the supervisor, serialised, with
   reservations held until close.
4. **Reachability was a guaranteed false positive** — see Discoveries.

`SIGKILL` → `--check` reported leftovers rather than lanes → `reap` cleared them →
container back to baseline. The ownership contract holds.

### Porting the credentials

`~/.config/mcp-headless/` with `deployment.json` and `accounts/mcp-worker.env` as
a **symlink** to the file `provision-worker` already wrote — one copy of the
password and token, and regeneration keeps working. The env file's `file-id=` was
empty, so nothing prefilled; filling it in also un-broke `run-mcp-worker`, whose
blank-id guard had been refusing to run without an explicit `--file-id`.

### Milestone 7: the TUI as asked for

Columns became data (`core/columns.ts`, `tui.json`, `--columns`), a status bar
carries the ids the columns truncate, `penpot/catalogue.ts` lists documents as
`team / file`, and `enter` was freed from starting a lane — `start` is its own
row now, `enter` opens lists and shows details.

## Discoveries / Quirks

- **Penpot takes kebab-case parameters and answers in camelCase.** `{"team-id": id}`
  out, `modifiedAt` and `isDefault` back. Assuming kebab both ways parses cleanly
  and yields nothing: every optional field read absent, every boolean false. The
  tests passed because the fixtures were hand-written from the same guess. A live
  run the day before printed `default=false` beside a team named "Default" and I
  read past it — hand-written fixtures are what let it survive.
- **`docker-proxy` accepts a TCP connection on every published port**, occupied or
  not, then resets. Measured: connect to an empty 4608 succeeded, the GET after it
  failed `ECONNRESET`. A connect-based readiness check calls every port in the
  published range reachable — the same lie invariant 5 describes, from the other
  side. Only an HTTP exchange distinguishes.
- **A package that is neither a workspace member nor a workspace root gets no
  lockfile.** pnpm walks up, finds `mcp/pnpm-workspace.yaml`, installs *that*
  workspace's four projects and skips the directory in silence. This is the real
  state of `mcp/packages/host`: its committed lockfile can only have come from an
  unrecorded `--ignore-workspace` run.
- **The repo pins Playwright at 1.62.1** (root *and* `frontend`); only
  `mcp/packages/host`'s caret floated to 1.63.0, which is why this host had browser
  revision 1243 and not the pinned 1234.
- **Penpot's `develop` has moved to query-string routing** (`?screen=workspace&…`)
  and keeps `#/workspace?…` only "during the compatibility window", with a TODO to
  delete it (`frontend/src/app/main/ui/routes.cljs`). Deployed 2.17 still answers
  the hash form.
- **`worker/*.env` did not cover `worker/*.env.bak`** — editing the account file
  left an untracked copy of a password in `git status`.
- **Two lanes in one browser: only the first gets a live plugin connection.**
  Measured — one established socket on 4602, and the server on 4603 answering "No
  Penpot plugin instances are currently connected". Both tabs opened a socket; the
  second closed again, and `waitForPlugin` is satisfied by a socket that opens and
  immediately closes.

## Changes

**New package `mcp/packages/headless`** (~6k lines, 281 tests): `PLAN.md`;
`src/core/` (`errors`, `target`, `ports`, `topology`, `config`, `columns`);
`src/exec/` (`backend`, `procnet`, `compose`, `fake`, `contract`, captured
`/proc/net` fixtures); `src/supervisor/` (`lane`, `supervisor`, `leftovers`,
`host-processes`); `src/browser/` (`pool`, `launch`, `page`, `session`);
`src/penpot/` (`rpc`, `catalogue`); `src/tui/` (`render`, `form`, `run`);
`src/args.ts`, `src/main.ts`, `bin/mcp-headless.ts`; `README.md` documenting
configuration and keys.

**Amended in place**: `SPEC.md` §8 (npm → standalone pnpm, with the reason) and
§12 (`docker/` → `exec/`, tests co-located).

**Outside the package**: `mcp/.prettierignore` (lockfiles — `pnpm -C mcp run fmt`
had been rewriting `packages/host/pnpm-lock.yaml`); `deploy/home-cluster/.gitignore`
(`worker/*.env.*`); `deploy/home-cluster/worker/mcp-worker.env` (filled in the
empty `file-id`, backup at `.env.bak`).

**Outside the repo**: `~/.config/mcp-headless/{deployment.json,accounts/}`;
Chromium revision 1234 downloaded; `worker-scratch-2` created in the worker's own
team for two-lane testing.

## Open threads

- **Two lanes, one plugin connection — blocks the cutover (T6.1, T6.3).** Two
  things follow. Readiness is too eager: `PluginWatch` already tracks `dropped` and
  nothing reads it, so a settle-and-recheck would turn a false "connected" into an
  honest failure whatever the cause. And the root cause is unknown — whether one
  Penpot profile can host two plugin instances is not established, and two separate
  browsers cannot be tested with one account because one profile directory holds
  one Chromium. Needs a second worker account or a per-lane browser flavour.
- **`run-mcp-worker`, `run-mcp-worker.py`, `provision-worker` and
  `mcp/packages/host/` are all still present**, deliberately. Deleting the tooling
  in daily use while its replacement has an unexplained two-lane failure is not a
  clean-checks decision.
- **Nothing non-interactive reaps.** `--check` reports and the TUI's `r` clears; a
  script has no way to. A `--reap` flag is the obvious addition.
- `worker/mcp-worker.env.bak` is a second copy of the password, left in place for
  rollback rather than deleted unasked.
- An unrelated `node app.js` on this host has accumulated ~9 zombie
  chrome-headless children; it briefly confused a leak check.
- **Promote to knowledge docs**: the kebab-in/camel-out RPC convention and the
  docker-proxy reachability trap are lasting facts, currently recorded only here
  and in code comments.
