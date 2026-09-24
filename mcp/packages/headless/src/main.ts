// The one place the program decides what to do, and the only one that knows
// how every piece is wired together.
//
// `main` returns an exit code and never calls process.exit. That is not tidiness
// for its own sake: the tooling being replaced called exit from inside a branch,
// which skipped its own cleanup trap and orphaned a server in the container.
// Here the process ends in exactly one place, in bin/, after main resolves.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SCRATCH, HELP, parseArgs, type LaneRequest, type Options, type ProvisionRequest } from "./args.ts";
import { load, type Account, type ConfigIo, type Settings } from "./core/config.ts";
import type { WorkerUser } from "./core/conf.ts";
import { isLauncherError } from "./core/errors.ts";
import { flavourOf, playwrightLaunch, playwrightSessions } from "./browser/launch.ts";
import { LeasingPool } from "./browser/pool.ts";
import { ensureSession, sessionStore } from "./browser/session.ts";
import { backendFor, type ExecBackend } from "./exec/backend.ts";
import { facadeAddress } from "./facade/address.ts";
import { SdkBackend } from "./facade/backend.ts";
import { Facade } from "./facade/facade.ts";
import { laneCapacity, supervisorLanes } from "./facade/lanes.ts";
import { LeaseRegistry } from "./facade/leases.ts";
import { serveFacade, type Serving } from "./facade/server.ts";
import { portMap } from "./core/ports.ts";
import { catalogue } from "./penpot/catalogue.ts";
import { penpotApi } from "./penpot/rpc.ts";
import { workerAdmin } from "./provision/admin.ts";
import { provisioningApi } from "./provision/api.ts";
import { provisionWorker, type WriteSecret } from "./provision/worker.ts";
import { normalizeOrigin } from "./core/target.ts";
import type { LaneDeps, LaneSpec } from "./supervisor/lane.ts";
import { describe as describeLeftover, scan } from "./supervisor/leftovers.ts";
import { hostProcesses } from "./supervisor/host-processes.ts";
import { LaneSupervisor } from "./supervisor/supervisor.ts";
import { runTui } from "./tui/run.ts";

/** Where the streams and the clock come from, so tests can supply their own. */
export interface Io {
    readonly out: NodeJS.WritableStream;
    readonly err: NodeJS.WritableStream;
    readonly input?: NodeJS.ReadStream;
    /** Overrides the real filesystem for configuration. */
    readonly config?: ConfigIo;
    /** Overrides the container backend, so --check can be driven by a fake. */
    readonly backend?: ExecBackend | null;
    /** Overrides writing the account file, so provisioning can be driven by a fake. */
    readonly write?: WriteSecret;
}

const VERSION = "0.0.0";

