# Deploying Penpot on the home cluster

Everything needed to stand this up, for someone who has not seen the design
discussion. Written 2026-09-18.

Penpot is a self-hosted design tool. This deployment serves people over the
public internet behind Cloudflare Access with Authelia as the identity
provider, and serves an automation agent over a private path that never
touches Cloudflare.

## 1. Shape of the thing

```
                 ┌─ people ──────────────────────────────────┐
browser ──▶ Cloudflare Access ──▶ cloudflared ──▶ penpot-frontend-public :9002
              (GitHub / Authelia)                      │
                                                       ├──▶ penpot-backend  :6060
ssh -L ──▶ 127.0.0.1:9001 ──▶ penpot-frontend-local ───┤     penpot-exporter :6061
                 └─ agent ────────────────────────────┘     penpot-mcp  :4401/:4402
                                                            postgres / valkey
```

**Nothing binds to `0.0.0.0`.** Every published port is on `127.0.0.1`.
Cloudflare Access protects nothing if the origin answers directly, so the
tunnel is the only way in from outside.

## 2. Why there are two frontends

This is the one piece of the design that looks redundant and is not.

The frontend container bakes `PENPOT_PUBLIC_URI` into `js/config.js` when it
starts, and every URL the running app dials derives from that single value —
the API, the notifications socket, the worker, and the MCP socket
(`frontend/src/app/config.cljs:185`). Penpot also serves all of it from one
nginx origin, so it cannot be split by path either.

One value cannot be both `https://penpot.example.org` and
`http://localhost:9001`. Set it to the public host and the agent — reaching the
app through an SSH forward — still dials the public hostname, lands on
Cloudflare Access, and fails with no credential. So each audience gets its own
nginx. They are cheap: static assets and a config file.

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

## 7. Create the agent account

Registration is disabled, so accounts are made on the command line. People get
theirs automatically on first SSO login (`enable-oidc-registration`); the agent
needs a password, because its login is non-interactive.

```bash
docker compose exec penpot-backend python3 manage.py create-profile \
  -n "MCP Agent" -e agent@penpot.local -p '<strong password>' \
  --skip-tutorial --skip-walkthrough
```

Keep this account separate from any human account. It holds a password on disk
in the agent's browser profile, and separating it bounds the damage.

## 8. Verify, in this order

Each step fails differently, so do not skip ahead.

1. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9001/` → `200`.
2. `curl -s http://127.0.0.1:9002/js/config.js | grep penpotPublicURI`
   → the **public** URI. Same on `:9001` → `http://localhost:9001`.
   If these are identical, the two-frontend split is broken; see section 2.
3. Browse the public hostname. Access challenges, then Authelia, then Penpot
   loads with **no password form**.
4. SSH-forward `9001` and log in as the agent with its password. The password
   form **is** present here.
5. Log in and check `Set-Cookie` carries `Secure; HttpOnly` and **no**
   `Domain`.
6. Settings → Integrations → enable MCP, and copy the connection URL.

## 9. Ports and endpoints, as measured

Audited on a stack built from this file, 2026-09-18. Docker's embedded DNS
(127.0.0.11) appears in every container and is omitted.

| service | listens on | bound to | published to host |
| --- | --- | --- | --- |
| penpot-frontend-public | 8080 | container network | `127.0.0.1:9002` |
| penpot-frontend-local | 8080 | container network | `127.0.0.1:9001` |
| penpot-backend | 6060 | container network | no |
| penpot-backend | 6063 (PREPL) | **127.0.0.1 inside its own container** | no |
| penpot-exporter | 6061 | container network | no |
| penpot-mcp | 4401, 4402 | container network | no |
| penpot-mcp | **4403 (REPL)** | container network | no |
| penpot-postgres | 5432 | container network | no |
| penpot-valkey | 6379 | container network | no |
| penpot-mailcatch | 1025, 1080 | container network | `127.0.0.1:1080` |

Only the two nginx ports and the mail catcher reach the host, all on loopback.
Only `penpot-frontend-public` is meant to reach the tunnel.

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
  hides the form. The backend still accepts passwords, because the agent needs
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
as a trustworthy origin); `manage.py` account creation; agent login; and the
full MCP path — `execute_code`, `high_level_overview`, `penpot_api_info` and
`export_shape` — driving a file with no human tab open. The port table in
section 9 was read from the running containers, not inferred.

**Not tested**: the Cloudflare tunnel, the Access policy, and the Authelia OIDC
round trip. The Authelia endpoint URLs were read from the live discovery
document at `https://id.ihate.work/.well-known/openid-configuration`, but no
login has been performed through them. Expect section 12 to earn its keep on
first run.
