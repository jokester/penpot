# Deploying Penpot on the home cluster

Everything needed to stand this up, for someone who has not seen the design
discussion. Written 2026-09-18.

Penpot is a self-hosted design tool. This deployment serves people over the
public internet behind Cloudflare Access with Authelia as the identity
provider, and serves an MCP worker over a private path that never
touches Cloudflare.

## 1. Shape of the thing

```
people                                                      shared backend
  browser ─▶ Cloudflare Access ─▶ cloudflared ─▶ frontend-public :9002 ─┐
               GitHub / Authelia                                        │
                                                                        ├─▶ backend  :6060
worker                                                                  │   exporter :6061
  browser (worker) ────────────────────────────▶ frontend-local :9001 ──┘   mcp :4401 :4402
  MCP client ─────────────────────────────────▶ same, /mcp/stream           postgres / valkey
```

### Connect exactly one thing to the internet

| | |
| --- | --- |
| **service** | `penpot-frontend` |
| **host** | the Docker host running this compose file |
| **port** | `${PENPOT_PUBLIC_PORT}`, default **9002** (container port 8080) |
| **protocol** | plain HTTP; Cloudflare terminates TLS |
| **health check** | `GET /readyz` |

Point the Cloudflare tunnel at `http://<this-host>:9002` and put the Access
policy on the hostname. Running the tunnel is out of scope for this file — it
belongs to whatever manages the cluster's ingress, not to Penpot.

**Nothing else goes to the tunnel.** The same container also publishes port
9001, the worker path, on loopback only and with no Access in front of it — that
one must stay private. And above all not the mail catcher, whose web UI lists
every password-reset link the instance sends.

Port 9002 binds `${PENPOT_BIND}`, `0.0.0.0` by default, so an ingress on another
host can reach it. That also means **anything on the LAN reaches port 9002
without passing Cloudflare Access**. On a network where that matters, set
`PENPOT_BIND=127.0.0.1` and run cloudflared on this host. Port 9001 is pinned to
`127.0.0.1` regardless.

## 2. Why one frontend serves two origins

This deployment used to run two frontend containers, one per origin. It does
not any more, and the reason is worth recording because the old rationale looks
compelling and is incomplete.

The frontend entrypoint bakes `PENPOT_PUBLIC_URI` into `js/config.js` at
startup, and every URL the running app dials derives from that single value —
the API, the notifications socket, the render worker, and the MCP socket
(`frontend/src/app/config.cljs:185`). One value cannot be both
`https://penpot.example.org` and `http://localhost:9001`, so it looked as
though each audience needed its own nginx.

It does not, because the variable can simply be left unset. The entrypoint
writes the line only when it is non-empty:

```bash
if [ -n "$PENPOT_PUBLIC_URI" ]; then
    echo "var penpotPublicURI = \"$PENPOT_PUBLIC_URI\";" >> "$1";
fi
```

and `app.config/public-uri` falls back to the browser's own origin when it is
absent (`frontend/src/app/config.cljs:181`):

```clj
(def public-uri
  (normalize-uri (or (obj/get global "penpotPublicURI")
                     (obj/get location "origin"))))
```

So the app configures itself per request, from the origin the browser actually
arrived on, and `mcp-ws-uri` follows. nginx is `server_name _`, so the Host
header does not matter either. One container publishes 8080 twice: 9002 for the
public hostname and 9001 on loopback for the worker.

Verified, not assumed: a frontend with no `PENPOT_PUBLIC_URI` served
`js/config.js` with no origin line, proxied RPC normally, and a worker drove a
real document through it end to end.

Two consequences:

- **The Cloudflare cache trap in section 13 is gone.** `js/config.js` no longer
  differs by origin, so an edge cache cannot serve the wrong one. Keeping the
  bypass rule costs nothing and is still advisable on principle.
- **Flags are now shared.** The old split gave the public origin
  `disable-login-with-password` and the worker origin
  `enable-login-with-password`; merged, both show the password form. That is
  cosmetic in both directions — the backend always accepts passwords, which is
  how the worker logs in, and Cloudflare Access is the real gate on 9002.

The **backend** keeps its own `PENPOT_PUBLIC_URI`. That one is load-bearing: it
builds email links and the OIDC `redirect_uri`, which must name the public host.

The session cookie carries no `Domain` attribute, so each origin still gets its
own host-only cookie against the same account.

## 3. What you must provide

