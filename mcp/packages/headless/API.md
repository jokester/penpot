# Directory-level API

Interfaces and the reasoning behind them. No implementation — the point is to
argue about the seams before there is code to move.

Companion to [SPEC.md](SPEC.md) (what the launcher does) and
[ARCHITECTURE.md](ARCHITECTURE.md) (the system it drives).

## 0. Four rules the whole shape follows

**Dependencies point inward.** `core/` imports nothing of ours. `exec/`,
`browser/` and `penpot/` import `core/` types only. `supervisor/` imports all
four. `tui/` imports `supervisor/` types only. `main.ts` is the only thing that
imports `tui/`. Nothing ever imports upward, so the testable half never drags
in a browser or a container.

**I/O arrives as parameters, never as imports.** A lane is handed a `LaneDeps`
rather than importing Playwright. This is what makes the state machine testable
with fakes, and it is the difference between the old bash — where the only way
to test the port allocator was to run Docker — and something with unit tests.

**State flows out, intents flow in.** The supervisor owns lane records and
publishes them; the TUI renders them and sends intents back. The TUI never
reaches into a lane, and no lane knows a TUI exists.

**One cleanup path, one exit point.** Every resource is acquired inside a
`try`/`finally` in `runLane`; cancellation unwinds them in reverse. Commands
return an exit code to `main`. No `process.exit` from inside a branch, ever —
that is the class of bug this package is replacing.

---

## `core/` — pure, fully tested, no I/O

Everything here is a function of its arguments. No `fetch`, no `spawn`, no
`fs`. If a thing needs the world, the world is passed in.

### `core/target.ts`

```ts
export interface AccountRef {
  readonly name: string;        // "mcp-worker"
  readonly origin: string;      // "http://localhost:9001"
  readonly profileDir: string;
}

export interface DocumentRef {
  readonly fileId: string;
  readonly teamId: string;      // NOT optional — see below
  readonly pageId?: string;
  readonly name?: string;
}

export function workspaceUrl(account: AccountRef, doc: DocumentRef): string;
export function parseWorkspaceUrl(url: string): DocumentRef;
```

**Why `teamId` is required at the type level.** A workspace URL with only a file
id loads, authenticates, opens the notifications socket, reports no error and
renders nothing (invariant 1). That cost a day. Making the field non-optional
moves the failure from a blank screen at runtime to a compile error, and
`parseWorkspaceUrl` throws on a blank or absent id rather than returning a
`DocumentRef` with an empty string (invariant 2) — the old regex used `+` where
it needed `*`, and silently drove the wrong document.

### `core/ports.ts`

```ts
export interface PortRange { readonly lo: number; readonly hi: number; }
export interface PortPair  { readonly http: number; readonly ws: number; }

export function allocate(range: PortRange, busy: readonly number[]): PortPair;
export function assertUsable(
  pair: PortPair, range: PortRange, busy: readonly number[],
): void;   // throws an error naming the free ports
```

**Why `busy` is a parameter.** Ports must be probed inside the container, never
from the host, because Docker publishes the whole range and every host-side
check reports "in use" (invariant 5). Taking the list as an argument keeps the
allocator pure and testable — including against the case that actually bit us,
a WebSocket port visible only in `/proc/net/tcp6` (invariant 4).

`assertUsable` exists separately from `allocate` because an operator-supplied
`--port` needs the same checks as a chosen one. A port outside the published
range starts a server that works perfectly and that nothing can reach
(invariant 3), so this throws rather than warning.

### `core/topology.ts`

```ts
export type Mode = "builtin" | "exec" | "local";

export interface Wiring {
  readonly injectWsUri: string | null;  // null ⇒ the app's own default
  readonly clientUrl: string;           // what the agent connects to
  readonly needsServer: boolean;
  readonly needsUserToken: boolean;
}

export function wire(
  mode: Mode, account: AccountRef, ports: PortPair | null, userToken?: string,
): Wiring;

export function isPluginSocket(url: string, wiring: Wiring): boolean;
```

**One function decides every URL**, so the injected socket and the readiness
check cannot disagree. They did once: `isPluginSocket` matched the default
WebSocket port instead of the injected one, and reported a healthy worker as a
90-second timeout (invariant 11). Deriving both from the same `Wiring` makes
that unrepresentable.

`needsServer: false` for `builtin` is what lets a builtin lane skip `exec/`
entirely — one half instead of two.

### `core/config.ts`

