---
date: 2026-09-20 01:55
branch: exp/headless-mcp
host: twlight-sparkle
user: mono
tldr: Turned the headless-MCP spike into a working self-hosted Penpot deployment with Authelia SSO, separate worker accounts, and a TUI launcher running one worker per document.
---

# Journal: self-hosted Penpot, headless MCP workers, Authelia SSO

## Intent

Continue the `exp/headless-mcp` spike (commits `667f45a`, `fa24e90`, which drove
penpot cloud) by standing up a local instance for personal use. That grew into a
real deployment: public UI behind Cloudflare Access with Authelia as the IdP, a
private path for automation, worker accounts provisioned from the CLI, and an
interactive launcher for driving one document per worker.

## What happened

### Local instance, and what it erased

Stood up the official 2.17 images from `docker/images/docker-compose.yaml`. A
self-hosted instance deletes most of the spike's hard-won findings rather than
adding to them: the compose already ships a `penpot-mcp` service that nginx
proxies at the app's own origin, which is exactly where `app.config/mcp-ws-uri`
already points. So no `penpotMcpServerURI` injection, no private-network block
(both ends loopback), and no Cloudflare bot check — meaning Playwright's bundled
Chromium works and Google Chrome need not be installed at all.

Refactored the host into a shared `config.js` that picks topology by origin, and
gave `login.js` a non-interactive path. Verified end to end.

### Deployment for the home cluster

Built `deploy/home-cluster/` — stock images, no mounts, hardened flags, Authelia
OIDC with endpoints read from the live discovery document, and **two frontend
containers**. The two frontends are the one piece that looks redundant and is
not: the frontend bakes `PENPOT_PUBLIC_URI` into `js/config.js` at startup and
every URL derives from it, so one value cannot serve both a public hostname and
a loopback one.

The user later ran it for real: signed in through Authelia and was provisioned
on first login with `auth_backend = oidc`, proving the tunnel, the Access policy
and the OIDC round trip together.

### Per-document workers

Penpot's plugin API has no `openFile` — every accessor reads a single global
`current-file-id` — so one browser page drives one file. Discovered that running
several documents needs no code and no extra accounts: the one-connection-per-
token rule is enforced by a **per-process** map, and single-user mode skips
tokens entirely. So one stock MCP server per document, started with
`docker compose exec` inside the stock container, which also guarantees the
server and the frontend-bundled plugin can never be version-skewed.

Wrote `run-mcp-worker` (shell engine) and `run-mcp-worker.py` (curses TUI, in
the shape of the user's own `@linux-start-vnc.py`), plus `provision-worker` for
CLI account/token management.

### Accounts

Settled on separate accounts: people via Authelia (no password), workers via
`manage.py` (password, because their login is non-interactive). A worker reaches
other people's documents by ordinary team invitation, which it accepts itself
over RPC.

## Discoveries / Quirks

- **A workspace URL needs `team-id` as well as `file-id`.** Without it the page
  loads, authenticates, opens its websockets and renders *nothing* —
  `team-container*` (`frontend/src/app/main/ui.cljs:187`) returns empty with a
  clean console. The most expensive failure mode in this system, hit twice.
- **Three distinct caches masked fixed configuration**, costing hours in total:
  the browser profile served a stale MCP plugin; Cloudflare's edge served a
  stale `js/config.js` for 7 days (`cache-control: max-age=604800`) even though
  the entrypoint rewrites that file on every container start; and Python's
  `http.cookiejar` silently refused to *send* a `Secure` cookie over loopback
  http, where browsers special-case localhost.
- **The MCP server and the MCP plugin are one version-matched pair**, and the
  plugin ships inside the *frontend* image. A develop-built server against a
  2.17 plugin fails with "the Penpot plugin tab appears to be suspended" —
  nothing is suspended, the older plugin simply sends no heartbeat.
- **Stock `penpotapp/mcp:2.17` runs an unauthenticated REPL on 4403** with a
  `POST /execute` that runs code against the connected plugin. No env disables
  it in that build; it is unpublished and unproxied, so the blast radius is the
  compose network.
- **`disable-registration` closes only the public signup form.** The check lives
  in the RPC path (`validate-register-attempt!`); `manage.py` reaches the backend
  over PREPL and calls `create-profile` directly, never passing it.
- **`Secure` cookies work over `http://localhost`** — Chromium treats loopback as
  trustworthy. Verified, because the whole two-frontend design depends on it. A
  LAN hostname does *not* qualify, so a remote worker must SSH-forward and keep
  saying localhost.
- **Docker's published port range holds every host port in it** whether or not
  anything listens behind it, so free ports cannot be found from the host — the
  container has to be asked.
- **Penpot's UUIDs are time-ordered**, so records created moments apart share a
  long prefix; disambiguate on the tail.
- Killing a `docker compose exec` client does **not** stop the process inside the
  container.

## Changes

- `mcp/packages/host/` — new `config.js` (shared, env-driven topology);
  `host.js`, `spikes/context.js`, `spikes/login.js` rewired to it; non-interactive
  login; README and HANDOFF updated with findings 8-14.
- `deploy/home-cluster/docker-compose.yaml` — two frontends, one backend, stock
  images, hardened flags, Authelia OIDC, `0.0.0.0` frontends with mailcatch kept
  on loopback, a published port range for per-document servers, and an opt-in
  `penpot-mcp-worker` container (stock Playwright image, repo mounted read-only,
  `network_mode: host`).
- `deploy/home-cluster/run-mcp-worker` — foreground runner; `builtin`/`exec`/
  `local` server modes, headed/headless, auto port selection, version-skew
  warning, in-container pid tracking.
- `deploy/home-cluster/run-mcp-worker.py` — curses TUI that lists documents from
  the live instance across all teams and execs the runner.
- `deploy/home-cluster/provision-worker` — idempotent CLI account provisioning:
  create/reset, repeatable `--invite`, MCP token, env file.
- `deploy/home-cluster/HANDOFF.md` — 13-section guide for the cluster manager.
- Removed: `worker-start.sh`/`worker-stop.sh` (redundant), the `cloudflared`
  compose service (out of scope — ingress belongs to the cluster).

## Open threads

- **No backups.** `pg_dump` plus the assets volume, on a timer. Now matters:
  there is real work in `ihate-workspace`.
- **`deploy/home-cluster/` lives inside an upstream `penpot/penpot` clone.** Fine
  on this branch, must never ride along in a PR; its own repo is the cleaner home.
- **Nothing pushed** — `origin` is upstream, so 15 commits exist only locally.
- `mcp/packages/host/` still carries cloud-era scaffolding (PAT spikes, `inject`
  mode, Cloudflare notes) that the deployment no longer needs — some evidence
  worth keeping, some dead weight.
- Untested: large imports against Cloudflare's 100 MB body cap, and the
  notifications socket over a long Access session.
- Upstream-shaped: `/js/config.js` should not be served with a 7-day
  `cache-control`; a PR is reportedly coming.