/** Parses, wires, dispatches, and returns a code. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
    let options: Options;
    try {
        options = parseArgs(argv, env);
    } catch (err) {
        io.err.write(`${message(err)}\n`);
        return 2;
    }

    if (options.command === "help") {
        io.out.write(`${HELP}\n`);
        return 0;
    }
    if (options.command === "version") {
        io.out.write(`${VERSION}\n`);
        return 0;
    }

    try {
        const settings = load(options.configDir, env, io.config ?? nodeConfigIo);
        return await dispatch(options, settings, env, io);
    } catch (err) {
        io.err.write(`${message(err)}\n`);
        return 1;
    }
}

async function dispatch(options: Options, settings: Settings, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
    const backend = await resolveBackend(settings, env, io);
    const portRange = settings.deployment?.portRange ?? { lo: 4601, hi: 4608 };

    if (options.command === "check") return await check(settings, backend, portRange, io);
    if (options.command === "provision") return await provision(options, settings, backend, env, io);

    const pool = new LeasingPool(playwrightLaunch(launchOptions(env)));
    const map = portMap(portRange, settings.deployment?.upstreamPortRange);
    const deps: LaneDeps = { ...(backend === undefined ? {} : { backend }), pool, portRange, portMap: map };
    const supervisor = new LaneSupervisor(deps);

    const leftovers = await scan({
        ...(backend === undefined ? {} : { backend }),
        portRange,
        accounts: settings.accounts.values(),
        host: hostProcesses,
    });

    const serving = options.serve ? await serve(options, settings, supervisor, env, io) : null;

    // One place registers the signals, and both front ends honour the same
    // one. The TUI used to register none, so a SIGTERM killed the process
    // before any cleanup ran and left its lanes in the container -- total
    // ownership undone by a signal nobody had thought about.
    const stopping = new AbortController();
    const onSignal = () => stopping.abort();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, onSignal);

    try {
        if (options.command === "no-tui") {
            return await headless(options, settings, supervisor, serving, leftovers.length, io, env, stopping.signal);
        }

        // Nobody is watching a screen that is not a terminal, and the list
        // redraws once a second -- redirected, that is a screenful per second
        // into a file. So a redirected stdout switches the screen off rather
        // than needing a flag to say so.
        if (!isTerminal(io.out)) {
            return await serveQuietly(supervisor, serving, io, stopping.signal);
        }

        return await runTui({
            supervisor,
            settings,
            leftovers,
            portRange,
            input: io.input ?? process.stdin,
            output: io.out,
            yes: options.yes,
            env,
            // The flag wins over the file, which wins over the default.
            tui: options.columns === undefined ? settings.tui : { ...settings.tui, columns: options.columns },
            catalogue: catalogue(penpotApi()),
            stopping: stopping.signal,
        });
    } finally {
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, onSignal);
        await serving?.close();
    }
}

/**
 * Opens the MCP endpoint, so an agent's configuration is one static URL.
 *
 * Needs an account: the façade lists that account's documents and drives them.
 * With none configured there is nothing to serve, which is worth saying rather
 * than binding a port that can answer nothing.
 */
async function serve(
    options: Options,
    settings: Settings,
    supervisor: LaneSupervisor,
    env: NodeJS.ProcessEnv,
    io: Io
): Promise<Serving | null> {
    const configured = workerPool(settings);
    if (configured.length === 0) {
        io.err.write(unprovisioned(settings));
        return null;
    }

    // Once per worker, before any lane wants one. A profile with no session
    // opens the workspace on a login page, so the plugin never dials and the
    // lane fails ninety seconds later as a timeout -- which says nothing about
    // the password that was never used. Doing it here also means the pool is
    // the workers that actually work, rather than the ones that were listed.
    const accounts: Account[] = [];
    const store = sessionStore(playwrightSessions(launchOptions(env)));
    for (const account of configured) {
        try {
            await ensureSession(account, store, AbortSignal.timeout(90_000));
            accounts.push(account);
        } catch (err) {
            // The origin is named here because the underlying error often does
            // not, and because it is the thing that is usually wrong: a worker
            // path has to be reachable AND trustworthy to the browser, and
            // "cannot sign in" says neither.
            // First line only. Playwright appends a seven-line call log with
            // the request headers it sent, which is its own internals rather
            // than anything the reader can act on, and it buries the next
            // worker's line.
            const why = message(err).split("\n")[0];
            io.err.write(
                `${account.name} cannot sign in at ${normalizeOrigin(account.origin)}, ` +
                    `so it is not in the pool: ${why}\n`
            );
        }
    }
    if (accounts.length === 0) {
        io.err.write(
            `no worker could sign in, so the MCP endpoint is not opened. ` +
                `Each account's PENPOT_ORIGIN must answer from this machine, and the browser ` +
                `keeps a session only for a trustworthy origin -- loopback or https\n`
        );
        return null;
    }

    // The static tools go to the instance's own endpoint, which is routed by a
    // token. Any worker's will do, so the first one that has one is used and
    // the rest are only ever lanes.
    const routed = accounts.find((candidate) => candidate.mcpToken !== undefined);
    if (routed?.mcpToken === undefined) {
        io.err.write(`no worker has an MCP token, so the MCP endpoint is not opened\n`);
        return null;
    }

    const portRange = settings.deployment?.portRange ?? { lo: 4601, hi: 4608 };
    const backend = new SdkBackend();
    const facade = new Facade({
        leases: new LeaseRegistry(
            supervisorLanes(supervisor, backend, { accounts, flavour: flavourOf(launchOptions(env)) }),
            { capacity: laneCapacity(portRange, accounts.length) }
        ),
        backend,
        catalogue: catalogue(penpotApi()),
        accounts,
        // The instance's own endpoint answers the tools that need no document,
        // so an agent's first call cannot fail for want of one.
        staticEndpoint: `${normalizeOrigin(routed.origin)}/mcp/stream?userToken=${encodeURIComponent(routed.mcpToken)}`,
    });

    const serving = await serveFacade({
        facade,
        address: facadeAddress(options.listen, env, settings.facade),
        log: (line) => io.out.write(`${line}\n`),
    });

    return {
        address: serving.address,
        close: async () => {
            await serving.close();
            await backend.closeAll();
        },
    };
}