- A host with Docker and Compose.
- A public hostname, e.g. `penpot.example.org`.
- A Cloudflare tunnel and an Access application for that hostname.
- An OIDC client registered in Authelia (`https://id.ihate.work`).
- Backup storage for one Postgres database and one assets volume.
- A checkout of this repository on the Docker host. The worker container
  mounts it read-only; nothing else needs it.

Everything runs in containers. Nothing needs Node, pnpm or a browser installed
on the host.

## 4. Register the OIDC client in Authelia

Penpot's callback path is fixed at `/api/auth/oidc/callback`
(`backend/src/app/auth/oidc.clj:459`).

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: penpot
        client_name: Penpot
        # Authelia stores this hashed. Generate the pair with:
        #   authelia crypto hash generate pbkdf2 --variant sha512
        client_secret: '$pbkdf2-sha512$...'
        public: false
        authorization_policy: two_factor
        redirect_uris:
          - https://penpot.example.org/api/auth/oidc/callback
        scopes: [openid, profile, email]
        token_endpoint_auth_method: client_secret_basic
        # Penpot reads userinfo as JSON. Authelia can return a signed JWT
        # instead, which Penpot will not parse. See the troubleshooting note.
        userinfo_signed_response_alg: none
```

Keep the **plaintext** secret for `.env`; Authelia gets the hash.

Penpot requests `openid profile email` by default and reads the `email` and
`name` claims. Authelia publishes both.

## 5. Cloudflare

Tunnel ingress:

```yaml
ingress:
  - hostname: penpot.example.org
    service: http://127.0.0.1:9002
  - service: http_status:404
