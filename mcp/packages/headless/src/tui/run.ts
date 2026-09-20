// The input loop: keys in, intents out, and a redraw when anything changes.
//
// ANSI over node:readline in raw mode. No curses equivalent is needed for one
// list and one form, and no TUI framework is worth a dependency for it.
//
// This file holds no rules. It maps keys to intents, hands them to the
// supervisor or to the form, and asks `render` for a screen. Everything that
// can be wrong -- whether a lane may open, which port is free, what a row says,
// what a key means for a field -- lives somewhere testable without a terminal.

import { emitKeypressEvents } from "node:readline";

import { flavourOf } from "../browser/launch.ts";
import type { Settings, TuiSettings } from "../core/config.ts";
import { isLauncherError } from "../core/errors.ts";
import type { PortRange } from "../core/ports.ts";
import { hostProcesses } from "../supervisor/host-processes.ts";
import { reap, type Leftover } from "../supervisor/leftovers.ts";
import type { LaneRecord, Supervisor } from "../supervisor/supervisor.ts";
import { applyKey, newForm, toFormState, toSpec, type FormModel } from "./form.ts";
import { render, type Screen } from "./render.ts";

/** How often to redraw with nothing new, so uptimes advance. */
const TICK_MS = 1000;

const ESC = "\u001B";
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/** A key, as node:readline reports it. */
export interface Key {
    readonly name?: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
}

/** What the loop needs to run. */
export interface TuiDeps {
    readonly supervisor: Supervisor;
    readonly settings: Settings;
    readonly leftovers: readonly Leftover[];
    readonly portRange: PortRange;
    readonly input: NodeJS.ReadStream;
    readonly output: NodeJS.WritableStream;
    /** Skips the confirmation before quitting. */
    readonly yes: boolean;
    readonly env: NodeJS.ProcessEnv;
    /** Which columns the list shows, and whether the status bar is on. */
    readonly tui: TuiSettings;
}

/**
 * Runs the TUI until the operator quits, and returns an exit code.
 *
 * Quitting ends every lane the supervisor opened. There is no "leave it
 * running": a lane that outlived its supervisor is exactly the leftover the
 * startup scan exists to report.
 */
export async function runTui(deps: TuiDeps): Promise<number> {
    const { supervisor, output, input } = deps;

    let records: readonly LaneRecord[] = supervisor.list();
    let leftovers = [...deps.leftovers];
    let selected = 0;
    let message: string | undefined;
    let form: FormModel | undefined;
    let confirming = false;
    let finish: ((code: number) => void) | null = null;

    const draw = () => {
        const screen: Screen = {
            records,
            leftovers,
            selected: Math.min(selected, Math.max(0, records.length - 1)),
            portRange: deps.portRange,
            columns: deps.tui.columns,
            statusBar: deps.tui.statusBar,
            now: Date.now(),
            ...(message === undefined ? {} : { message }),
            ...(form === undefined ? {} : { form: toFormState(form) }),
        };
        output.write(`${CLEAR}${render(screen, sizeOf(output))}\n`);
    };

    const unsubscribe = supervisor.subscribe((next) => {
        records = next;
        draw();
    });
    const ticking = setInterval(draw, TICK_MS);

    /** Runs an action and turns a refusal into a line the operator can read. */
    const attempt = async (action: () => Promise<void>) => {
        try {
            await action();
            message = undefined;
        } catch (err) {
            message = isLauncherError(err) ? err.message : err instanceof Error ? err.message : String(err);
        }
        draw();
    };

    const submit = async (model: FormModel) => {
        await attempt(async () => {
            const spec = toSpec(model, deps.settings, flavourOf(browserOptions(deps.env)));
            await supervisor.open(spec);
            form = undefined;
        });
    };

    const onKey = (chunk: string, key: Key | undefined) => {
        const name = key?.name ?? chunk;

        if (key?.ctrl === true && name === "c") {
            void quit();
            return;
        }

        // The form takes every key while it is open, so typing a uuid cannot
        // trigger a list action -- "d" and "e" are hex digits.
        if (form !== undefined) {
            const result = applyKey(form, key ?? { sequence: chunk });
            form = result.model;
            if (result.cancel === true) form = undefined;
            if (result.submit === true) {
                void submit(result.model);
                return;
            }
            draw();
            return;
        }

        if (confirming) {
            confirming = false;
            if (name === "q" || name === "y") void quit();
            else {
                message = undefined;
                draw();
            }
            return;
        }

        switch (name) {
            case "up":
            case "k":
                selected = Math.max(0, selected - 1);
                draw();
                break;
            case "down":
            case "j":
                selected = Math.min(Math.max(0, records.length - 1), selected + 1);
                draw();
                break;
            case "n":
                form = newForm(deps.settings);
                draw();
                break;
            case "s":
                void attempt(async () => {
                    const record = records[selected];
                    if (record !== undefined) await supervisor.close(record.spec.id);
                });
                break;
            case "r":
                void attempt(async () => {
                    // Leftovers first: they are the reason the key exists at
                    // startup, and they are gone before any lane has failed.
                    const leftover = leftovers[0];
                    if (leftover !== undefined) {
                        await reap(leftover, { host: hostProcesses });
                        leftovers = leftovers.slice(1);
                        return;
                    }
                    const record = records[selected];
                    if (record !== undefined) await supervisor.retry(record.spec.id);
                });
                break;
            case "i":
                leftovers = [];
                message = "leftovers ignored; their ports stay excluded while they listen";
                draw();
                break;
            case "l":
                showLog(records[selected]);
                break;
            case "q":
                if (deps.yes || records.length === 0) void quit();
                else {
                    confirming = true;
                    message = `quitting stops ${records.length} lane(s). press q again to confirm.`;
                    draw();
                }
                break;
            default:
                break;
        }
    };

    const showLog = (record: LaneRecord | undefined) => {
        if (record?.log === undefined || record.log.length === 0) {
            message = "no log for that lane";
            draw();
            return;
        }
        output.write(`${CLEAR}${record.log.join("\n")}\n\npress any key\n`);
    };

    const quit = async () => {
        clearInterval(ticking);
        unsubscribe();
        output.write(`${CLEAR}stopping every lane...\n`);

        const { forced } = await supervisor.shutdown(15_000);
        if (forced > 0) output.write(`${forced} lane(s) had to be forced\n`);

        finish?.(0);
    };

    const restore = () => {
        clearInterval(ticking);
        input.off("keypress", onKey);
        if (input.isTTY) input.setRawMode(false);
        input.pause();
        output.write(SHOW_CURSOR);
    };

    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    output.write(HIDE_CURSOR);
    draw();

    try {
        return await new Promise<number>((resolve) => {
            finish = resolve;
        });
    } finally {
        restore();
    }
}

/** Browser options from the environment, matching the old worker's names. */
function browserOptions(env: NodeJS.ProcessEnv) {
    return {
        channel: env.PENPOT_BROWSER_CHANNEL ?? "",
        args: (env.PENPOT_BROWSER_ARGS ?? "").split(/\s+/).filter(Boolean),
    };
}

function sizeOf(output: NodeJS.WritableStream): { cols: number; rows: number } {
    const stream = output as NodeJS.WriteStream;
    return { cols: stream.columns ?? 80, rows: stream.rows ?? 24 };
}