/**
 * Creates a worker account, and writes the account file the launcher reads.
 *
 * Needs the admin container, because there is no RPC command that creates a
 * profile on an instance with self-registration off.
 */
async function provision(
    options: Options,
    settings: Settings,
    backend: ExecBackend | undefined,
    env: NodeJS.ProcessEnv,
    io: Io
): Promise<number> {
    const request = options.provision;
    if (request === undefined) return 2;
    if (backend === undefined) {
        io.err.write(`provisioning needs a deployment; none is configured in ${options.configDir}\n`);
        return 1;
    }

    const wanted = targets(request, settings);
    if (wanted.length === 0) {
        io.err.write(
            request.email === ""
                ? `no --email, and no workers left to provision in ${options.configDir}/conf.yaml\n`
                : "provision-worker-user needs --email\n"
        );
        return 2;
    }

    const deps = {
        admin: workerAdmin(backend),
        api: provisioningApi(),
        tokens: penpotApi(),
        io: io.config ?? nodeConfigIo,
        accountsDir: `${options.configDir}/accounts`,
        write: io.write ?? writeSecret,
        log: (line: string) => io.out.write(`${line}\n`),
        newPassword: () => randomBytes(18).toString("base64url"),
        env,
    };

    const origin = request.origin ?? settings.penpotUrl ?? "http://localhost:9001";
    for (const target of wanted) {
        if (wanted.length > 1) io.out.write(`\n--- ${target.name}\n`);
        await provisionWorker(
            {
                email: target.email,
                origin,
                account: target.name,
                fullName: target.fullName ?? target.name,
                invitations: request.invitations,
                resetPassword: request.resetPassword,
                mintToken: request.mintToken,
                // Named for the worker, because every worker gets one and the
                // façade lists the pool's documents together: two files called
                // "worker-scratch" are two rows an agent cannot tell apart.
                fileName: request.fileName === DEFAULT_SCRATCH ? `${target.name}-scratch` : request.fileName,
            },
            deps
        );
    }

    const named = wanted.map((target) => target.name).join(", ");
    io.out.write(`\nprovisioned ${named}; they appear in the TUI's Account field and in --account\n`);
    return 0;
}

/**
 * Which workers to provision: the one named, or the ones still missing.
 *
 * With no `--email` this is "finish the job the file describes", so a worker
 * that already has an account file is skipped rather than re-provisioned --
 * re-running is safe but not free, and the common case is adding the fourth
 * worker to a pool of three.
 */
function targets(request: ProvisionRequest, settings: Settings): WorkerUser[] {
    if (request.email !== "") {
        const local = request.email.split("@")[0] ?? request.email;
        const name = request.account ?? local;
        return [
            {
                name,
                email: request.email,
                ...(request.fullName === undefined ? {} : { fullName: request.fullName }),
            },
        ];
    }
    return settings.workers.filter((worker) => !settings.accounts.has(worker.name));
}

/**
 * The workers the façade may draw on, in the order the configuration names them.
 *
 * `conf.yaml` names a pool; without one, every account on disk is a worker,
 * which is what the launcher did before the pool existed. A worker named in
 * the file with no account file yet is not in the pool -- it has no password
 * and no token, so it is a plan rather than an account.
 */
function workerPool(settings: Settings): Account[] {
    if (settings.workers.length === 0) return [...settings.accounts.values()];

    return settings.workers
        .map((worker) => settings.accounts.get(worker.name))
        .filter((account): account is Account => account !== undefined);
}

