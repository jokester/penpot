# Deployment handoff: moving this stack to Kubernetes

For a session that will plan or perform the migration. [HANDOFF.md](HANDOFF.md)
describes the compose stack as it runs today and stays the reference for *what
each setting means*; this document is about *what must survive the move*.

The cluster already exists: this host runs a `k3s agent`, so the likely shape is
Penpot on a node the operator can also reach directly.

## 1. What is being migrated

Seven containers, all stock images. Nothing here is built from source.

| service | image | stateful | notes |
| --- | --- | --- | --- |
| `penpot-frontend` | `penpotapp/frontend:2.17` | no | nginx + the SPA. **Two published ports, one container** (§3) |
| `penpot-backend` | `penpotapp/backend:2.17` | via volumes | 27 env keys; the only service with secrets beyond the DB |
| `penpot-exporter` | `penpotapp/exporter:2.17` | no | renders through the frontend, not the backend |
| `penpot-mcp` | `penpotapp/mcp:2.17` | no | **also an exec target** (§5) |
| `penpot-postgres` | `postgres:15` | **yes** | `penpot_postgres_v15` |
| `penpot-valkey` | `valkey/valkey:8.1` | no | required; the backend will not start without it |
| `penpot-mailcatch` | `sj26/mailcatcher:latest` | no | optional; drop it and set `enable-log-emails` instead |

Two volumes: `penpot_postgres_v15` (RWO is fine) and **`penpot_assets`, mounted
by backend, frontend *and* exporter** — that one needs **RWX**, or a restructure
so only the backend writes and the others read through it. This is the single
biggest storage decision in the migration.

One bind mount: `./climit.edn` into the backend at
`/opt/penpot/backend/climit.edn`. It becomes a ConfigMap. The image does **not**
ship this file and `enable-rpc-climit` crash-loops the backend without it.

## 2. Secrets and config

| goes in a Secret | why |
| --- | --- |
| `PENPOT_SECRET_KEY` | derives every subsystem key; **changing it invalidates all sessions and pending invitations** |
| `POSTGRES_PASSWORD` | also appears in the backend's `PENPOT_DATABASE_PASSWORD` |
| `PENPOT_OIDC_CLIENT_SECRET` | Authelia |

Everything else is ordinary config. Keep `.env` as the single source and
generate the manifests from it; the flag string in particular is easy to
fragment (§4).

## 3. The frontend: one container, two ports, and no baked origin

**Do not give the frontend a `PENPOT_PUBLIC_URI`.** This is the least obvious
and most breakable thing in the whole deployment.

The entrypoint writes `var penpotPublicURI` into `js/config.js` only when that
variable is non-empty, and `app.config/public-uri` falls back to
`location.origin` when it is absent. With it unset, one frontend serves both the
public hostname and the worker's loopback origin correctly, because each browser
configures itself from the origin it arrived on. Set it, and the worker path
starts dialling the public hostname and hits Cloudflare Access.

The **backend** keeps its own `PENPOT_PUBLIC_URI` — that one is load-bearing, for
email links and the OIDC `redirect_uri`.

Consequences for k8s:

- One Deployment, one Service, **two ways in**: the public path (currently
  `0.0.0.0:9002`, behind Cloudflare Access) and the worker path (currently
  `127.0.0.1:9001`, private).
- The worker path must arrive as **`localhost` on the node the worker runs on**.
  See §5; this is a hard requirement, not a preference.
- `js/config.js` no longer differs by origin, so a CDN caching it can no longer
  serve the wrong one. Keep the bypass rule anyway.

## 4. Flags: one shared string, one frontend-only addition

`PENPOT_FLAGS_BASE` goes to backend, frontend and exporter. The frontend adds
two of its own:

```
frontend only:  enable-login-with-password   enable-wasm-export
```

`enable-wasm-export` is deliberately *not* in the shared string: the backend
ignores it, and putting it there would restart the backend for a frontend-only
rendering change. Preserve that separation — in k8s it is the difference between
rolling one Deployment and rolling three.

`enable-rpc-climit` requires the ConfigMap from §1. `enable-audit-log` and
`enable-audit-log-gc` are on; `enable-audit-log-archive` is deliberately off
because it ships events to an external collector.

## 5. What the MCP launcher needs from the cluster

The launcher (`mcp/packages/headless/`) drives Penpot through a browser and runs
**outside** the cluster, on a node. It needs exactly two things, and both are
deployment concerns rather than launcher concerns.

