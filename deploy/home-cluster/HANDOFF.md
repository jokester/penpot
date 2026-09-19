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
| **service** | `penpot-frontend-public` |
| **host** | the Docker host running this compose file |
| **port** | `${PENPOT_PUBLIC_PORT}`, default **9002** (container port 8080) |
| **protocol** | plain HTTP; Cloudflare terminates TLS |
| **health check** | `GET /readyz` |

Point the Cloudflare tunnel at `http://<this-host>:9002` and put the Access
policy on the hostname. If `cloudflared` runs as a container here instead, use
`--profile tunnel` and it reaches `http://penpot-frontend-public:8080` over the
compose network, needing no published port at all.

**Nothing else goes to the tunnel.** Not `penpot-frontend-local` (port 9001,
the worker path, no Access in front of it), and above all not the mail catcher,
whose web UI lists every password-reset link the instance sends.

The frontends bind `${PENPOT_BIND}`, `0.0.0.0` by default, so an ingress or an
worker on another host can reach them. That also means **anything on the LAN
reaches port 9002 without passing Cloudflare Access**. On a network where that
matters, set `PENPOT_BIND=127.0.0.1` and run cloudflared on this host.

## 2. Why there are two frontends

This is the one piece of the design that looks redundant and is not.

The frontend container bakes `PENPOT_PUBLIC_URI` into `js/config.js` when it
starts, and every URL the running app dials derives from that single value —
the API, the notifications socket, the worker, and the MCP socket
(`frontend/src/app/config.cljs:185`). Penpot also serves all of it from one
nginx origin, so it cannot be split by path either.

One value cannot be both `https://penpot.example.org` and
`http://localhost:9001`. Set it to the public host and the worker still dials
that hostname, lands on Cloudflare Access, and fails with no credential. So
each audience gets its own nginx. They are cheap: static assets and a config file.

The **backend** keeps the public URI, because that is what belongs in emails
and in the OIDC `redirect_uri`.

The session cookie carries no `Domain` attribute, so each origin gets its own
host-only cookie against the same account. Verified on the real stack.

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

### Letting a worker into your documents

A fresh worker sees only its own scratch project. To let it work on your files,
invite it into your team from Penpot (Team > Invitations, role Editor), copy
the invitation link, and hand it over:

```bash
./provision-worker --email worker-a@penpot.local --invite '<link or token>'
```

The worker accepts the invitation itself, so the only manual step is the invite
you would make for any collaborator. Afterwards the launcher lists that team's
documents alongside its own, and a worker driving a file in someone else's team
needs **both** ids in the workspace URL — the launcher passes `--team-id` as
well as `--file-id` for exactly this reason.

### Run the worker as a container

```bash
docker compose --profile worker up -d penpot-mcp-worker
docker compose logs -f penpot-mcp-worker    # ends with "plugin connected"
```

It is a stock Playwright image with this repo mounted read-only — no build. Two
things about it are deliberate:

- **The image tag must match** the playwright version in
  `mcp/packages/host/package.json`, because the mounted `node_modules` supplies
  the client library and the image supplies the browsers. `PLAYWRIGHT_VERSION`
  in `.env` sets it. A mismatch fails at launch with a browser-not-found error.
- **It uses `network_mode: host`.** Hardened session cookies are `Secure`, so
  the browser keeps them only for a trustworthy origin. `localhost` qualifies;
  a container hostname such as `penpot-frontend-local` does not, and the cookie
  is silently dropped — login appears to succeed and nothing works. Sharing the
  host network namespace lets the worker say `localhost` and mean it. It is
  therefore not on the `penpot` network and reaches Penpot through the
  published port.

The browser profile, which holds the session cookie, lives in the
`penpot_worker_profile` volume. Deleting that volume just forces a fresh login.

### Or run it on the host

`worker/worker-start.sh --bg` and `worker/worker-stop.sh` do the same thing
outside Docker. That needs Node 22+, pnpm, and
`pnpm exec playwright install chromium` in `mcp/packages/host`.

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

