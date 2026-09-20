// Which columns the lane list can show, and how wide each one is.
//
// Data rather than a hard-coded row, so the list can be adapted to what someone
// is actually watching: a person babysitting one document wants its name wide,
// and a person running five lanes wants ports and states and little else.
//
// Only the catalogue lives here, not the values. Reading a lane is the
// renderer's job -- `core/` knows nothing about a supervisor, and keeping the
// widths where they can be validated without one is the point.

import { fail } from "./errors.ts";

/** A column's title and the room it gets. */
export interface ColumnSpec {
    readonly title: string;
    readonly width: number;
    /** What the status bar should add when this column had to truncate. */
    readonly truncates?: boolean;
}

/**
 * Every column the list can show.
 *
 * Widths are what fits the thing at its usual size, not what fits its worst
 * case: a uuid never fits and is never meant to, which is what the status bar
 * is for.
 */
export const COLUMNS = {
    port: { title: "port", width: 5 },
    state: { title: "state", width: 11 },
    document: { title: "document", width: 23, truncates: true },
    team: { title: "team", width: 16, truncates: true },
    account: { title: "account", width: 13 },
    browser: { title: "browser", width: 9 },
    display: { title: "display", width: 8 },
    mode: { title: "mode", width: 8 },
    uptime: { title: "uptime", width: 7 },
    client: { title: "client", width: 26, truncates: true },
} as const satisfies Record<string, ColumnSpec>;

export type ColumnName = keyof typeof COLUMNS;

/** The names, for an error message that is worth reading. */
export const COLUMN_NAMES = Object.keys(COLUMNS) as readonly ColumnName[];

/** What the list shows when nothing says otherwise. */
export const DEFAULT_COLUMNS: readonly ColumnName[] = ["port", "state", "document", "account", "browser", "uptime"];

/**
 * Reads a column list, from a flag or from a configuration file.
 *
 * Accepts a comma-separated string or an array, because one comes from the
 * command line and the other from JSON. Throws on a name that does not exist,
 * naming the ones that do -- a silently dropped column is a column someone
 * spends a while looking for.
 */
export function parseColumns(value: string | readonly unknown[]): ColumnName[] {
    const raw = typeof value === "string" ? value.split(",") : value;
    const names: ColumnName[] = [];

    for (const entry of raw) {
        if (typeof entry !== "string") {
            fail("not-configured", `a column must be a name, not ${JSON.stringify(entry)}`, {});
        }
        const name = entry.trim();
        if (name === "") continue;

        if (!isColumn(name)) {
            fail("not-configured", `there is no ${name} column; the ones there are: ${COLUMN_NAMES.join(", ")}`, {
                column: name,
            });
        }
        if (!names.includes(name)) names.push(name);
    }

    if (names.length === 0) {
        fail("not-configured", `a column list cannot be empty; the ones there are: ${COLUMN_NAMES.join(", ")}`, {});
    }
    return names;
}

/** True when `name` is a column. */
export function isColumn(name: string): name is ColumnName {
    return Object.hasOwn(COLUMNS, name);
}
