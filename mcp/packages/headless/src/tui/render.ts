// The screen, as a pure function of state.
//
// Nothing here decides anything. Which lane is highlighted, whether a
// combination is allowed, what a key does -- all of that lives in the
// supervisor or in core/, where it can be tested without a terminal. This file
// turns a Screen into a string, and that is the whole of it.

import { COLUMNS, DEFAULT_COLUMNS, type ColumnName } from "../core/columns.ts";
import { describeRange } from "../core/ports.ts";
import type { LaneRecord } from "../supervisor/supervisor.ts";
import { describe as describeLeftover, type Leftover } from "../supervisor/leftovers.ts";

/** One line of a form, as the operator fills it in. */
export interface FormField {
    readonly label: string;
    readonly value: string;
    /** Shown after the value, in parentheses. */
    readonly hint?: string;
}

/** An open list of choices, under the row it belongs to. */
export interface FormExpansion {
    readonly options: readonly string[];
    readonly index: number;
}

/** The new-lane form, when one is open. */
export interface FormState {
    readonly title: string;
    readonly fields: readonly FormField[];
    /** Index of the field the cursor is on. */
    readonly cursor: number;
    /** The open list, when the focused row has one. */
    readonly expansion?: FormExpansion;
    /**
     * The non-interactive command this form is equivalent to.
     *
     * Printed because it is how the flags get learned. The curses version did
     * this and it is the only documentation of the command line anyone read.
     */
    readonly command: string;
    readonly error?: string;
}

/** Everything the screen shows. */
export interface Screen {
    readonly records: readonly LaneRecord[];
    readonly leftovers: readonly Leftover[];
    readonly form?: FormState;
    /** Index of the highlighted lane. */
    readonly selected?: number;
    /** The last refusal or error, shown until the next action. */
    readonly message?: string;
    /** Passed in rather than read, so a snapshot test is stable. */
    readonly now?: number;
    /** The published range, shown in the header when one is configured. */
    readonly portRange?: { readonly lo: number; readonly hi: number };
    /** Which columns to show, in order. Defaults to the usual six. */
    readonly columns?: readonly ColumnName[];
    /** The line under the list carrying what the columns truncate. */
    readonly statusBar?: boolean;
    /** Overrides what the status bar says; otherwise it describes the selection. */
    readonly status?: string;
    /** A lane to show in full, instead of the list. */
    readonly details?: LaneRecord;
}

export interface Size {
    readonly cols: number;
    readonly rows: number;
}

