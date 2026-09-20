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

    if (options.command === "no-tui") {
        return await headless(options, settings, supervisor, leftovers.length, io, env);
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
    });
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
    env: NodeJS.ProcessEnv
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

    const code = await waitForStop(supervisor, io);
    const { forced } = await supervisor.shutdown(15_000);
    if (forced > 0) io.err.write(`${forced} lane(s) had to be forced\n`);
    return code;
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
function waitForStop(supervisor: LaneSupervisor, io: Io): Promise<number> {
    return new Promise<number>((resolve) => {
        const keepAlive = setInterval(() => undefined, 1 << 30);

        const finish = (code: number) => {
            clearInterval(keepAlive);
            unsubscribe();
            resolve(code);
        };

        const unsubscribe = supervisor.subscribe((records) => {
            if (records.length > 0 && records.every((record) => record.state === "failed")) {
                io.err.write("every lane failed\n");
                finish(1);
            }
        });

        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            process.once(signal, () => finish(0));
        }
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