```

Add a self-hosted Access application for the hostname and attach your GitHub
and Authelia identity providers. WebSockets pass through Access on their own;
the `CF_Authorization` cookie rides the upgrade because it is same-origin.

**Do not put Authelia behind this Access application.** It is the identity
provider Access depends on; gating it creates a loop.

## 6. Configure and start

```bash
cd deploy/home-cluster
cp .env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(64))"   # PENPOT_SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(24))"   # POSTGRES_PASSWORD
$EDITOR .env
docker compose up -d
```

`AUTHELIA_INTERNAL_URI` is what the **backend container** can reach. If the
cluster has no internal route to Authelia, set it equal to
`AUTHELIA_PUBLIC_URI`. Whatever hostnames appear in either URI must also be
listed in `PENPOT_SSRF_ALLOWED_HOSTS`, or the backend refuses the token call
and login dies after the redirect.

## 7. Accounts: people and workers

Two kinds, created two ways.

**People** log in through Authelia and are provisioned on first login, thanks
to `enable-oidc-registration`. Nothing to do in advance.

`disable-registration` closes the public signup form, and only that: the check
lives in the RPC path (`validate-register-attempt!`), so SSO is the only door
**from outside**. It is not the only door. `manage.py` reaches the backend over
PREPL and calls `create-profile` directly, never passing that check, which is
how worker accounts get made on a locked-down instance. PREPL binds loopback
inside the backend container, so that door opens only to whoever can already
`docker compose exec` — who has the database anyway.

**Workers** are ordinary Penpot accounts that happen to have a password,
because their login is non-interactive. Keep them separate from your own: the
password and an MCP token sit on disk, and a separate account bounds what a
leak reaches. It also keeps the audit trail honest about who drew what.

"Worker" rather than "agent" throughout: the worker is the browser that hosts
Penpot's MCP plugin and executes what arrives over the transport. Whatever
connects to the other end is usually an LLM agent, and calling both the same
thing makes every sentence ambiguous.

```bash
./provision-worker --email worker-a@penpot.local
```

That creates the profile, enables MCP, mints its token, dismisses onboarding,
makes a scratch file, and writes `worker/worker-a.env` with a generated
password. Repeat it per worker; each gets its own env file, and the launcher
lists them all under Account.

Re-running it is safe, and is how you add a team, rotate the MCP token, or
rewrite a lost env file. The profile is created once; `--reset-password` sets a
new password on an account that already exists (its old one lives only in the
env file, so there is nothing else to recover it from), and an invitation that
has already been accepted is reported and skipped.

### Letting a worker into your documents

A fresh worker sees only its own scratch project. To let it work on your files,
invite it into your team from Penpot (Team > Invitations, role Editor), copy
the invitation link, and hand it over:

```bash
./provision-worker --email worker-a@penpot.local --invite '<link or token>'
```

Pass `--invite` more than once to join several teams in one run; a worker
belongs to as many as it has been invited to. The worker accepts each
invitation itself, so the only manual step is the invite you would make for any
collaborator. Afterwards the launcher lists that team's
documents alongside its own, and a worker driving a file in someone else's team
needs **both** ids in the workspace URL — the launcher passes `--team-id` as
well as `--file-id` for exactly this reason.

### Where the browser runs: `--browser host|container`

There is no worker compose service any more, but the browser can still run in a
container. `run-mcp-worker --browser container` starts it inside the pinned
Playwright image instead of using the host's Playwright install, and **headed
works either way** — the container draws on your X server through the mounted
socket.

| | `--browser host` (default) | `--browser container` |
| --- | --- | --- |
| browser build | `mcp/packages/host/node_modules` + host Playwright cache | `/ms-playwright` inside the image |
| version pinned by | whatever `playwright install` last fetched | the image tag |
| needs | nothing extra | docker, and the image (~2.5 GB, pulled once) |
| headed | yes | yes, via `/tmp/.X11-unix` |

Use `container` when you want the browser version fixed — an upgrade of the
host's Playwright cannot then change what the worker runs. The tag defaults to
`mcr.microsoft.com/playwright:v<installed playwright version>-noble`, read from
the mounted `node_modules`, because the client and the browsers must agree.
Override with `PENPOT_WORKER_IMAGE`.

Four details of the container invocation are deliberate:

- **`--network host`.** Hardened session cookies are `Secure`, so the browser
  keeps them only for a trustworthy origin. `localhost` qualifies; a container
  hostname does not, and the cookie is silently dropped — login appears to
  succeed and nothing works. The host namespace also lets the browser reach an
  `--mcp exec` server on `127.0.0.1`.
- **`--user $(id -u):$(id -g)`.** Keeps the browser profile owned by you instead
  of root, and lets the container read your `~/.Xauthority`.
- **`--ipc host`.** Chromium dies on the default small `/dev/shm`.
- **Environment goes through a mode-600 `--env-file`, never `-e`.** A
  `docker run` command line is world-readable in `ps`, and `PENPOT_PASSWORD`
  would sit in it for the life of the worker. The file is removed by the same
  cleanup that stops the in-container MCP server.

For headed runs the X socket is mounted rather than used over TCP, because
TigerVNC listens on 5903 for VNC but publishes no X11 TCP port. The xauth cookie
is keyed by hostname, which `--network host` preserves.

To survive a reboot, wrap `run-mcp-worker` in a user systemd unit. It already
runs in the foreground and cleans up after itself, which is what such a unit
wants.

### One worker per document

Penpot's plugin API has no `openFile` — every accessor reads a single global
current-file-id — so a browser page can only ever drive the file it has open.
More documents means more workers, and each needs its own MCP server, because
the server allows one plugin connection per token.

`./run-mcp-worker.py` is the interactive way in: a small curses form asking for
the account, the document, the server mode and the port, which then execs
`./run-mcp-worker`. It lists the account's documents from the running instance,
so the usual answer is to arrow to the right one and press Enter. `--last`
reuses the previous answers without the form; `--dry-run` prints the command.

```bash
./run-mcp-worker.py                  # pick and start
./run-mcp-worker.py --last           # same answers as last time
./run-mcp-worker --mcp exec --file-id <uuid> --headed   # the shell runner
```

Three server modes:

| `--mcp` | what it starts | when |
| --- | --- | --- |
| `builtin` | nothing; uses the instance's shared server | a single document |
| `exec` | a single-user server **inside** the stock penpot-mcp container | a second, third… document |
| `local` | the build in `mcp/packages/server/dist` | hacking on the server |

`exec` is the one to reach for. It runs the same bundle that serves the plugin,
so the two can never be version-skewed, it needs no build and no extra image,
and single-user mode takes no token at all — your MCP client just connects to
`http://127.0.0.1:<port>/mcp`. Ports come from the range the compose file
publishes (`PENPOT_DOC_PORT_MIN`..`MAX`, default 4601-4608) and are picked
automatically.

**Let it pick them.** A `--port` outside that range starts a server that works
perfectly and that nothing can reach: the MCP client gets `ConnectionRefused`,
and since the browser runs on the host too, the plugin cannot reach the
WebSocket either, so the worker sits connected to nothing. Both the HTTP port
and the WebSocket port (HTTP + 1 unless `--ws-port` says otherwise) have to be
inside the range. `run-mcp-worker` now refuses out-of-range and already-taken
ports instead of starting something unreachable.