```ts
export interface Deployment {
  readonly backend: "compose" | "kubectl";
  readonly exposure: "none" | "port-forward";
  readonly portRange: PortRange;
  readonly compose?: { projectDir: string; service: string };
  readonly kubectl?: { context?: string; namespace: string; selector: string };
}

export interface Settings {
  readonly deployment?: Deployment;       // absent ⇒ builtin only
  readonly accounts: ReadonlyMap<string, AccountRef & {
    readonly password?: string;
    readonly mcpToken?: string;
  }>;
}

export function load(dir: string, env: NodeJS.ProcessEnv): Settings;
```

`deployment` is optional on purpose: with no deployment at all the launcher
still runs `builtin` lanes, which is the mode that works against cloud and
against whatever replaces the compose file.

---

## `exec/` — the only code that knows a container runtime exists

### `exec/backend.ts`

```ts
export interface ExecResult   { readonly code: number; readonly stdout: string; readonly stderr: string; }
export interface RemoteProcess { readonly pid: number; }
export interface Exposure     { readonly url: string; close(): Promise<void>; }

export type Container = "mcp" | "admin";
export interface RunOptions   { readonly container?: Container; readonly stdin?: string; }

export interface ExecBackend {
  readonly kind: "compose" | "kubectl";
  run(argv: readonly string[], signal: AbortSignal, options?: RunOptions): Promise<ExecResult>;
  start(argv: readonly string[], env: Readonly<Record<string, string>>,
        signal: AbortSignal): Promise<RemoteProcess>;
  kill(pid: number): Promise<void>;
  listening(): Promise<number[]>;
  expose(port: number, signal: AbortSignal): Promise<Exposure>;
}

export function backendFor(d: Deployment): ExecBackend;
```

**`start` resolves with an in-container pid, not a child handle.** An exec client
dying does not stop what it started (invariant 6), so the pid is the only handle
that can actually end the process, and every backend must produce one.

**`expose` returns a closable even when it does nothing.** Under compose the
ports are already published and `expose` only verifies reachability; under
`kubectl` with `exposure: "port-forward"` it owns a child process. Keeping the
same shape means a lane's `finally` does not branch on the backend.

**`run` names a container by role, not by service.** Compose spells the
distinction as a service and kubectl as a selector, and the callers only know
which job they want doing: lanes want the MCP container, provisioning wants the
one `manage.py` lives in. Under compose the second is `penpot-backend`, or
whatever `adminService` names.

**`run`'s `stdin` is how a secret reaches a command.** Both the host's process
list and the container's show argv to anything that can look, so a password
passed as a flag is a password published. `manage.py` prompts for one when
`-p` is absent and, with no terminal, `getpass` reads it from stdin instead --
confirmed against the running instance rather than assumed.

### `exec/procnet.ts`

```ts
export function parseListeningPorts(tcp: string, tcp6: string): number[];
```

Pure, and separate from the backends, because both parse the same two files and
the parser is where the IPv6 bug lived. Fixture-tested.

---

## `penpot/` — the RPC surface, no browser

```ts
export interface Session     { readonly cookie: string; }
export interface Team        { readonly id: string; readonly name: string; }
export interface FileSummary { readonly id: string; readonly name: string;
                               readonly teamId: string; readonly modifiedAt: string; }

export interface PenpotApi {
  loginWithPassword(origin: string, email: string, password: string): Promise<Session>;
  teams(origin: string, s: Session): Promise<Team[]>;
  recentFiles(origin: string, s: Session, teamId: string): Promise<FileSummary[]>;
  readMcpToken(origin: string, s: Session): Promise<string | null>;
}
```

**There is deliberately no `createMcpToken`.** Calling `create-access-token` with
`type: "mcp"` deletes the account's existing token and breaks MCP in that user's
real Penpot tab. The capability is omitted from the interface so it cannot be
called by accident; provisioning a *new* worker account is a separate command
that does it knowingly, once.

`Session` carries the cookie explicitly because Node's cookie handling will not
send a `Secure` cookie over loopback http, which produced 401s that looked like
an auth bug.

`rpcCaller` is the transport on its own -- kebab-case out, camelCase back, the
cookie by hand, and what an HTTP failure becomes. `provision/` posts through it
too, so those decisions stay in one place without `PenpotApi` growing the
command it exists to withhold.

---

## `provision/` — creating the one account that has a password

