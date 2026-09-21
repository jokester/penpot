# The MCP façade — one endpoint, documents as an argument

Status: **proposed**. Nothing is implemented; this is the thing to argue with.

Companion to [SPEC.md](SPEC.md) (the launcher), [ARCHITECTURE.md](ARCHITECTURE.md)
(the system it drives) and [API.md](API.md) (the seams). Everything measured
here was measured on 2026-09-21/22 against the live self-hosted stack, and the
command that produced each number is named so it can be re-run.

## 1. The problem

Lanes work, and each one is a port. That cost lands on the agent:

```jsonc
// every document is a different endpoint, and the numbers move
{ "penpot-diagrams": { "url": "http://127.0.0.1:4601/mcp" },
  "penpot-viewer":   { "url": "http://127.0.0.1:4603/mcp" } }
```

Two things are wrong with it. The client has to know which port is which
document, and it has to be reconfigured whenever that changes. And choosing a
document is not something the agent can do at all — it is something a person
does, out of band, before the agent starts.

Both disappear if the document becomes part of the MCP interface and the ports
stop being the agent's problem.

## 2. What was measured

| condition | how it was checked | consequence |
| --- | --- | --- |
| The injected URL is per tab | `config.cljs:185` — `mcp-ws-uri` is a top-level def reading `window.penpotMcpServerURI`; one JS context per tab | **The URL is a routing key we own** |
| The token is not per tab | `mcp.cljs:140` — `getToken` is `(constantly token)`, the profile's MCP token | The token cannot tell two tabs apart |
| The plugin appends it | `plugin/src/main.ts:215` — `wsUrl += "?userToken=" + token` | `ws://host/lane/abc?userToken=T` parses correctly, so a **path segment needs no plugin change** |
| One stock server hosts one tab | `PluginBridge.getClientConnection` errors on `size > 1`; `clientsByToken` rejects a duplicate token | Stock server is one tab per process, in both modes |
| One tab drives one document | plugin API has `openPage`, **no `openFile`**; `currentFile` is readonly | Switching documents needs a host-page navigation, which only the launcher can do |
| Nothing serialises plugin tasks | `plugin/src/plugin.ts:68` — `handlePluginTaskRequest(message).catch(…)`, not awaited. The only `Semaphore` bounds export memory in multi-user mode | **Two calls interleave in one JS context**, sharing a selection |
| The MCP token authenticates REST | `Authorization: Token …` against `get-teams` → **HTTP 200** | A server holding the token can enumerate documents itself |
| Two lanes both connect | established plugin sockets on 4604 **and** 4606, stable across a minute | The N-lane model is sound; the earlier doubt was a readiness bug, not a limit |
| Our server ≠ stock plugin | the served `plugins/mcp/index.js` contains `heartbeat` **zero** times; our server errors after 30 s of silence | Running our own build also requires serving our own plugin |

Costs, measured on this host:

| | |
| --- | --- |
| stock MCP server process | **46 MB** RSS (`/proc/<pid>/status` inside the container) |
| browser + first tab | 527 MB |
| each further tab | 94 MB |
| published port range | `4601-4608` → **four lanes** |

## 3. The protocol, accurately

The stock `penpotapp/mcp:2.17` image ships `@modelcontextprotocol/sdk` **1.29.0**,
whose `LATEST_PROTOCOL_VERSION` is **`2025-11-25`**, supporting back to
`2024-10-07`. Penpot is not on an old protocol.

What it did is *choose* a stateful transport: `sessionIdGenerator` is set,
sessions carry a `userToken`, and idle ones are swept after 60 minutes.
Statefulness has never been a version property — Streamable HTTP permits both,
and the SDK implements both.

So matching Penpot's choice costs nothing and inherits nothing. **The façade is
stateful too.** One guard rail comes with that:

> `connect_doc` binds a document to the session, and **every tool also takes an
> optional `document`**.

Sessions are lost routinely — the 60-minute sweep, a client reconnect, a
launcher restart. Without the override each loss becomes "no document
connected" in the middle of a task. It is one optional argument, not a second
design: truth per call, convenience per session.

## 4. Three routing keys, and the trade

A tab needs a key that distinguishes it. There are exactly three, and the choice
decides almost everything else.

| key | who must change | browser cost | new accounts |
| --- | --- | --- | --- |
| **port** — today, hidden behind the façade | nobody | shared browser, 94 MB/tab | no |
| **URL path** — `ws://…/lane/abc?userToken=T` | our server build, **and** our plugin build | shared browser, 94 MB/tab | no |
| **userToken** — stock multi-user, one port | nobody | **527 MB, one browser per account** | yes, and a team invite each |

The port stays. It is the only one that needs no new code inside the container
and no new accounts, and the façade hides it from the agent anyway.

**Per-user provisioning was considered and rejected.** It does remove the shared
tab, and it would let a stock multi-user server serve one port with no façade at
all. But a browser profile holds one session, so a second account is a second
Chromium rather than a second tab — roughly 2.6 GB against 900 MB at five lanes.
It also leaks into Penpot: every worker must be invited to the team that owns
the file, so it appears in the member list, in the audit log, and as a live
collaborator avatar in the document.

**Path routing was considered and deferred.** It is the tidiest end state and
needs no plugin change to *work*, but it requires our own server build, which
then requires our own plugin build to fix the heartbeat skew. Two version
couplings where there are currently none.

## 5. The design

```
agent A ─┐                                        ┌─ lane :4603 ─ tab (diagrams)
         ├─ mcp-headless :4400                    │
agent B ─┘   connect_doc · list_documents         ├─ lane :4605 ─ tab (diagrams)
             session → lane lease                 └─ lane :4607 ─ tab (viewer)
                                                     one browser, one account
```

