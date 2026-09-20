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
pnpm install          # once, in this directory
pnpm run test         # node:test over src/**/*.test.ts
pnpm run types:check  # tsc --noEmit
```

TypeScript runs directly: Node strips types from 23.6 on, so there is no build
step and no loader. Imports carry the `.ts` extension, which is what Node
resolves at runtime.

Formatting comes from the parent: `pnpm -C .. run fmt` uses `mcp/.prettierrc`.

## Dependencies

This package keeps its own `pnpm-lock.yaml` and is **not** a member of
`mcp/pnpm-workspace.yaml`, so Playwright stays out of the MCP server's lockfile.
Playwright is pinned to the exact version the repo root pins, because the
browser build is pinned on purpose.