```ts
export interface WorkerAdmin {
  createProfile(name: string, email: string, password: string): Promise<"created" | "exists">;
  setPassword(email: string, password: string): Promise<void>;
}

export interface ProvisioningApi {
  login(origin: string, email: string, password: string): Promise<{ session: Session; profile: Profile }>;
  acceptInvitation(origin: string, s: Session, token: string): Promise<Joined>;
  createMcpToken(origin: string, s: Session): Promise<string>;   // destructive
  enableMcp(origin: string, s: Session): Promise<void>;
  createFile(origin: string, s: Session, projectId: string, name: string): Promise<string>;
}

export function provisionWorker(request: WorkerRequest, deps: WorkerDeps): Promise<WorkerReport>;
```

**This is where `createMcpToken` lives, and nothing else imports it.** Keeping
the capability in a module the TUI never reaches is a cheaper guarantee than
remembering not to call it.

**A profile needs the admin container.** There is no RPC command that creates
one: self-registration is off on a private instance, and a worker has no mailbox
to confirm from. `manage.py` reaches the backend's PREPL and makes the profile
directly, so this one step shells in and the rest is RPC.

**Minting is free for a profile that was just created and gated for one that was
not.** A new account has no token to destroy; an existing one may have a token
in use, so replacing it takes `--mint-token`. Without the flag the existing
token is read back with `readMcpToken` and written to the account file unchanged.

**Re-running is the supported way to add a team or rewrite a lost account file,**
which is why so much of `provisionWorker` reads before it writes: the password
comes from `$MCP_HEADLESS_WORKER_PASSWORD`, then from the account file already
there, and is generated only if neither has it. An existing profile plus a
generated password is refused rather than attempted, because the login that
followed would fail for a reason nobody would guess.

**The password is never a flag.** `--password` is refused rather than ignored:
someone typing it has already put it in their shell history and in every process
list on the host, and accepting it silently would leave them thinking otherwise.

---

## `browser/` — Playwright lives behind this and nowhere else

### `browser/pool.ts`

```ts
export interface BrowserKey {
  readonly account: string;
  readonly headed: boolean;
  readonly flavour: string;    // channel + arg fingerprint
}

export interface Lease {
  readonly page: import("playwright").Page;
  close(): Promise<void>;      // closes the tab; the browser goes when the last lease does
}

export interface BrowserPool {
  lease(key: BrowserKey, init: { injectWsUri: string | null },
        signal: AbortSignal): Promise<Lease>;
  closeAll(): Promise<void>;
}
```

**The key is exactly what a browser cannot vary per tab**: the profile holds one
session, and headed and headless are different processes. Everything else is
per-tab, which is why `init.injectWsUri` is a `lease` argument — measured, three
tabs in one context booted with three different `penpotMcpServerURI` values.

Refcounting is the pool's business, not a lane's. A lane closes its `Lease`; the
last one out closes the browser. At 94 MB per extra tab against 527 MB per
browser, this is the difference between five lanes costing 900 MB and 2.6 GB.

### `browser/session.ts`

```ts
export interface SessionStore {
  has(account: AccountRef): Promise<boolean>;
  loginWithPassword(account: AccountRef, password: string, signal: AbortSignal): Promise<void>;
  loginInteractive(account: AccountRef, signal: AbortSignal): Promise<void>;
}
```

Two logins because SSO and 2FA accounts cannot be scripted. `loginInteractive`
waits for the cookie to exist rather than for the window to close — the window
closing proves nothing.

### `browser/page.ts`

```ts
export function waitForPluginSocket(
  page: import("playwright").Page, wiring: Wiring,
  timeoutMs: number, signal: AbortSignal,
): Promise<string | null>;
```

The single readiness signal. The URL, a synthetic RPC probe and
`page.on("response")` all lie (invariant 10), so no other function here is
allowed to claim a lane is ready.

---

## `supervisor/` — lanes, their lifetimes, and what was left behind

### `supervisor/lane.ts`

```ts
export type LaneState = "opening" | "connected" | "failed" | "closing" | "closed";

export type LaneEvent =
  | { state: "opening";   detail: string }
  | { state: "connected"; clientUrl: string; document: DocumentRef }
  | { state: "failed";    reason: string; log: readonly string[] };

export interface LaneSpec {
  readonly id: string;
  readonly account: AccountRef;
  readonly document: DocumentRef;
  readonly mode: Mode;
  readonly headed: boolean;
  readonly port?: PortPair;    // absent ⇒ allocate; ignored when mode is builtin
}

export interface LaneDeps {
  readonly backend?: ExecBackend;   // absent for builtin
  readonly pool: BrowserPool;
  readonly api: PenpotApi;
}

export function runLane(
  spec: LaneSpec, deps: LaneDeps,
  onEvent: (e: LaneEvent) => void, signal: AbortSignal,
): Promise<void>;
```