Each document also gets its own browser profile, keyed by file id, so workers
do not fight over one profile directory.

Two things this had to work around, both worth knowing before changing it:

- **Free ports cannot be found from the host.** Docker publishes the whole
  range, so every port in it shows as `LISTEN` on the host whether or not
  anything sits behind it. The runner asks the container instead.
- **A `docker compose exec` client dying does not stop the process inside the
  container.** The exec'd server records its pid to `/tmp/mcp-<port>.pid` and
  the runner kills it on the way out.

`--headed` needs a DISPLAY this shell is authorised on. Run it from inside the
VNC session, or export that session's `DISPLAY` **and** `XAUTHORITY`. When the
cookie does not match, Playwright says only "Target page, context or browser has
been closed" with empty browser logs; the real message is on the browser's
stderr.

Two `builtin` runs both want the instance's shared server, so only one of them
can hold it — the second plugin connection is rejected. Use `--mcp exec`, which
gives each worker a server of its own; that is also the only mode that scales
past one document.

Either way, the workspace URL needs **both** `team-id` and `file-id`, and an
MCP client connects to the `PENPOT_MCP_URL` from `worker/worker.env`. That
`userToken` is a secret granting `execute_code` against whatever file the
worker holds open; it does not expire, and regenerating it deletes the old one.

A worker on a *different* machine from Penpot forwards the port and keeps
calling it localhost, for the same trustworthy-origin reason:

```bash
ssh -N -L 9001:127.0.0.1:9001 <penpot-host>
```

## 8. Verify, in this order

Each step fails differently, so do not skip ahead.

1. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9002/readyz` → `200`.
   This is the endpoint the tunnel health-checks.
2. `curl -s http://127.0.0.1:9002/js/config.js | grep penpotPublicURI`
   → **no output**. The frontend must not bake an origin in; if a line appears,
   `PENPOT_PUBLIC_URI` has leaked into the frontend service and the worker path
   will dial the public hostname and hit Access. See section 2.
3. Browse the public hostname. Access challenges, then Authelia, then Penpot
   loads. A password form is present and harmless; Access is the gate.
4. Open `http://localhost:9001` on the Penpot host — or SSH-forward 9001 from
   elsewhere — and log in as the worker with its password. It must be
   `localhost`: a LAN hostname over plain HTTP is not a trustworthy origin and
   the `Secure` session cookie is dropped.
5. Log in and check `Set-Cookie` carries `Secure; HttpOnly` and **no**
   `Domain`.
6. Settings → Integrations → enable MCP, and copy the connection URL.
7. `./run-mcp-worker --mcp exec --headless` → ends with
   `plugin connected to ws://localhost:<ws-port>`.

## 9. Ports and endpoints, as measured

Audited on a stack built from this file, 2026-09-18. Docker's embedded DNS
(127.0.0.11) appears in every container and is omitted.

| service | listens on | bound to | published to host |
| --- | --- | --- | --- |
| **penpot-frontend** | 8080 | container network | **`${PENPOT_BIND}:9002`** ← the tunnel target |
| penpot-frontend | 8080 | container network | `127.0.0.1:9001` (worker only, same container) |
| penpot-backend | 6060 | container network | no |
| penpot-backend | 6063 (PREPL) | **127.0.0.1 inside its own container** | no |
| penpot-exporter | 6061 | container network | no |
| penpot-mcp | 4401, 4402 | container network | no |
| penpot-mcp | ~~4403 (REPL)~~ | **suppressed, does not listen** | no |
| penpot-postgres | 5432 | container network | no |
| penpot-valkey | 6379 | container network | no |
| penpot-mailcatch | 1025, 1080 | container network | `127.0.0.1:1080` |

Only the two published nginx ports and the mail catcher reach the host, and all
three come from one nginx plus one mail container. 9002 follows `PENPOT_BIND`
(`0.0.0.0` by default); 9001 and the mail catcher are pinned to loopback. Only
port 9002 is meant to reach the tunnel.

PREPL is better protected than it first appears: it binds loopback *inside* the
backend container, so no other container can reach it either.

### The MCP REPL on 4403 is suppressed

