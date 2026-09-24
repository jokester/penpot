# Implementation handoff

For a session with no memory of the design conversation. The three design
documents are the source of truth for *what* to build; this one carries what
they deliberately leave out — the live environment, the working rhythm, and the
traps that cost hours the first time.

## 0. Read these first, in this order

| document | answers |
| --- | --- |
| [SPEC.md](SPEC.md) | what the launcher is, how it supervises, **§3b: v1 scope** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the system it drives; the four modes and what each can do |
| [API.md](API.md) | the directory-level interfaces and why each is shaped that way |

Do not re-derive their conclusions. Where this file and they disagree, they win,
except for the live-state section below, which rots faster.

**The one-sentence version:** a long-running TUI supervises several *lanes*; a
lane is one MCP server port plus the browser tab that serves it; v1 implements
`--mode exec` against the self-hosted stack and nothing else.

## 1. Where the work stands

Nothing is implemented. The package is three documents and this one.

- Branch `exp/headless-mcp`, **42 commits ahead of `origin/develop`, none pushed**
  and none to be pushed — `origin` is upstream `penpot/penpot`. The user pushes
  from their own shell, never you.
- The thing being replaced still works and is in use: `deploy/home-cluster/run-mcp-worker`
  (bash, 404 lines) and `run-mcp-worker.py` (curses). Do not break them. They are
  deleted in migration step 3 (SPEC §14), not before.
- `mcp/packages/host/` is the browser half being absorbed. `config.js` and
  `host.js` there are the working reference implementation of everything in
  `browser/` — read them before writing it.

## 2. The live environment

A working self-hosted Penpot is running on this host. It is the user's real
instance with real documents. **Treat it as production.**

```
penpot-frontend    0.0.0.0:9002->8080   public (Cloudflare)
                   127.0.0.1:9001->8080  the worker path — use this one
penpot-mcp         127.0.0.1:4601-4608   the published lane range
penpot-backend / postgres / valkey / exporter / mailcatch
```

- Compose project: `deploy/home-cluster/`. `docker compose ps` from there.
- Worker account: `deploy/home-cluster/worker/mcp-worker.env`, mode 600,
  gitignored. Holds origin, email, password, and an `mcp` token.
- Browser profiles: `~/.cache/penpot-headless/profile-<file-id prefix>`.
- A worker is probably running. Check before you start anything:

```sh
for p in $(ps -eo pid,args | grep 'host\.js' | grep -v grep | awk '{print $1}'); do
  tr '\0' '\n' < /proc/$p/environ | grep -E '^PENPOT_(ORIGIN|MCP_WS_URI|PROFILE_DIR)='; done
```

**Never kill a worker you did not start.** The user runs them against live
documents. Identify by `PENPOT_PROFILE_DIR` / `PENPOT_MCP_WS_URI` and kill by
explicit pid.

Tooling: Node **v24.20.0** (strips TypeScript natively — `node src/main.ts` runs
unflagged, no `tsx`), npm 12. The package uses npm, not pnpm, and is not in
`mcp/pnpm-workspace.yaml`.

## 3. How to verify anything

There is no substitute for driving the real stack. These are the moves that work.

**List ports actually listening inside the MCP container** — the host cannot tell
you, because Docker publishes the whole range:

```sh
cd deploy/home-cluster
docker compose exec -T penpot-mcp sh -c \
  'awk "\$4==\"0A\"{split(\$2,a,\":\");print a[2]}" /proc/net/tcp /proc/net/tcp6' \
  | sort -u | while read h; do printf '%d\n' "0x$h"; done | sort -n
```

Both files. The HTTP port binds IPv4 and the WebSocket binds IPv6; reading one
reports every WebSocket port as free.

**Map a container pid to its lane:**

```sh
docker compose exec -T penpot-mcp sh -c \
  'for p in $(ps -eo pid,args | grep "[n]ode index.js" | awk "{print \$1}"); do
     printf "%s " $p; tr "\0" "\n" < /proc/$p/environ | grep PENPOT_MCP_SERVER_PORT; done'
```

**Call an MCP endpoint by hand** — three requests: `initialize` (keep the
`mcp-session-id` header), `notifications/initialized`, then `tools/call`. Accept
must be `application/json, text/event-stream`. Responses come back as SSE
`data:` lines. A read-only probe that proves the whole chain:

```js
return { file: penpot.currentFile.name, page: penpot.currentPage.name,
         shapes: penpot.currentPage.findShapes().length };
```

**Get something large out of a browser** — the plugin sandbox can `fetch` the
host. Run a throwaway HTTP sink on `127.0.0.1`, then
`penpot.generateMarkup([shape], {type:"svg"})` and POST it. This is how a 272 KB
diagram was reviewed when `export_shape` was unavailable.

## 4. Build order

From SPEC §14, narrowed by the v1 scope. Each step leaves the tree working.