const ESC = "\u001B";
const REVERSE = `${ESC}[7m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/**
 * Removes ANSI so width can be measured and a snapshot can be read.
 *
 * Width has to be measured without it: an escape sequence takes no columns,
 * so padding that counts its characters produces a ragged table, and
 * truncation that counts them cuts visible text early.
 */
export function stripAnsi(text: string): string {
    return text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

/** Renders the whole screen. */
export function render(screen: Screen, size: Size): string {
    const cols = Math.max(40, size.cols);
    const names = screen.columns ?? DEFAULT_COLUMNS;
    const lines: string[] = [];

    lines.push(header(screen, cols));

    if (screen.details !== undefined) {
        lines.push(...detailsOf(screen.details, cols, screen.now ?? 0));
        lines.push(dim("─".repeat(cols)));
        lines.push(dim(truncate("  [esc] back   [s] stop   [r] retry   [l] logs   [q] quit", cols)));
        return lines.join("\n");
    }

    lines.push(dim(columns(names, cols)));

    if (screen.records.length === 0) {
        lines.push(dim(pad("  no lanes. [n] opens one.", cols)));
    } else {
        screen.records.forEach((record, index) => {
            const line = row(record, names, cols, screen.now ?? 0);
            lines.push(index === screen.selected ? `${REVERSE}${line}${RESET}` : line);

            // The step, on its own line: a lane can take ninety seconds to
            // connect, and a row that says nothing for that long reads as a
            // hang. It does not fit beside the columns at any sane width.
            if (record.state === "opening" && record.detail !== undefined) {
                lines.push(dim(truncate(`         ${record.detail}`, cols)));
            }
        });
    }

    if (screen.leftovers.length > 0) {
        const count = screen.leftovers.length;
        lines.push("");
        lines.push(truncate(`  ${count} leftover${count === 1 ? "" : "s"} from a previous run`, cols));
        for (const leftover of screen.leftovers) {
            lines.push(truncate(`    ${describeLeftover(leftover)}`, cols));
        }
        lines.push(dim(truncate("    [r] reap   [i] ignore", cols)));
    }

    if (screen.statusBar !== false) {
        const status = screen.status ?? statusFor(screen.records[screen.selected ?? 0]);
        lines.push(dim(truncate(`  ${status}`, cols)));
    }

    lines.push(dim("─".repeat(cols)));
    lines.push(dim(truncate(footer(screen), cols)));

    if (screen.message !== undefined && screen.message !== "") {
        lines.push(truncate(`  ${screen.message}`, cols));
    }

    if (screen.form !== undefined) lines.push(...form(screen.form, cols));

    return lines.join("\n");
}

/**
 * The keys, for whatever is on screen.
 *
 * Only what is true: the list advertised a details view for a while before one
 * existed, which is worse than not offering it.
 */
function footer(screen: Screen): string {
    if (screen.form !== undefined) {
        return "  [enter] choose or start   [space] toggle   [tab] next   [esc] back";
    }
    const reap = screen.leftovers.length > 0 ? "[r] reap" : "[r] retry";
    return `  [n] new lane   [enter] details   [s] stop   ${reap}   [l] logs   [q] quit`;
}

/** One lane in full, for the things the columns cannot hold. */
function detailsOf(record: LaneRecord, cols: number, now: number): string[] {
    const document = record.spec.document;
    const rows: [string, string][] = [
        ["state", record.state + (record.detail === undefined ? "" : `  ${record.detail}`)],
        ["document", document.name ?? "(unnamed)"],
        ["file id", document.fileId],
        ["team", document.teamName ?? "(unnamed)"],
        ["team id", document.teamId],
        ["account", record.spec.account.name],
        ["origin", record.spec.account.origin],
        ["mode", record.spec.mode],
        ["browser", record.spec.headed ? `headed on ${record.spec.display || "the default display"}` : "headless"],
        ["ports", record.port === undefined ? "—" : `http ${record.port.http}  ws ${record.port.ws}`],
        ["client", record.clientUrl ?? "—"],
        ["uptime", uptime(record, now)],
    ];
    if (record.error !== undefined) rows.push(["error", record.error]);

    const out = ["", `  LANE ${record.spec.id}`];
    for (const [label, value] of rows) out.push(truncate(`  ${cell(label, 10)} ${value}`, cols));

    if (record.log !== undefined && record.log.length > 0) {
        out.push("", dim("  last output"));
        for (const line of record.log.slice(-8)) out.push(dim(truncate(`    ${line}`, cols)));
    }
    return out;
}

function header(screen: Screen, cols: number): string {
    const right = screen.portRange === undefined ? "mcp-headless" : `${describeRange(screen.portRange)}  mcp-headless`;
    const left = "  LANES";
    const gap = Math.max(1, cols - left.length - right.length - 2);

    return truncate(`${left}${" ".repeat(gap)}${right}  `, cols);
}

/** Lays out one row of cells on the chosen columns' widths. */
function columnise(names: readonly ColumnName[], value: (name: ColumnName) => string): string {
    return `  ${names.map((name) => cell(value(name), COLUMNS[name].width)).join(" ")}`;
}

function columns(names: readonly ColumnName[], cols: number): string {
    return pad(
        truncate(
            columnise(names, (name) => COLUMNS[name].title),
            cols
        ),
        cols
    );
}

/** One lane, laid out to the same columns as the header. */
function row(record: LaneRecord, names: readonly ColumnName[], cols: number, now: number): string {
    return pad(
        truncate(
            columnise(names, (name) => valueOf(name, record, now)),
            cols
        ),
        cols
    );
}

/**
 * One lane's value for one column.
 *
 * The reading lives here rather than in `core/columns.ts` because `core/` knows
 * nothing about a supervisor, and the widths have to be validated without one.
 */
export function valueOf(name: ColumnName, record: LaneRecord, now: number): string {
    const document = record.spec.document;

    switch (name) {
        case "port":
            return record.port === undefined ? "—" : String(record.port.http);
        case "state":
            return record.state;
        case "document":
            return document.name ?? short(document.fileId);
        case "team":
            return document.teamName ?? short(document.teamId);
        case "account":
            return record.spec.account.name;
        case "browser":
            return record.spec.headed ? "headed" : "headless";
        case "display":
            return record.spec.headed ? (record.spec.display ?? "—") : "—";
        case "mode":
            return record.spec.mode;
        case "uptime":
            return uptime(record, now);
        case "client":
            return record.clientUrl ?? "—";
    }
}

/**
 * What the status bar says about the selection.
 *
 * The columns show what a person recognises and this shows what they have to
 * paste somewhere: the ids in full, and the URL an agent connects to. It is the
 * reason the document column can afford to show a name.
 */
export function statusFor(record: LaneRecord | undefined): string {
    if (record === undefined) return "";

    const document = record.spec.document;
    const parts = [`file ${document.fileId}`, `team ${document.teamId}`];
    if (record.clientUrl !== undefined) parts.push(record.clientUrl);
    if (record.state === "failed" && record.error !== undefined) parts.push(record.error);

    return parts.join("  ·  ");
}

function form(state: FormState, cols: number): string[] {
    const lines = ["", `  ${state.title.toUpperCase()}`];

    state.fields.forEach((field, index) => {
        const focused = index === state.cursor;
        const marker = focused ? "▸" : " ";
        const hint = field.hint === undefined ? "" : ` (${field.hint})`;
        lines.push(truncate(`  ${cell(field.label, 10)}${marker} ${field.value}${hint}`, cols));

        // The open list sits under the row it belongs to, so the thing being
        // chosen stays next to the choices.
        if (focused && state.expansion !== undefined) {
            state.expansion.options.forEach((option, optionIndex) => {
                const chosen = optionIndex === state.expansion?.index;
                const line = truncate(`             ${chosen ? "›" : " "} ${option}`, cols);
                lines.push(chosen ? `${REVERSE}${pad(line, cols)}${RESET}` : line);
            });
        }
    });

    if (state.error !== undefined) lines.push(truncate(`  ${state.error}`, cols));
    lines.push(dim(truncate(`  → ${state.command}`, cols)));
    return lines;
}

/** How long the lane has been in its current state. */
function uptime(record: LaneRecord, now: number): string {
    if (record.state === "failed") return "—";

    const seconds = Math.max(0, Math.floor((now - record.since) / 1000));
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** A fixed-width cell, truncated with an ellipsis rather than wrapped. */
function cell(text: string, width: number): string {
    return truncate(text, width).padEnd(width);
}

function truncate(text: string, width: number): string {
    if (stripAnsi(text).length <= width) return text;
    return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function pad(text: string, cols: number): string {
    const visible = stripAnsi(text).length;
    return visible >= cols ? text : text + " ".repeat(cols - visible);
}

function dim(text: string): string {
    return `${DIM}${text}${RESET}`;
}

/** The first eight characters of an id, which is how a person recognises one. */
function short(id: string): string {
    return id.slice(0, 8);
}