The stock MCP image builds an HTTP REPL that serves a web console at `/` and
accepts `POST /execute`, running the posted code against the connected Penpot
plugin. In 2.17 it is constructed unconditionally: `PENPOT_MCP_REPL_ENABLE`,
which gates it in later builds, does not exist in that bundle.

`PENPOT_MCP_REPL_PORT` *does* exist, so the compose file aims the REPL at 4401 —
the port the MCP server itself binds first. The REPL loses the race, and the
failure is silent and harmless: the log still claims "REPL server started", but
no socket appears and the process runs normally. `run-mcp-worker` does the same
for each `--mcp exec` server, pointing the REPL at that server's own port.

Measured after the change: the container listens on 4401 and 4402 only, `/` on
4401 returns the MCP server's own 404 rather than the console, and a full
`execute_code` round trip against a real document still succeeds.

To evaluate the REPL later, give a throwaway server a port of its own — nothing
in the compose file needs changing:

```sh
docker compose exec -e PENPOT_MCP_SERVER_PORT=4699 \
    -e PENPOT_MCP_WEBSOCKET_PORT=4698 -e PENPOT_MCP_REPL_PORT=4403 \
    penpot-mcp node index.js
# from another shell, inside the container -- it is routable nowhere else:
docker compose exec penpot-mcp curl 127.0.0.1:4403/
```

Or `./run-mcp-worker --mcp exec --repl`, which puts it on the server port plus 2.

### HTTP surface through nginx

Nineteen routable locations. The ones that matter: `/api` (156 RPC commands on
`/api/rpc/command/:method-name`, all session-gated), `/ws/notifications`,
`/mcp/ws`, `/mcp/stream`, `/mcp/sse`, `/api/export`, `/readyz`. The rest serve
static assets, plugins, fonts and the SPA. `/internal/assets` carries nginx's
`internal` directive and cannot be requested from outside.

The MCP server itself exposes three HTTP routes on 4401 — `/mcp`, `/sse`,
`/messages` — plus the plugin WebSocket on 4402 and the REPL above.

## 10. Operating it

**Back up two things**: the Postgres database and the assets volume.

```bash
docker compose exec -T penpot-postgres pg_dump -U penpot penpot | gzip > penpot-$(date +%F).sql.gz
docker run --rm -v home-cluster_penpot_assets:/a -v "$PWD":/out alpine \
  tar czf /out/penpot-assets-$(date +%F).tar.gz -C /a .
```

**Back up `PENPOT_SECRET_KEY` separately.** Every subsystem key derives from
it. Losing or changing it invalidates all sessions and pending invitations.

**Pin `PENPOT_VERSION`.** Do not track a floating tag. Watch Penpot's security
advisories and upgrade deliberately; read the release notes first, because
database migrations run on start.

## 11. Limits and traps

- **Cloudflare caps request bodies** well below Penpot's 350 MiB on
  non-Enterprise plans (100 MB at the time of writing). Large `.penpot`
  imports will fail through the public hostname and succeed over the SSH
  forward. Use the private path for bulk import and export.
- **Cloudflare times out HTTP requests at 100 seconds.** Ordinary editing is
  far below this; very large exports may not be.
- **Mailcatch holds every message the instance sends**, password-reset links
  included. It is bound to loopback on purpose. Never route it through the
  tunnel. Point `PENPOT_SMTP_*` at a real relay if resets must work off-host.
- **One unauthenticated REPL runs inside the network**: the backend's PREPL on
  6063, which `manage.py` needs and which binds loopback inside its own
  container. The MCP server's REPL on 4403 is suppressed; section 9 says how.
- **`enable-rpc-climit` needs a config file the image does not ship.** The
  source tree's `backend/resources/climit.edn` is an example and is not in the
  uberjar, and the default setting points at a relative path that does not
  exist in the container. Without a file the backend crash-loops on
  `NoSuchFileException: resources/climit.edn`. This deployment carries its own
  `climit.edn` and mounts it; `PENPOT_RPC_CLIMIT_CONFIG` names it absolutely.
- **`enable-sec-fetch-metadata-middleware` does not block MCP or scripts.** It
  403s cross-site requests using unsafe methods. A non-browser client sends no
  `Sec-Fetch-Site` header at all and falls through to the permissive branch, so
  agents, `curl` and the MCP server are unaffected. Measured: cross-site POST
  403, same-origin POST 200, header-less POST 200.