1. **`package.json`, `tsconfig.json`, `core/` + tests.** Pure, no I/O, nothing
   uses it yet. `core/target.ts` and `core/ports.ts` are where the historical
   bugs lived, so write their tests first and make them nasty: blank ids, absent
   ids, an IPv6-only busy port, a requested port outside the range.
2. **`exec/procnet.ts` + `exec/compose.ts`,** against captured `/proc/net/tcp`
   fixtures plus the shared `ExecBackend` contract test (API.md, last section).
3. **`supervisor/lane.ts` + `supervisor/supervisor.ts`** with fake `LaneDeps`.
   Assert the event sequence, that every `finally` ran, and that `open` refuses
   the combinations SPEC says it must.
4. **`browser/`,** ported from `mcp/packages/host/config.js` and `host.js`.
5. **`tui/`,** with `render` as a pure state → string function.
6. **Delete** `run-mcp-worker`, `run-mcp-worker.py`, `provision-worker` and
   `mcp/packages/host/`, updating `deploy/home-cluster/HANDOFF.md` in the same
   commit. Do not split this: two launchers in the tree is the state being left.

## 5. Settled — do not re-litigate

Each of these was argued and has its reasoning recorded. Reopen only with new
evidence, not new taste.

| decision | where |
| --- | --- |
| TypeScript run directly by Node; no build step, no `tsx` | SPEC §8 |
| hand-rolled supervisor over `AbortController`, not Effect | SPEC §14.1 |
| a lane is a plain async function, **not** an async generator | SPEC §5 |
| total ownership: quitting ends every lane; no detach, no CDP adoption | SPEC §14.2 |
| lanes share a browser, one tab each | SPEC §5 |
| the container runtime sits behind `ExecBackend` | SPEC §5, API.md |
| exposure is a deployment property, default `none` | SPEC §5 |
| v1 is `exec` + self-hosted only | SPEC §3b |
| package `mcp-headless` in `mcp/packages/headless` | SPEC §14.7 |

The eleven invariants in SPEC §11 are not style. Each cost real debugging. They
are listed with the module that must enforce each.

## 6. Traps in *this environment*

Design traps are in the specs. These are about working here.

- **`pkill -f` kills your own shell.** The pattern matches the command line that
  contains it; the tool returns exit 144 and your work is lost. Write the script
  to a file and run it, or match with `[b]racket` patterns, or kill by explicit
  pid. This happened four times.
- **Background processes die with the tool call.** Launch long-lived things with
  `setsid nohup … >/dev/null 2>&1 < /dev/null & disown`, or they are reaped when
  the invoking bash call ends or times out.
- **A relative `cd` fails when you are already there.** The working directory
  persists between tool calls and the environment reports changes. A failed `cd`
  in a `&&` chain silently skips the edit and the commit that follows may pick
  up unrelated staged work.
- **Never `git reset --hard` to "drop an empty commit"** without checking
  `git show --numstat` *first*. One looked empty, held 46 insertions, and the
  reset discarded them. Recovered from the reflog, but only by luck.
- **Secrets leak into logs and `ps`.** Worker env files hold a password and a
  token; a `docker run -e` command line is world-readable in `ps`. Pass secrets
  through a mode-600 `--env-file` and redact when echoing:
  `sed -E 's/(userToken=)[^ ]*/\1<redacted>/'`.
- **Editing a doc with a script?** Do the narrow replacement *before* any global
  rename, or the global one mutates your anchor and the assertion fails.

## 7. Repo conventions that gate every commit

From `AGENTS.md`; `./scripts/check-commit` enforces them and must exit 0.

- Subject **≤ 70 chars**, `:emoji: Capitalized, no trailing period`. `:memo:` is
  **not** an allowed emoji; `:books:`, `:wrench:`, `:sparkles:`, `:bug:`,
  `:recycle:`, `:zap:`, `:fire:`, `:lipstick:` are.
- Body lines wrap at **≤ 76 chars**. Measure them:
  `awk 'length > 76 {print NR": "length}' msg.txt`.
- Trailers: `AI-assisted-by: claude-opus-5` and
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Read `mem:workflow/creating-commits` (`.serena/memories/workflow/`) before
  committing. Never push. Never amend a pushed commit.
- Never pipe test output through `head`/`tail`/`grep` — redirect to a file and
  read the file.

## 8. Done, for v1

The TUI supervises several `exec` lanes against the self-hosted stack; opening,
closing and retrying work from the list; quitting ends every lane and leaves
nothing in the container; leftovers from a killed supervisor are reported and
reapable; `core/` and the lane state machine are unit tested; the `ExecBackend`
contract test passes against compose; and `run-mcp-worker`, `run-mcp-worker.py`
and `mcp/packages/host/` are gone.

The honest acceptance test is the one the old tooling never had: **open two
lanes on two documents, `SIGKILL` the supervisor, restart it, and confirm the
leftovers are reported rather than adopted — then reap them and confirm the
container is clean.**
