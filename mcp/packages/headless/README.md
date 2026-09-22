# mcp-headless

A long-running supervisor and TUI for headless Penpot MCP **lanes**. A lane is
one MCP server port plus the browser tab that serves it, driving one document.

The point is to decouple an agent's MCP connection from a person's own Penpot
tabs: the launcher opens lanes, holds them, and ends every one it started.

Status: **being built.** See [PLAN.md](PLAN.md) for what exists and what is next.

## Documents

| document | answers |
| --- | --- |
| [SPEC.md](SPEC.md) | what the launcher is and how it supervises |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the system it drives; the four modes |
| [API.md](API.md) | the directory-level interfaces and why each is shaped so |
| [PLAN.md](PLAN.md) | the build order, one task per worktree |
| [IMPL-HANDOFF.md](IMPL-HANDOFF.md) | the live environment and its traps |

## Running the checks

```sh
pnpm install                       # once, in this directory
pnpm exec playwright install chromium   # once per machine; see below
pnpm run test                      # node:test over src/**/*.test.ts
pnpm run types:check               # tsc --noEmit
```

Tests that need a real browser or the live stack are gated behind
`MCP_HEADLESS_E2E=1` and skip by default:

```sh
MCP_HEADLESS_E2E=1 pnpm run test
```

TypeScript runs directly: Node strips types from 23.6 on, so there is no build
step and no loader. Imports carry the `.ts` extension, which is what Node
resolves at runtime.

Formatting comes from the parent: `pnpm -C .. run fmt` uses `mcp/.prettierrc`.

## Using it

`mcp-headless` opens the list. It holds every lane it starts and ends all of
them when you quit — a lane that outlived its supervisor is exactly the
leftover the startup scan exists to report.

| key | in the list | in the form |
| --- | --- | --- |
| `n` | new lane | — |
| `enter` | details for the selected lane | open a list, pick from an open one, or start from the `start` row |
| `escape` | leave details | close an open list, or leave the form |
| `space` | — | toggle headless and headed |
| `tab`, `↑`, `↓` | move the selection | move between rows, or within an open list |
| `←` `→` | — | step a list without opening it |
| `s` / `r` / `l` | stop · retry or reap · logs | — |
| `q` | quit, after confirming | — |

The form is prefilled from the account files and from a live list of each
account's documents, shown as `team / document`. If Penpot cannot be reached
the ids can still be typed, which is what the old tooling always required.

## Configuration

Two files, in `$XDG_CONFIG_HOME/mcp-headless` (so `~/.config/mcp-headless` by
default). `--config DIR` points somewhere else; `MCP_HEADLESS_CONFIG` does the
same from the environment.

```
~/.config/mcp-headless/
  deployment.json         which container the MCP servers run in
  tui.json                optional: what the lane list shows
  accounts/<name>.env     one per worker account, mode 600
```

`deployment.json` selects and configures the exec backend. It is the only place
that knows a container runtime exists, and leaving it out is not an error --
without it `--mode exec` is unavailable and everything else still works.

```json
{
  "backend": "compose",
  "projectDir": "/path/to/deploy/home-cluster",
  "service": "penpot-mcp",
  "portRange": [4601, 4616]
}
```

`projectDir` is resolved against the directory the file is in, so an absolute
path is the safe spelling when configuration lives outside the repo.

`tui.json` chooses the columns and their order. `--columns port,client` does
the same for one run and wins over the file. The columns are `port`, `state`,
`document`, `team`, `account`, `browser`, `display`, `mode`, `uptime` and
`client`; an unknown name is refused rather than dropped.

```json
{ "columns": ["port", "state", "team", "document", "client"], "statusBar": true }
```

The status bar under the list carries what the columns truncate — both ids in
full and the URL an agent connects to — which is what lets the document and
team columns show names instead of uuids.

An account file is the shape `provision-worker` writes, unchanged, so the
existing ones keep working:

```sh
PENPOT_ORIGIN="http://localhost:9001"
PENPOT_EMAIL="worker@example.test"
PENPOT_PASSWORD="…"
PENPOT_FILE_URL="http://localhost:9001/#/workspace?team-id=…&file-id=…"
PENPOT_MCP_URL="http://localhost:9001/mcp/stream?userToken=…"
PENPOT_PROFILE_DIR="$HOME/.cache/penpot-headless/profile-worker"
```

Both ids in `PENPOT_FILE_URL` matter: they prefill the new-lane form. An empty
`file-id` is tolerated -- an account provisioned without a scratch file has one
-- but then nothing is prefilled and the ids have to be typed.

**Symlink rather than copy.** An account file holds a password and a token, so
it should exist once. Pointing at the one `provision-worker` already wrote
keeps regeneration working and avoids a second copy going stale:

```sh
mkdir -p ~/.config/mcp-headless/accounts
chmod 700 ~/.config/mcp-headless ~/.config/mcp-headless/accounts
ln -s /path/to/deploy/home-cluster/worker/mcp-worker.env \
      ~/.config/mcp-headless/accounts/mcp-worker.env
```

## Dependencies

This package keeps its own `pnpm-lock.yaml` and is **not** a member of
`mcp/pnpm-workspace.yaml`, so Playwright stays out of the MCP server's lockfile.
Playwright is pinned to the exact version the repo root and `frontend` pin,
because the browser build is pinned on purpose. The install script is blocked
in `pnpm-workspace.yaml`, so the browser download is a separate one-time step
per machine -- that keeps a fresh checkout's install under a second, and the
browsers are shared by every checkout through `~/.cache/ms-playwright`.