The agent's configuration becomes one static URL, permanently. Lanes and ports
become an implementation detail the façade allocates.

```
list_documents()                → team / name, from the token's own REST access
connect_doc(document)           → binds this session; opens a lane; blocks until ready
disconnect_doc()                → releases the lease
execute_code(code, document?)   → the optional override of section 3
```

The façade is an MCP **server** to the agent and an MCP **client** to each lane,
mirroring the backend's tools and adding the `document` argument. Discovery uses
the protocol rather than inventing anything: `completable()` on the `document`
argument so clients autocomplete real names, `ResourceTemplate("penpot://{team}/{file}")`
so documents appear in a resource picker, and `sendToolListChanged` when the set
moves.

A lease is held per `(session, document)`. It is released by `disconnect_doc`, by
the transport's `onclose`, or by an idle timeout — whichever comes first. The
lane goes when its last lease does.

**Cold start blocks the caller.** `connect_doc` on a new document takes 10–20 s.
An agent that gets a fast success and then a slow first call reads the second as
a hang.

## 6. Locking: one is necessary, one is impossible

These are different things, and calling both of them a lock caused a wrong turn
in the design conversation.

**A tab lock is necessary, and not because of multiple agents.** One agent is
enough: MCP permits concurrent requests on a session, clients do issue parallel
tool calls, and `plugin.ts:68` dispatches without awaiting. Two `execute_code`
calls from a *single* client already interleave in one JS context today, sharing
one selection and one current page. So: one call in flight per lane, FIFO,
bounded, with the queue depth visible in the reply. It is a property of the tab,
it is a handful of lines, and it is required under every architecture here.

**A document lock is not necessary, and it could not work.** A lock in the
façade binds only callers that come through the façade. It cannot bind a person
editing in their own browser, a client pointed straight at a lane's port, or any
other Penpot collaborator. A lock that does not cover every writer is a lock on
an access path, not on a document, and naming it otherwise promises what it
cannot deliver. A real one would need a lease the backend issues and every
client honours; Penpot has no such concept, and building one would fight a
product whose entire design is concurrent editing without locks.

## 7. Contention, which we cannot fix

Two failures get confused:

- **Incoherence** — two code blocks interleaving in one JS context, sharing a
  selection. Ours. Fixed by the tab lock, or by not sharing the tab.
- **Contention** — two editors changing the same shapes. Penpot merges the
  changes correctly; the semantic conflict remains. This is what happens between
  an agent and a person today, and it is inherent to a multiplayer editor.
  Separate tabs, separate users, separate anything — none of it helps.

Giving each session its own tab turns the first into the second. That is the
best available outcome, and it is worth being clear that it is not a fix.

What to use instead, all of which already exists:

- **`penpot.activeUsers`** — the plugin can see who else is in the file, so
  `connect_doc` can report that you are not alone and a mutating call can say
  so. Detection that can be acted on beats prevention that cannot be enforced.
- **`penpot.history`** — a `HistoryContext`, so an agent's operation can be one
  undo boundary rather than forty.
- **`enable-auto-file-snapshot`** — already on in this deployment. The real
  safety net: a bad interleave is recoverable.

None of these needs a server change, because `execute_code` is a general escape
hatch — anything expressible as plugin-sandbox code is already reachable.

## 8. What stays stock

Nothing non-stock runs in the container, and no upstream file changes. What runs
there is the image's own `index.js`, started by `docker compose exec` with a
different environment. Three settings are non-default and only one is cheeky:

1. `PENPOT_MCP_SERVER_PORT` / `PENPOT_MCP_WEBSOCKET_PORT` per lane — documented
   variables, used as intended.
2. `window.penpotMcpServerURI` per tab — a supported frontend hook
   (`config.cljs:185`), read exactly as designed.
3. `PENPOT_MCP_REPL_PORT` aimed at an already-bound port so the REPL's listen
   fails — a deliberate collision, because the 2.17 bundle builds its
   `ReplServer` unconditionally and offers no switch.

The one version coupling kept is deliberate: **stock server ↔ stock plugin, same
image tag.** That is the pairing that demonstrably works, and the pairing a
custom server would break.

What would force non-stock code, so the boundary is known:

- collapsing N servers into one by path routing (section 4);
- a tab lock that also covers clients connecting straight to a lane port, which
  the façade cannot see;
- the 46 MB per server process becoming the binding constraint — eight lanes is
  about 370 MB of Node inside the container, twenty about 920 MB.

## 9. Open decisions

- **Isolation default.** One lane per `(session, document)` costs 94 MB and
  needs no lock between agents. Sharing a lane costs nothing and needs the tab
  lock to serialise them. Proposed: **own lane by default, share on a flag**,
  with sharing as the degradation path once the lane ceiling is reached.
- **Relaxing an existing refusal.** `LaneSupervisor` currently refuses a second
  lane on one document — `lane ${id} already drives that document`. That was
  right for hand-driven lanes and becomes wrong when the façade allocates them.
  It has to become opt-out.
- **Idle timeout.** A tab is 94 MB and a server 46 MB. Penpot sweeps sessions at
  60 minutes; that is generous for a lane. 5–10 minutes is probably right.
- **Port range.** `4601-4608` allows four lanes. Per-session allocation wants
  more; `4601-4640` gives twenty for one line of compose and a recreate.

## 10. What must land first

The façade opens lanes unattended, with nobody watching a red row. So the
readiness defect has to go first: `PluginWatch.dropped` is tracked and never
read, and a socket that opens and immediately closes currently satisfies
`waitForPlugin`. Under the TUI that is a wrong row; under the façade it is a
failed tool call with a misleading reason.
