// The command line, parsed into something the rest of the program can use.
//
// Hand-rolled because the grammar is small and the dependency budget is one
// runtime package. The one unusual rule is that lane flags repeat: each
// --account starts a new lane, so several can be named in one invocation and
// the systemd unit is a single command.

import { parseColumns, type ColumnName } from "./core/columns.ts";
import { parseListen, type Address } from "./facade/address.ts";
import { fail } from "./core/errors.ts";
import type { Mode } from "./core/topology.ts";

/** One lane asked for on the command line. */
export interface LaneRequest {
    readonly account: string;
    readonly fileId: string;
    readonly teamId: string;
    readonly mode: Mode;
    readonly headed: boolean;
    readonly port?: number;
    readonly display?: string;
}

/** What to do, once. */
export type Command = "tui" | "no-tui" | "check" | "help" | "version";

export interface Options {
    readonly command: Command;
    readonly configDir: string;
    readonly lanes: readonly LaneRequest[];
    /** Skips the confirmation before quitting. */
    readonly yes: boolean;
    /** Overrides the list's columns for this run. */
    readonly columns?: readonly ColumnName[];
    /** Whether to open the MCP endpoint. On unless --no-serve. */
    readonly serve: boolean;
    /** Overrides where that endpoint listens. */
    readonly listen?: Partial<Address>;
}

const MODES: readonly Mode[] = ["builtin", "exec", "local", "image"];

export const HELP = `mcp-headless -- supervise headless Penpot MCP lanes

  mcp-headless                      supervise, with the TUI
  mcp-headless --no-tui [lanes...]  supervise, logging to stdout
  mcp-headless --check              report leftovers from a previous run and exit

A lane is named with --account, --file-id and --team-id. Repeat the group to
name more than one; each --account starts a new lane.

  --account NAME      the account file under <config>/accounts
  --file-id UUID      the document to drive
  --team-id UUID      the team it belongs to. Both ids are required: a
                      workspace URL with only a file id renders nothing
  --port N            the MCP port, inside the deployment's published range
  --mode MODE         builtin | exec | local | image. Default exec, and the
                      only one v1 implements
  --headed            show the browser. Needs DISPLAY
  --display :N        the X display for --headed

  --listen ADDR       where the MCP endpoint listens: 4400, :4400 or
                      127.0.0.1:4400. Overrides $HOST and $PORT; the default
                      is 127.0.0.1:4400
  --no-serve          do not open the MCP endpoint at all
  --config DIR        where deployment.json, tui.json and accounts/ live
  --columns a,b,c     which columns the list shows, in order. Overrides
                      tui.json. See --columns help for the names
  --yes               do not ask before quitting
  --help, --version`;

/**
 * Parses argv, or throws saying what is wrong with it.
 *
 * Throws rather than exiting, because `main` owns the only exit in the
 * program. That is not a style rule: the thing being replaced called exit from
 * inside a branch and skipped its own cleanup.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Options {
    let command: Command = "tui";
    let configDir = env.MCP_HEADLESS_CONFIG ?? defaultConfigDir(env);
    let yes = false;
    let columns: readonly ColumnName[] | undefined;
    let serve = true;
    let listen: Partial<Address> | undefined;

    const lanes: LaneRequest[] = [];
    /** The lane being filled in. A new --account starts the next one. */
    let current: Partial<LaneRequest> | null = null;

    const finish = () => {
        if (current === null) return;
        lanes.push(completeLane(current));
        current = null;
    };

    /** Reads the value of a flag that takes one, or says which flag lacks it. */
    const valueOf = (flag: string, index: number): string => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            fail("not-configured", `${flag} needs a value`, { flag });
        }
        return value;
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] as string;

        switch (arg) {
            case "--help":
            case "-h":
                return { command: "help", configDir, lanes: [], yes, serve };
            case "--version":
                return { command: "version", configDir, lanes: [], yes, serve };
            case "--no-tui":
                command = "no-tui";
                break;
            case "--check":
                command = "check";
                break;
            case "--yes":
                yes = true;
                break;
            case "--config":
                configDir = valueOf(arg, index);
                index += 1;
                break;
            case "--columns":
                columns = parseColumns(valueOf(arg, index));
                index += 1;
                break;
            case "--listen":
                listen = parseListen(valueOf(arg, index));
                index += 1;
                break;
            case "--no-serve":
                serve = false;
                break;
            case "--account":
                finish();
                current = { account: valueOf(arg, index), mode: "exec", headed: false };
                index += 1;
                break;
            case "--file-id":
                current = intoLane(current, arg, { fileId: valueOf(arg, index) });
                index += 1;
                break;
            case "--team-id":
                current = intoLane(current, arg, { teamId: valueOf(arg, index) });
                index += 1;
                break;
            case "--port":
                current = intoLane(current, arg, { port: port(valueOf(arg, index)) });
                index += 1;
                break;
            case "--mode":
                current = intoLane(current, arg, { mode: mode(valueOf(arg, index)) });
                index += 1;
                break;
            case "--display":
                current = intoLane(current, arg, { display: valueOf(arg, index) });
                index += 1;
                break;
            case "--headed":
                current = intoLane(current, arg, { headed: true });
                break;
            default:
                fail("not-configured", `unknown argument ${arg}`, { argument: arg });
        }
    }
    finish();

    for (const lane of lanes) {
        // Refused here rather than when the browser fails to start with a
        // message about a missing display server.
        if (lane.headed && (lane.display ?? env.DISPLAY ?? "") === "") {
            fail("not-configured", `--headed needs a display; pass --display or set DISPLAY`, {
                account: lane.account,
            });
        }
    }

    return {
        command,
        configDir,
        lanes,
        yes,
        serve,
        ...(columns === undefined ? {} : { columns }),
        ...(listen === undefined ? {} : { listen }),
    };
}

/** Adds a field to the lane being built, or says which flag came too early. */
function intoLane(
    current: Partial<LaneRequest> | null,
    flag: string,
    patch: Partial<LaneRequest>
): Partial<LaneRequest> {
    if (current === null) {
        fail("not-configured", `${flag} must follow an --account`, { flag });
    }
    return { ...current, ...patch };
}

/** Insists a lane names everything a lane needs. */
function completeLane(lane: Partial<LaneRequest>): LaneRequest {
    const account = lane.account ?? "";
    for (const [flag, value] of [
        ["--file-id", lane.fileId],
        ["--team-id", lane.teamId],
    ] as const) {
        if (value === undefined || value === "") {
            fail("not-configured", `the lane for ${account} needs ${flag}`, { account, flag });
        }
    }

    return {
        account,
        fileId: lane.fileId as string,
        teamId: lane.teamId as string,
        mode: lane.mode ?? "exec",
        headed: lane.headed ?? false,
        ...(lane.port === undefined ? {} : { port: lane.port }),
        ...(lane.display === undefined ? {} : { display: lane.display }),
    };
}

function port(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        fail("not-configured", `--port ${value} is not a port number`, { value });
    }
    return parsed;
}

function mode(value: string): Mode {
    if (!MODES.includes(value as Mode)) {
        fail("not-configured", `--mode ${value} is not one of ${MODES.join(", ")}`, { value });
    }
    return value as Mode;
}

/** Where configuration lives when nothing says otherwise. */
export function defaultConfigDir(env: NodeJS.ProcessEnv): string {
    const base = env.XDG_CONFIG_HOME ?? `${env.HOME ?? "."}/.config`;
    return `${base}/mcp-headless`;
}