The `penpot-mcp-worker` container and a `builtin` run both want the instance's
shared server, so only one of them can hold it — the second plugin connection
is rejected. Stop the container first, or use `--mcp exec`, which gives the new
worker a server of its own.

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
   → the **public** URI. Same on `:9001` → `PENPOT_LOCAL_URI`.
   If these are identical, the two-frontend split is broken; see section 2.
3. Browse the public hostname. Access challenges, then Authelia, then Penpot
   loads with **no password form**.
4. Open `http://localhost:9001` on the Penpot host — or SSH-forward 9001 from
   elsewhere — and log in as the worker with its password. The password form
   **is** present here. It must be `localhost`: a LAN hostname over plain HTTP
   is not a trustworthy origin and the `Secure` session cookie is dropped.
5. Log in and check `Set-Cookie` carries `Secure; HttpOnly` and **no**
   `Domain`.
6. Settings → Integrations → enable MCP, and copy the connection URL.
7. `docker compose --profile worker up -d penpot-mcp-worker`, then
   `docker compose logs penpot-mcp-worker` → ends with
   `plugin connected to ws://localhost:9001/mcp/ws`.

## 9. Ports and endpoints, as measured

Audited on a stack built from this file, 2026-09-18. Docker's embedded DNS
(127.0.0.11) appears in every container and is omitted.

| service | listens on | bound to | published to host |
| --- | --- | --- | --- |
| **penpot-frontend-public** | 8080 | container network | **`${PENPOT_BIND}:9002`** ← the tunnel target |
| penpot-frontend-local | 8080 | container network | `${PENPOT_BIND}:9001` (worker only) |
| penpot-backend | 6060 | container network | no |
| penpot-backend | 6063 (PREPL) | **127.0.0.1 inside its own container** | no |
| penpot-exporter | 6061 | container network | no |
| penpot-mcp | 4401, 4402 | container network | no |
| penpot-mcp | **4403 (REPL)** | container network | no |
| penpot-postgres | 5432 | container network | no |
| penpot-valkey | 6379 | container network | no |
| penpot-mailcatch | 1025, 1080 | container network | `127.0.0.1:1080` |

Only the two nginx ports and the mail catcher reach the host. The frontends
follow `PENPOT_BIND` (`0.0.0.0` by default); the mail catcher has its own bind
and stays on loopback. Only `penpot-frontend-public` is meant to reach the
tunnel.

PREPL is better protected than it first appears: it binds loopback *inside* the
backend container, so no other container can reach it either.

### The MCP REPL on 4403 needs a decision

The stock MCP image starts an HTTP REPL on 4403 that this compose file cannot
turn off: `PENPOT_MCP_REPL_ENABLE` does not exist in the 2.17 bundle. It serves
a web console at `/` and accepts `POST /execute` with a `code` body, which it
runs against the connected Penpot plugin. **There is no authentication on it** —
measured from a neighbouring container, `GET /` returns 200 and `/execute`
returns 500 only because no plugin was attached, not because it was refused.

It is not published to the host and nginx does not proxy it, so the blast radius
is the `penpot` Docker network. Three ways to handle that, in order of cost:

1. **Attach nothing else to the `penpot` network.** It is declared in this file
   and used only by these services. This is the default and is adequate.
2. **Upgrade past 2.17 when available.** Later builds gate the REPL behind
   `PENPOT_MCP_REPL_ENABLE`, and it then does not listen at all.
3. Mount a locally built MCP server that has the gate. This works but forks the
   server, and the server and the frontend-bundled plugin must then be upgraded
   as a matched pair. Not worth it for this alone.

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
- **Two unauthenticated REPLs run inside the network**: the backend's PREPL on
  6063, which `manage.py` needs and which binds loopback inside its own
  container, and the MCP server's on 4403, which does not. Section 9 measures
  both and says what to do about the second.
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
`export_shape` — driving a file with no human tab open, run both from
`worker/worker-start.sh` on the host and from the `penpot-mcp-worker`
container, and `run-mcp-worker --headed` was driven on a VNC display. Two
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
