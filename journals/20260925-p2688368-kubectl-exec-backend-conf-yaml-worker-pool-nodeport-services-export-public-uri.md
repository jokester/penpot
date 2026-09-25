---
date: 2026-09-25 21:21
branch: exp/headless-mcp
host: twlight-sparkle
user: mono
tldr: Moved the headless MCP launcher off docker-compose onto kubectl exec, gave it one YAML config and a worker pool, deployed it into ns-penpot with NodePorts so it runs from any node, and traced why export fails to the backend's public URI plus a stock-server base64 bug.
---

# Journal: kubectl lanes, conf.yaml, the worker pool, NodePorts, and why export fails

## Intent

The compose containers were handed to another service, so `--mode exec` had to
move to `kubectl exec`. From there the session grew: accept a hand-written YAML
config, deploy the launcher into `ns-penpot` with the code staying in this
checkout, make it run from *any* node rather than only rarity, and finally work
out why `export_shape` fails.

## What happened

### The kubectl backend, and a mapping that was not speculative

Same five operations as compose, against a pod resolved by **label** on every
call — a pod's name changes on every restart — and remembered only for the
lifetime of a process we started, since a kill sent to the current pod would
carry a pid that now means something else. `kubectl exec` has no `-e`, so a
started process is wrapped in `env K=V`.

The first live run failed, and the reason justified `upstreamPortRange`
immediately rather than as a someday feature: an unrelated Docker stack holds
`127.0.0.1:4601-4616` on this host and its proxy accepts a connection on every
published port then resets it. Two more failures followed, each teaching
something (see Discoveries). The end state maps a local range onto the
container's by a constant offset, and `wire()` takes both port spaces because
using either where the other belongs gives a server nothing can reach or a
readiness check waiting on a socket that never opens.

### conf.yaml and the worker pool

One hand-written file replaces four scattered places. Two rules give it its
shape: no secrets (passwords and MCP tokens stay in `accounts/<name>.env`, mode
600, written by provisioning), and unknown keys are refused rather than ignored.
The second is why the old `penpotBackend:` block is rejected *by name* instead
of silently doing nothing.

`workerUsers` became a pool — one lane takes one worker — after grilling the
user on four questions. Capacity is now `min(port pairs, workers)`, and the two
refusals stay distinct because they are fixed differently: waiting vs
provisioning another worker.

### The deployment, and NodePorts

`~/Homelab/home-cluster/ns-penpot/headless-mcp/` holds a starter script, the
config and gitignored credentials; the code stays here. `KUBECTL_BIN` and
`MCP_HEADLESS_BIN` are the two machine-specific paths.

The user asked whether a NodePort could replace `kubectl port-forward`. It can,
and measuring it settled a caveat SPEC had carried since it was written. That
let the MCP pod drop its hostPorts *and* its `nodeSelector` — it rescheduled
onto twlight-sparkle on apply, which is the proof the pin was gone. A second
NodePort for the frontend followed once the user said the peers are trusted,
and then `run` needed no forwards at all and could go back to a plain `exec`.

### Why export fails: two independent bugs

Traced end to end rather than guessed. The exporter renders correctly through
`PENPOT_INTERNAL_URI`; it then uploads the result to the backend, and the
backend hands the browser a download URI built from its own
`PENPOT_PUBLIC_URI` (`backend/src/app/rpc/management/exporter.clj:49`). For a
person that is right. For a worker on a node-local origin it is unreachable and
would not carry the session cookie anyway.

No configuration fixes it — one backend value, two client origins, and unlike
the frontend the backend has no `location.origin` to fall back on. Fixed in our
code with a Playwright route that sends cross-origin `/assets/` fetches back to
the tab's own origin. Verified: 200, 524 bytes.

That exposed a second bug underneath, in the stock MCP server.

## Discoveries / Quirks

- **`kubectl port-forward` binds `[::1]` alone and still reports success** when
  something already holds `127.0.0.1`. It printed "Forwarding from" and looked
  healthy while every connection went to the other thing. `--address` is not
  optional.
- **It dials the target inside the pod the moment it starts, and a refusal
  kills it** — `error: lost connection to pod`. `start` resolves when the
  wrapper shell prints its pid, before node has bound, so the forward was
  always spawned into that window. Wait for the pod to be listening first.
- **A NodePort answers on `127.0.0.1` on this cluster** — `route_localnet=1`,
  measured on both twlight-sparkle and rarity (via a hostNetwork probe pod).
  That is iptables-mode kube-proxy behaviour and nftables mode drops it, so it
  is load-bearing on something upstream has called a wart.
