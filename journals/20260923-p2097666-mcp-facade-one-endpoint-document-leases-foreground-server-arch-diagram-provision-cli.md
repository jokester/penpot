---
date: 2026-09-23 23:17
branch: exp/headless-mcp
host: twlight-sparkle
user: mono
tldr: Built the MCP façade — one endpoint that takes the document as an argument, leased one client at a time — ran it live, drew the architecture in Penpot, then closed the gap between the old spikes and the package by porting provisioning and specifying the rest.
---

# Journal: The MCP façade, and closing out the old tooling

## Intent

Make the MCP server convenient: free the client from knowing which port
belongs to which document, and make document selection part of the MCP
interface itself. Then, once that worked, find what the old spikes could
still do that the new package could not, and settle each one.

## What happened

### The façade

The survey question was whether a stateful MCP server is still allowed.
It is: the first protocol version stated a session, the recent one does
not require it, and Penpot's own server is on the stated one — so the
façade is stateful too, and connecting to a document is a tool call
rather than a URL.

The concurrency question turned out not to be about ports at all. The
first framing was "lanes share a user, so provisioning users on demand
would remove the lock". That is wrong for a reason the human named:
two clients editing one document produce asymmetric views and apparent
races whoever they are logged in as. So a document-level lock is
necessary regardless of how it is implemented, and one lane per
document is the model everything else follows from. A caller that
finds the document held is blocked, not refused.

Built in three commits that each stand alone: leases (`facade/leases.ts`),
behaviour with no transport (`facade/facade.ts`), then the endpoint
(`facade/server.ts`). The façade is an MCP *client* to the stock server
and an MCP *server* to the agent — it forwards `execute_code`,
`export_shape` and `import_image` after stripping the `document`
argument, and answers the document-free tools from the instance's own
endpoint so an agent's first call cannot fail for want of a document.

Then a startup script, which the human immediately reversed: no daemon,
foreground only. `f77d8db` deleted it a commit after `2efd79f` added it.
That is the right outcome — the launcher owns every lane it opens, so
the way to end them is to end it — but it is a commit pair worth
noticing.

### The diagram

Drew the stock-vs-façade architecture as a new page in the `diagrams`
document through the façade itself, which was the real acceptance test.
70 shapes, two boards.

### The gap between the spikes and the package

Five things the old tooling could still do. Four are settled and the
fifth is ported:

- **Interactive login: removed.** It opened a window and waited for a
  person, for accounts SSO or 2FA make unscriptable. A worker is
  provisioned with a password we wrote, so that path was never this
  one's — but the honest reason is that grep found no caller outside
  its own test. Same shape as `PluginWatch.dropped` two days ago.
- **`--browser container`: documented, not built** (SPEC §14.3).
- **`--repl`: dropped.** Suppression kept, so it can be started
  deliberately later.
- **The three spikes: specified, not built** (SPEC §13b) as one
  read-only `doctor`.
- **`provision-worker`: ported** as `mcp-headless provision-worker-user`,
  with `server` naming what the bare invocation already did.

## Discoveries / Quirks

- **`manage.py` reads the password from stdin when there is no tty.**
  `getpass` fails to open `/dev/tty` under `docker compose exec -T` and
  falls back to `sys.stdin.readline`, with a warning. Checked against
  the running container before building on it. This is what lets the
  password stay off argv, where the old script put it — visible in the
  host's process list and the container's at once.
- **Penpot kebabs every incoming JSON key.** `http/middleware.clj:61`
  reads with `json/read-kebab-key`, which is `str/kebab` — so
  `projectId` and `project-id` both arrive as `:project-id`. That is why
  the old Python script mixing the two spellings worked. Responses are
  camelCase via `write-camel-key`. The earlier "kebab in, camel out"
  finding now has its mechanism: input is normalised, output is not.
- **`manage.py` parses `--skip-tutorial` and `--skip-walkthrough` and
  never passes them on** — `create_profile(fullname, email, password)`
  at line 202 drops both. The defaults in the function signature make it
  silent. Our `enableMcp` sets `onboardingViewed` over RPC, which is
  what actually clears the screens a headless browser would otherwise
  sit behind.
- **The backend container's PID 1 is `java`.** Python 3.14.4 is in the
  image as a CLI helper only; `manage.py` is a thin client that speaks
  JSON over the backend's PREPL at `tcp://localhost:6063`. That is why
  it can create a profile when the RPC API cannot: it reaches into the
  running app, past self-registration being off and past email
  confirmation.
- **A plugin socket that opens and closes satisfied `waitForPlugin`.**
  Readiness now settles for 2s and rechecks (`d563d11`). The signal that
  would have caught it, `PluginWatch.dropped`, was being tracked and
  never read.
- **Arrow labels in Penpot need their own width measured.** Sizing them
  with 40px of slack overlapped the neighbouring boxes; the fix was
  trimming or replacing them with a caption.

## Changes

Twelve commits on `exp/headless-mcp`, `0719394..4695ca9`:

- `0719394`, `05971c2`, `3ef55f6` — the façade design, one lane per
  document, and the fact that the port range is declared twice.
- `d563d11` — settle-and-recheck readiness.
- `291c388` — eight lanes' worth of published ports (4601–4616), with
  the measured docker-proxy cost as the justification.
- `9f59015`, `ff80f48`, `8335e2c` — leases, behaviour, endpoint.
- `2efd79f`, `f77d8db` — the daemon script, and its removal.
- `0dc390f` — interactive login removed; container browser and
  diagnostics written into SPEC §14.3 and §13b.
- `4695ca9` — `provision-worker-user` and `server`. `ExecBackend.run`
  gained a container *role* (`"mcp" | "admin"`) rather than a service
  name, so compose's service and kubectl's selector stay behind one
  interface, and a `stdin` channel for the password. `createMcpToken`
  lives in `provision/` and nothing else imports it. Minting is gated by
  what it would destroy: free for a profile created a moment ago, behind
  `--mint-token` for one that already has a token in use.

373 tests pass. Provisioning was verified against the live instance with
a config directory of its own: profile already existed, real login
succeeded, token reused byte for byte, account file written 600 in the
old shape.

## Open threads

- **The façade's hand-written JSON schemas have drifted** from the stock
  server's: `format`'s svg|png enum, `mode`'s shape|fill enum,
  `penpot_api_info`'s required `type`, and the descriptions. Identified,
  not fixed. Fetching the schemas from the stock server at connect time
  would end the class of problem rather than this instance of it.
- **T8.5 live acceptance** of the whole launcher, and **T6.3**, which
  deletes `run-mcp-worker`, `run-mcp-worker.py`, `provision-worker` and
  `mcp/packages/host/`. T6.3 is now unblocked.
- **`doctor` is specified and unimplemented** (SPEC §13b).
- **One spurious SDK client session loss after ~60 minutes idle.** Seen
  once, not reproduced, not chased.