**It returns a promise, not a generator.** The value a generator added was
cleanup attached to acquisition, and that comes from `try`/`finally`. A plain
function is not pull-based, so a slow renderer cannot stall a lane, and there is
no rule that the supervisor must remember to `.return()` or leak everything.

**It resolves only when the lane is over.** After `connected` it parks on the
abort signal. A thing that emits a few events and then waits is a function.

### `supervisor/supervisor.ts`

```ts
export interface LaneRecord {
  readonly spec: LaneSpec;
  readonly state: LaneState;
  readonly since: number;
  readonly clientUrl?: string;
  readonly error?: string;
}

export interface Supervisor {
  open(spec: Omit<LaneSpec, "id">): Promise<string>;
  close(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  list(): readonly LaneRecord[];
  subscribe(fn: (records: readonly LaneRecord[]) => void): () => void;
  shutdown(deadlineMs: number): Promise<{ readonly forced: number }>;
}
```

**`open` rejects rather than half-working.** A second `builtin` lane on one
account is refused with a reason: one `userToken` is one plugin slot, the slot
is sticky, and the loser fails later with a message blaming the browser. Two
lanes on one document are refused for the same reason. Better a rejection at the
call than a mystery at the tool call.

**`shutdown` reports what it had to force.** Abort everything under one
deadline, kill what is left, and say so — a wedged browser must not become a
hung quit.

### `supervisor/leftovers.ts`

```ts
export interface Leftover {
  readonly kind: "server" | "browser";
  readonly pid: number;
  readonly port?: number;
  readonly detail: string;
}

export function scan(deps: { backend?: ExecBackend; accounts: Iterable<AccountRef> }): Promise<Leftover[]>;
export function reap(l: Leftover, deps: { backend?: ExecBackend }): Promise<void>;
```

Separate from the supervisor because a `Leftover` is explicitly **not** a lane.
A `SIGKILL` ends a process without running any `finally`; what it leaves is
reported and offered for reaping, never adopted, and its ports are excluded from
allocation. Keeping the types distinct stops "adopt it" from ever looking like a
one-line change.

---

## `tui/` — a renderer, and nothing else

```ts
export interface Screen {
  readonly records: readonly LaneRecord[];
  readonly leftovers: readonly Leftover[];
  readonly form?: FormState;
}

export function render(screen: Screen, size: { cols: number; rows: number }): string;

export type Intent =
  | { kind: "open"; spec: Omit<LaneSpec, "id"> }
  | { kind: "close"; id: string }
  | { kind: "retry"; id: string }
  | { kind: "reap"; leftover: Leftover }
  | { kind: "quit"; force: boolean };

export function run(sup: Supervisor, io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream }): Promise<number>;
```

**`render` is a pure function from state to a string.** That makes the layout
testable without a terminal, and it keeps every decision — which lane is
highlighted, whether a combination is refusable — in the supervisor or in
`core/`, where it can be tested too.

`Intent` is a closed union so that adding a capability to the CLI and forgetting
it in the TUI becomes a type error. The old split had exactly that failure:
flags existed in bash that the Python front end could not express.

---

## `main.ts` — the single exit point

```ts
export function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number>;
```

Parses, builds the dependency graph once, dispatches to the TUI or to one
non-interactive command, and returns a code. The process exits in exactly one
place, in the real entry point, after `main` resolves.

---

## What gets tested, and how

| module | test style |
| --- | --- |
| `core/*`, `exec/procnet.ts`, `tui/render.ts` | pure unit tests, no mocks needed |
| `supervisor/lane.ts` | fake `LaneDeps`; assert the event sequence and that every `finally` ran |
| `supervisor/supervisor.ts` | fake lanes; assert refusals, shutdown forcing, subscription fan-out |
| `exec/compose.ts`, `exec/kubectl.ts` | one shared contract test, run against a fake and against the real thing |
| `browser/*`, `penpot/*` | thin; covered by the end-to-end smoke |

The contract test for `ExecBackend` — start a process, see its port in
`listening()`, expose it, kill it, see the port released — is what keeps the
move to Kubernetes from being a rewrite.