/** Says which workers still need provisioning, since that is the next step. */
function unprovisioned(settings: Settings): string {
    if (settings.workers.length === 0) {
        return "no accounts configured, so the MCP endpoint is not opened; see --help\n";
    }
    const names = settings.workers.map((worker) => worker.name).join(", ");
    return (
        `none of the configured workers has an account file yet (${names}), ` +
        `so the MCP endpoint is not opened; run provision-worker-user\n`
    );
}

/** Reports wreckage from a previous run, and says nothing else. */
async function check(
    settings: Settings,
    backend: ExecBackend | undefined,
    portRange: { lo: number; hi: number },
    io: Io
): Promise<number> {
    const leftovers = await scan({
        ...(backend === undefined ? {} : { backend }),
        portRange,
        accounts: settings.accounts.values(),
        host: hostProcesses,
    });

    if (leftovers.length === 0) {
        io.out.write("no leftovers\n");
        return 0;
    }

    io.out.write(`${leftovers.length} leftover${leftovers.length === 1 ? "" : "s"} from a previous run\n`);
    for (const leftover of leftovers) io.out.write(`  ${describeLeftover(leftover)}\n`);

    // Non-zero so a systemd unit or a shell script notices without parsing.
    return 1;
}

/**
 * Supervises the lanes named on the command line, logging transitions.
 *
 * The same supervisor as the TUI, with a log writer where the renderer would
 * be. It is not a different program and not a different code path.
 */
async function headless(
    options: Options,
    settings: Settings,
    supervisor: LaneSupervisor,
    serving: Serving | null,
    leftovers: number,
    io: Io,
    env: NodeJS.ProcessEnv,
    stopping: AbortSignal
): Promise<number> {
    if (leftovers > 0) io.err.write(`warning: ${leftovers} leftover(s) from a previous run; try --check\n`);

    // No lanes is not a mistake once the endpoint exists: an agent asks for
    // documents through it, so there is nothing to name up front. Without the
    // endpoint there would genuinely be nothing to do.
    if (options.lanes.length === 0 && serving === null) {
        io.err.write("--no-tui with no lanes needs the MCP endpoint; drop --no-serve, or name a lane\n");
        return 2;
    }

    const seen = new Set<string>();
    supervisor.subscribe((records) => {
        for (const record of records) {
            const line = `${record.spec.id} ${record.state} ${record.clientUrl ?? record.detail ?? record.error ?? ""}`;
            if (seen.has(line)) continue;
            seen.add(line);
            io.out.write(`${line.trimEnd()}\n`);
        }
    });

    const store = sessionStore(playwrightSessions(launchOptions(env)));

    try {
        // Once per account, before any browser holds its profile.
        for (const name of new Set(options.lanes.map((lane) => lane.account))) {
            const account = settings.accounts.get(name);
            if (account !== undefined) await ensureSession(account, store, AbortSignal.timeout(60_000));
        }
        for (const lane of options.lanes) {
            await supervisor.open(specFor(lane, settings, env));
        }
    } catch (err) {
        io.err.write(`${message(err)}\n`);
        await supervisor.shutdown(10_000);
        return 1;
    }

    const code = await waitForStop(supervisor, io, stopping);
    const { forced } = await supervisor.shutdown(15_000);
    if (forced > 0) io.err.write(`${forced} lane(s) had to be forced\n`);
    return code;
}

/** True when the stream is a terminal someone could be looking at. */
function isTerminal(out: NodeJS.WritableStream): boolean {
    return (out as NodeJS.WriteStream).isTTY === true;
}

/**
 * Serves the MCP endpoint and waits, logging what the lanes do.
 *
 * No screen, one line per transition, and an exit only on a signal or on `q`'s
 * equivalent. Reached either by asking -- `--no-tui` with no lanes named -- or
 * by redirecting stdout, where drawing would be pointless.
 */
async function serveQuietly(
    supervisor: LaneSupervisor,
    serving: Serving | null,
    io: Io,
    stopping: AbortSignal
): Promise<number> {
    if (serving === null) {
        io.err.write("nothing to do: stdout is not a terminal and the MCP endpoint is not open\n");
        return 2;
    }

    const seen = new Set<string>();
    supervisor.subscribe((records) => {
        for (const record of records) {
            const document = record.spec.document.name ?? record.spec.document.fileId;
            const line = `${document} ${record.state} ${record.clientUrl ?? record.error ?? ""}`.trimEnd();
            if (seen.has(line)) continue;
            seen.add(line);
            io.out.write(`${line}\n`);
        }
    });

    await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => undefined, 1 << 30);
        const finish = () => {
            clearInterval(keepAlive);
            resolve();
        };
        if (stopping.aborted) finish();
        else stopping.addEventListener("abort", finish, { once: true });
    });

    const { forced } = await supervisor.shutdown(15_000);
    if (forced > 0) io.err.write(`${forced} lane(s) had to be forced\n`);
    return 0;
}

