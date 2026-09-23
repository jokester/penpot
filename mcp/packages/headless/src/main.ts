// The one place the program decides what to do, and the only one that knows
// how every piece is wired together.
//
// `main` returns an exit code and never calls process.exit. That is not tidiness
// for its own sake: the tooling being replaced called exit from inside a branch,
// which skipped its own cleanup trap and orphaned a server in the container.
// Here the process ends in exactly one place, in bin/, after main resolves.

import { readdirSync, readFileSync } from "node:fs";

import { HELP, parseArgs, type LaneRequest, type Options } from "./args.ts";
import { load, type ConfigIo, type Settings } from "./core/config.ts";
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
import { catalogue } from "./penpot/catalogue.ts";
import { penpotApi } from "./penpot/rpc.ts";
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
    const backend = await resolveBackend(settings, io);
    const portRange = settings.deployment?.portRange ?? { lo: 4601, hi: 4608 };

    if (options.command === "check") return await check(settings, backend, portRange, io);

    const pool = new LeasingPool(playwrightLaunch(launchOptions(env)));
    const deps: LaneDeps = { ...(backend === undefined ? {} : { backend }), pool, portRange };
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
            return await headless(options, settings, supervisor, leftovers.length, io, env, stopping.signal);
        }

        // Nobody is watching a screen that is not a terminal, and the TUI
        // redraws once a second -- detached, that is a screenful per second
        // into a log file. So when stdout is redirected the launcher serves
        // quietly instead of drawing, which is what a background service wants
        // and needs no flag to ask for.
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
    const account = [...settings.accounts.values()][0];
    if (account === undefined) {
        io.err.write("no accounts configured, so the MCP endpoint is not opened; see --help\n");
        return null;
    }
    if (account.mcpToken === undefined) {
        io.err.write(`${account.name} has no MCP token, so the MCP endpoint is not opened\n`);
        return null;
    }

    const portRange = settings.deployment?.portRange ?? { lo: 4601, hi: 4608 };
    const backend = new SdkBackend();
    const facade = new Facade({
        leases: new LeaseRegistry(
            supervisorLanes(supervisor, backend, { account, flavour: flavourOf(launchOptions(env)) }),
            { capacity: laneCapacity(portRange) }
        ),
        backend,
        catalogue: catalogue(penpotApi()),
        account,
        // The instance's own endpoint answers the tools that need no document,
        // so an agent's first call cannot fail for want of one.
        staticEndpoint: `${normalizeOrigin(account.origin)}/mcp/stream?userToken=${encodeURIComponent(account.mcpToken)}`,
    });

    const serving = await serveFacade({
        facade,
        address: facadeAddress(options.listen, env),
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
    leftovers: number,
    io: Io,
    env: NodeJS.ProcessEnv,
    stopping: AbortSignal
): Promise<number> {
    if (leftovers > 0) io.err.write(`warning: ${leftovers} leftover(s) from a previous run; try --check\n`);
    if (options.lanes.length === 0) {
        io.err.write("--no-tui needs at least one lane; see --help\n");
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
 * The shape a background service wants: no screen, one line per transition,
 * and an exit only on a signal. Unlike `--no-tui` it needs no lanes named up
 * front, because the agent asks for documents through the endpoint.
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
async function resolveBackend(settings: Settings, io: Io): Promise<ExecBackend | undefined> {
    if (io.backend !== undefined) return io.backend ?? undefined;
    if (settings.deployment === undefined) return undefined;
    return await backendFor(settings.deployment);
}

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