- **Playwright will not send a `Secure` cookie over loopback http, and
  `cookies(url)` will not return one either.** Penpot sets `Secure` under
  `enable-secure-session-cookies`. Measured: the cookie was in the jar and
  `get-profile` still came back anonymous. The store now matches by host and
  re-stores without the flag on loopback only.
- **Penpot's file ids are time-ordered with the entropy last.** Two documents
  created seconds apart were identical for 28 characters
  (`a5ca2f23-cfad-8091-8008-af1cd3f4cd2c` / `…af1cd4a03b9d`), so a leading
  slice disambiguates nothing — take the tail.
- **`export_shape --filePath` writes inside the penpot-mcp pod**, not on the
  launcher's host, because the MCP server is what writes it.
- **A lease survives an MCP client disconnecting** — the document is parked for
  the full 10-minute idle sweep. Closing the transport does not release it.
- **`grep`/`pgrep` on a process list matches the shell running it.** Hit four
  times this session, twice costing a spurious "leftover process" conclusion
  and once an exit 144. Match on something the command itself cannot contain,
  or use explicit pids.
- **The exporter is fine.** Its `PENPOT_PUBLIC_URI` is only for link building;
  it dials `PENPOT_INTERNAL_URI`, so an identity proxy on the public hostname
  will not break exports.

## Changes

Fifteen commits on `exp/headless-mcp`, `54277bf..35a4ad6`:

- `54277bf` kubectl ExecBackend, `--address`, and the local/upstream port split.
- `d640a1a`, `98e13b6` conf.yaml, the worker pool, and their docs. Adds `yaml`
  as the third runtime dependency.
- `fea554a` `$KUBECTL_BIN`.
- `059b304`, `003e1d5` the NodePort measurement, and why the worker path stays
  node-local permanently — the public origin is going behind an identity proxy
  a headless browser cannot satisfy.
- `4a26924` name the origin a worker could not sign in at.
- `f81102f` `browserBackend.headed` / `display` / `channel` / `args` — the
  façade's own lanes were unwatchable by construction before this.
- `a00a9b0` **my own bug**: the supervisor compared container ports against
  host ports, so under a mapping it allocated as if the pod were empty.
- `35a4ad6` the asset-fetch rewrite.

Outside this repo, uncommitted in `~/Homelab/home-cluster`:
`ns-penpot/headless-mcp/` (run, conf.yaml, README, .gitignore, accounts),
`service-mcp-lanes.yaml`, `service-frontend-worker.yaml`, `deployment-mcp.yaml`
(hostPorts and nodeSelector removed), `kustomization.yaml`, `README.md`,
`CUTOVER.md`. Both Services are applied to the live cluster.

## Experiments that did not work

- `--enable-unsafe-swiftshader` did not fix the PNG export's
  `_render_shape_pixels` WASM error. Still unexplained.
- Stripping `content-encoding` from the rewritten response was not the cause of
  a 2-byte body; instrumenting showed the rewrite was already delivering all
  524 bytes and the loss was downstream.
- The `run` script went `exec` → child+trap → `exec` again. The first `exec`
  discarded the EXIT trap and orphaned the frontend forward; the NodePort then
  removed the forward and the trap with it.

## Open threads

- **`TextContent.textData` is broken on `develop`.** `c374393` (#9431, 2026-05-07)
  moved the plugin to a base64 envelope and updated `ImageContent.byteData` but
  not `textData`, which still does `String.fromCharCode(...Object.values(data))`
  — on the envelope that is `NaN, NaN` → `"\0\0"`. SVG export has returned two
  NUL bytes *silently* for four and a half months. Three-line fix, belongs
  upstream, not started. No test covers SVG export.
- **Façade-side `export_shape`** — route through `execute_code`, decode, write
  locally. Sidesteps `textData` and puts the file on the operator's machine.
  Proposed, not built. Verified viable: `execute_code` carried all 524 bytes.
- **PNG export** fails in the WASM rasteriser, cause unknown.
- **`deployment-backend.yaml` in the homelab working tree has
  `PENPOT_PUBLIC_URI` commented out** while the live cluster has it set.
  Applying the current file would break the OIDC `redirect_uri` at cutover.
- **HSTS is off on the frontend**, because the entrypoint keys
  `PENPOT_HSTS_VALUE` off the public URI's scheme and the frontend correctly
  has none. Fix is one env var; possibly moot if Cloudflare adds it.
- **Five commits `cf49251..96cb337` landed from another session** and I have
  not read them. `96cb337` ("Let --check see leftovers through a port mapping")
  is adjacent to `a00a9b0`.
- The homelab changes are uncommitted; committing there is the operator's.