/**
 * Holds the process open until a signal, or until nothing is left running.
 *
 * The keep-alive timer is load-bearing. Without it Node finds an empty event
 * loop the moment every lane has settled and exits 13 for an unsettled
 * top-level await, which is neither a code anyone can act on nor a hint about
 * what went wrong.
 *
 * Exiting non-zero once every lane has failed is the systemd shape: the unit
 * fails and gets restarted, rather than sitting up with nothing running.
 */
function waitForStop(supervisor: LaneSupervisor, io: Io, stopping: AbortSignal): Promise<number> {
    return new Promise<number>((resolve) => {
        const keepAlive = setInterval(() => undefined, 1 << 30);

        const finish = (code: number) => {
            clearInterval(keepAlive);
            unsubscribe();
            stopping.removeEventListener("abort", onStop);
            resolve(code);
        };

        const onStop = () => finish(0);

        const unsubscribe = supervisor.subscribe((records) => {
            if (records.length > 0 && records.every((record) => record.state === "failed")) {
                io.err.write("every lane failed\n");
                finish(1);
            }
        });

        if (stopping.aborted) finish(0);
        else stopping.addEventListener("abort", onStop, { once: true });
    });
}

/** Turns a command-line lane into the spec the supervisor takes. */
export function specFor(lane: LaneRequest, settings: Settings, env: NodeJS.ProcessEnv): Omit<LaneSpec, "id"> {
    const account = settings.accounts.get(lane.account);
    if (account === undefined) {
        const known = [...settings.accounts.keys()].join(", ") || "none";
        throw Object.assign(new Error(`no account named ${lane.account}; known accounts: ${known}`), {
            name: "LauncherError",
        });
    }

    return {
        account,
        document: { fileId: lane.fileId, teamId: lane.teamId },
        mode: lane.mode,
        headed: lane.headed,
        flavour: flavourOf(launchOptions(env)),
        // Falls back to the launcher's own screen, which is what a person
        // means by --headed with DISPLAY already set.
        ...(lane.headed ? { display: lane.display ?? env.DISPLAY ?? "" } : {}),
        ...(lane.port === undefined ? {} : { port: { http: lane.port, ws: lane.port + 1 } }),
    };
}

/** Browser options from the environment, matching the old worker's names. */
function launchOptions(env: NodeJS.ProcessEnv) {
    return {
        channel: env.PENPOT_BROWSER_CHANNEL ?? "",
        args: (env.PENPOT_BROWSER_ARGS ?? "").split(/\s+/).filter(Boolean),
        clearCache: env.PENPOT_CLEAR_CACHE !== "false",
    };
}

/** Builds the backend, unless a test supplied one or there is no deployment. */
async function resolveBackend(settings: Settings, env: NodeJS.ProcessEnv, io: Io): Promise<ExecBackend | undefined> {
    if (io.backend !== undefined) return io.backend ?? undefined;
    if (settings.deployment === undefined) return undefined;
    return await backendFor(settings.deployment, env);
}

/**
 * Writes a file nobody else can read, and does so before there is anything in it.
 *
 * The mode is set on the empty file rather than after writing, so the secret is
 * never briefly world-readable -- a window that is short, real, and entirely
 * avoidable.
 */
const writeSecret: WriteSecret = async (path, contents) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
    writeFileSync(path, contents);
};

/** The real filesystem, bound here and nowhere else. */
const nodeConfigIo: ConfigIo = {
    read: (path) => {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return null;
        }
    },
    list: (dir) => {
        try {
            return readdirSync(dir);
        } catch {
            return [];
        }
    },
};

/** A message for a person, whether the throw was a refusal or a bug. */
function message(err: unknown): string {
    if (isLauncherError(err)) return err.message;
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