**(a) `kubectl exec` into the `penpot-mcp` pod.** The launcher starts one
`node index.js` per lane inside that pod and records its in-container pid. So:

- the pod must keep running with its default process (do not scale to zero),
- the ServiceAccount or kubeconfig in use must allow `pods/exec` in the namespace,
- the pod is resolved **by label selector, not by name** — pod names change on
  restart, and the launcher re-resolves on every call.

**(b) Node-local reachability of the lane ports and the frontend.**

This is the requirement that will silently break the migration if missed.
Hardened Penpot sessions set `Secure` cookies, so a browser keeps them only for
a **trustworthy origin**. `http://localhost:9001` qualifies. `http://10.43.x.y:9001`
— a ClusterIP — does **not**, and the cookie is dropped *silently* while login
appears to succeed. The failure looks like a broken app, not a networking choice.

So the worker path and the lane range must arrive on the node's loopback:

| approach | verdict |
| --- | --- |
| **`hostPort` / `hostNetwork`** | deterministic; binds the node directly |
| **NodePort** | usually works, but `127.0.0.1` access is kube-proxy behaviour — iptables mode has allowed it via `route_localnet`, nftables mode does not. **Verify before relying on it** |
| ClusterIP only | breaks the worker; cookie dropped |
| `kubectl port-forward` | works, but a flaky child process per lane; last resort |

Verify on the node, not from a laptop:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9001/readyz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4601/mcp   # a live lane
```

Ports to expose node-locally: the frontend's worker port, and the lane range
(currently `4601-4608`, both the HTTP port and the WebSocket port of each pair —
the launcher allocates them two at a time).

## 6. Things that will bite

- **`penpot-mcp`'s default process is unused but the pod must stay up.** The
  image's `CMD` is `node index.js --multi-user`, which nothing here uses; the
  lanes are `exec`'d beside it. Keeping it is harmless and keeps the pod alive.
  Note both nginx ingress paths proxy `/mcp/ws`, `/mcp/stream` and `/mcp/sse` to
  it, and **`/mcp/stream` completes an MCP handshake unauthenticated** — the same
  as penpot cloud, but worth an Access policy decision.
- **`PENPOT_MCP_REPL_PORT: "4401"` is not a typo.** The 2.17 image builds an HTTP
  REPL unconditionally and has no switch; pointing it at the port the MCP server
  binds first makes the listen lose harmlessly. Carry it over or the REPL comes
  back.
- **The exporter renders through the frontend**, so `PENPOT_INTERNAL_URI` must
  point at the frontend Service, not the backend.
- **Valkey is required.** `::rds/client` is unconditional in the backend's system
  map; it will not boot without it.
- **Request body size**: `PENPOT_HTTP_SERVER_MAX_BODY_SIZE` is 350 MiB, and any
  ingress in front needs a matching limit. Cloudflare caps well below this on
  non-Enterprise plans, so large imports must use the private path.
- **`export_shape` from a worker is already broken** for reasons unrelated to
  k8s; see HANDOFF.md §11. Do not treat it as a migration regression.

## 7. Acceptance, in this order

Mirrors HANDOFF.md §8, adjusted for the cluster. Each step fails differently.

1. `GET /readyz` on the public path → 200.
2. `curl …/js/config.js | grep penpotPublicURI` → **no output**. A line here
   means the frontend got a baked origin and the worker path is broken (§3).
3. Browse the public hostname: Access → Authelia → Penpot loads.
4. On the node, `http://localhost:<worker port>` → log in as the worker account.
   It must be `localhost`; a node IP is not a trustworthy origin.
5. `Set-Cookie` carries `Secure; HttpOnly` and **no** `Domain`.
6. `kubectl exec` into the mcp pod and list listening ports from **both**
   `/proc/net/tcp` and `/proc/net/tcp6`.
7. Start one lane and drive `execute_code` end to end. That is the only test
   that exercises every piece at once.

## 8. What not to change while migrating

Change the orchestration, not the configuration. In particular keep: the absent
frontend `PENPOT_PUBLIC_URI`, the present backend one, the flag split of §4, the
REPL port trick, `PENPOT_SSRF_ALLOWED_HOSTS` for Authelia, and the secret key.
Each has a reason recorded in HANDOFF.md, and several look like mistakes until
you know why they are there.