- **`export_shape` needs `enable-wasm-export`, and it is frontend-only.**
  Without it the plugin's `shape.export()` round-trips through the exporter, and
  the asset URL that comes back names `PENPOT_HOST`. A worker talking to
  `localhost` cannot fetch that, so every export dies on *"unable to perform
  fetch operation"*. With the flag, png/jpeg/webp render in the browser to a
  `blob:` URI and never leave it. Two caveats: **SVG is not covered** — the
  plugin's wasm branch takes only those three types, so SVG still goes through
  the exporter and still fails on a worker; and it only helps files carrying the
  **`render-wasm/v1`** feature, which is assigned when the file is created, not
  retroactively. Check with `select name, features from file where name = '…';`
  The flag is set on `penpot-frontend` alone, so applying it recreates only that
  container — but a worker keeps the flags its page loaded with, so an already
  running worker needs a restart before it sees the change.
- **`disable-login-with-password` on the public frontend is cosmetic.** It
  hides the form. The backend still accepts passwords, because the worker needs
  them. Cloudflare Access is the real gate.

## 12. Troubleshooting

**Login redirects to Authelia and returns to an error.** The browser leg
worked and the server leg did not. Check `PENPOT_SSRF_ALLOWED_HOSTS`, then
whether the backend container can actually resolve `AUTHELIA_INTERNAL_URI`
(`docker compose exec penpot-backend curl -sv <uri>/jwks.json`).

**Login fails at the userinfo step.** Authelia may be returning a signed JWT.
Either set `userinfo_signed_response_alg: none` on the client, or add
`PENPOT_OIDC_USER_INFO_SOURCE: token` to the backend so Penpot reads claims
from the ID token instead.

**Role restriction never matches.** `PENPOT_OIDC_ROLES_ATTR: groups` needs the
`groups` claim, which needs the `groups` scope — and Penpot's default scope set
is only `openid profile email`. Add `PENPOT_OIDC_SCOPES: "openid profile email
groups"` and the scope to the Authelia client.

**A workspace page loads blank with a clean console.** The URL is missing
`team-id`. Penpot needs both `team-id` and `file-id`; with only a file id the
page authenticates, opens its sockets, and renders nothing.

**Penpot says the plugin tab is suspended.** Two causes, neither of them a
suspended tab. Either the MCP server and the frontend-bundled MCP plugin are
different versions, or a browser profile is serving a cached copy of the old
plugin. Both are covered in `mcp/packages/host/README.md`.

## 13. What was and was not tested

Verified on a real stack built from this compose file, on 2026-09-18: both
frontends render the correct `PENPOT_PUBLIC_URI` and flag sets; the hardened
`Secure` cookie is accepted over `http://localhost` (Chromium treats loopback
as a trustworthy origin); `manage.py` account creation; worker login; and the
full MCP path — `execute_code`, `high_level_overview`, `penpot_api_info` and
`export_shape` — driving a file with no human tab open, via `run-mcp-worker`
both headless and `--headed` on a VNC display, and from a worker container that
has since been removed. Two
documents were driven at once through separate servers, and a second worker
account created by `provision-worker` joined another account's team from an
invitation and wrote into that team's file. The
port table in section 9 was read from the running containers, not inferred.

Since verified on the real deployment: the Cloudflare tunnel, the Access
policy, and the Authelia OIDC round trip all work — a person signed in through
Authelia and was provisioned on first login, arriving with `auth_backend =
oidc`, exactly as `enable-oidc-registration` intends.

One trap the tunnel adds, found the hard way: **Cloudflare caches
`/js/config.js` at the edge for seven days.** Penpot serves it with
`cache-control: public, max-age=604800` like any other static asset, but the
frontend entrypoint rewrites it on every container start, so it is the one file
that must never be cached. Change `PENPOT_HOST`, restart, and the site keeps
loading the old origin with no clue why — the container is right and the edge
is wrong. Purge it, and add a cache rule bypassing `/js/config.js` so it cannot
happen again. The same applies to `/plugins/mcp/*` if MCP is ever exposed
publicly.

Verified 2026-09-20, after merging the two frontends into one: a frontend with
no `PENPOT_PUBLIC_URI` emits no `penpotPublicURI` line, serves `/readyz`,
`/js/config.js`, the SPA and proxied RPC identically on both published ports,
and a worker drove a real document through it end to end. The same flag set now
serves both origins. The backend's own `PENPOT_PUBLIC_URI` is unchanged.
