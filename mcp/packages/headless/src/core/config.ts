// The three layers of configuration, as pure functions over text.
//
// Reading files is the caller's job. `ConfigIo` is a two-method port rather
// than an `fs` import so the layering rules -- which file wins, what a missing
// one means, how an account file is spelled -- stay here and stay testable
// without a directory of fixtures. `main.ts` binds the port to `node:fs` and
// is the only place that does.

import { DEFAULT_COLUMNS, parseColumns, type ColumnName } from "./columns.ts";
import { fail } from "./errors.ts";
import type { PortRange } from "./ports.ts";
import { parseWorkspaceUrl, type AccountRef, type DocumentRef } from "./target.ts";

/** Reads the few files configuration lives in. Bound to `node:fs` in `main.ts`. */
export interface ConfigIo {
    /** File contents, or null when it does not exist. */
    read(path: string): string | null;
    /** Entry names in a directory, empty when it does not exist. */
    list(dir: string): readonly string[];
}

/** How to reach the container the MCP servers run in, and what is reachable. */
export interface Deployment {
    readonly backend: "compose" | "kubectl";
    /** How an in-container port becomes reachable locally. Default `none`: verify only. */
    readonly exposure: "none" | "port-forward";
    readonly portRange: PortRange;
    /** The directory the deployment file came from; relative paths resolve against it. */
    readonly configDir: string;
    readonly compose?: {
        readonly projectDir: string;
        readonly service: string;
        /** Where `manage.py` lives. Default `penpot-backend`; only provisioning asks. */
        readonly adminService?: string;
    };
    readonly kubectl?: {
        readonly context?: string;
        readonly namespace: string;
        readonly selector: string;
    };
}

/** An account file's contents: an address, and the secrets that reach it. */
export interface Account extends AccountRef {
    readonly email?: string;
    readonly password?: string;
    /** The account's MCP token, used only by `builtin` lanes. */
    readonly mcpToken?: string;
    /** The document the account was provisioned with, when it has one. */
    readonly defaultDocument?: DocumentRef;
}

/** How the list is laid out. */
export interface TuiSettings {
    readonly columns: readonly ColumnName[];
    /** The line under the list carrying what the columns truncate. */
    readonly statusBar: boolean;
}

/** Everything the launcher knows before any flag is read. */
export interface Settings {
    /** Absent when there is no deployment file: `builtin` still works, `exec` does not. */
    readonly deployment?: Deployment;
    readonly accounts: ReadonlyMap<string, Account>;
    readonly tui: TuiSettings;
}

const DEPLOYMENT_FILE = "deployment.json";
const TUI_FILE = "tui.json";
const ACCOUNTS_DIR = "accounts";

/**
 * Reads the deployment and every account under `dir`.
 *
 * A missing deployment file is not an error. With no deployment the launcher
 * still runs `builtin` lanes, which is the mode that works against cloud and
 * against whatever replaces the compose file -- so absence means "not
 * available" rather than "misconfigured", and only a lane that needs it says
 * so.
 */
export function load(dir: string, env: NodeJS.ProcessEnv, io: ConfigIo): Settings {
    const json = io.read(join(dir, DEPLOYMENT_FILE));
    const accountsDir = join(dir, ACCOUNTS_DIR);

    const accounts = new Map<string, Account>();
    for (const entry of io.list(accountsDir)) {
        if (!entry.endsWith(".env")) continue;
        const text = io.read(join(accountsDir, entry));
        if (text === null) continue;
        const name = entry.slice(0, -".env".length);
        accounts.set(name, parseAccount(name, text, env));
    }

    const tui = parseTui(io.read(join(dir, TUI_FILE)));
    return json === null ? { accounts, tui } : { deployment: parseDeployment(json, dir), accounts, tui };
}

/**
 * Reads the list's layout, or supplies the default.
 *
 * A missing file is the normal case, so it is not an error; a file that is
 * there and wrong is, because someone wrote it meaning something.
 */
export function parseTui(json: string | null): TuiSettings {
    if (json === null || json.trim() === "") return { columns: DEFAULT_COLUMNS, statusBar: true };

    const raw = parseJson(json, TUI_FILE);
    const columns = raw.columns === undefined ? DEFAULT_COLUMNS : parseColumns(raw.columns as readonly unknown[]);

    if (raw.statusBar !== undefined && typeof raw.statusBar !== "boolean") {
        fail("not-configured", `${TUI_FILE} statusBar must be true or false`, { field: "statusBar" });
    }
    return { columns, statusBar: raw.statusBar ?? true };
}

/**
 * Maps the flat JSON of SPEC section 10 onto the nested `Deployment`.
 *
 * The file is flat because a person writes it; the type is nested because the
 * backends are alternatives and only one set of fields applies at a time.
 */
export function parseDeployment(json: string, configDir: string): Deployment {
    const raw = parseJson(json, DEPLOYMENT_FILE);
    const backend = str(raw, "backend");

    const exposure = raw.exposure === undefined ? "none" : str(raw, "exposure");
    if (exposure !== "none" && exposure !== "port-forward") {
        fail("not-configured", `exposure must be "none" or "port-forward", not ${JSON.stringify(exposure)}`, {
            exposure,
        });
    }

    // kubectl's key is localPortRange: under a cluster the range is about what
    // is reachable from here, not about what the pod publishes.
    const portRange = range(raw.portRange ?? raw.localPortRange);
    const common = { exposure, portRange, configDir } as const;

    if (backend === "compose") {
        const adminService = raw.adminService === undefined ? undefined : str(raw, "adminService");
        return {
            backend,
            ...common,
            compose: {
                projectDir: str(raw, "projectDir"),
                service: str(raw, "service"),
                ...(adminService === undefined ? {} : { adminService }),
            },
        };
    }
    if (backend === "kubectl") {
        const context = raw.context === undefined ? undefined : str(raw, "context");
        return {
            backend,
            ...common,
            kubectl: {
                namespace: str(raw, "namespace"),
                selector: str(raw, "selector"),
                ...(context ? { context } : {}),
            },
        };
    }
    fail("not-configured", `unknown backend ${JSON.stringify(backend)}; expected "compose" or "kubectl"`, { backend });
}

/**
 * Reads one account file, in the shape `provision-worker` writes.
 *
 * The shape is not ours to choose, so nothing here rejects an unknown key: the
 * file is sourced by a shell script today and may carry more than we read.
 */
export function parseAccount(name: string, text: string, env: NodeJS.ProcessEnv): Account {
    const vars = parseEnvFile(text, env);

    const origin = vars.get("PENPOT_ORIGIN");
    if (origin === undefined || origin === "") {
        fail("not-configured", `account ${name} has no PENPOT_ORIGIN`, { account: name });
    }

    const home = env.HOME ?? "";
    const account: Account = {
        name,
        origin,
        profileDir: vars.get("PENPOT_PROFILE_DIR") || `${home}/.cache/penpot-headless/profile-${name}`,
        ...optional("email", vars.get("PENPOT_EMAIL")),
        ...optional("password", vars.get("PENPOT_PASSWORD")),
        ...optional("mcpToken", tokenOf(vars.get("PENPOT_MCP_URL"))),
    };

    const doc = defaultDocument(vars.get("PENPOT_FILE_URL"));
    return doc === undefined ? account : { ...account, defaultDocument: doc };
}

/**
 * Parses the `KEY=value` lines a shell would source, expanding `$VAR` as it goes.
 *
 * Only the forms `provision-worker` writes and a person hand-edits: comments,
 * blank lines, an optional `export`, and single or double quotes. A
 * single-quoted value is literal, as in a shell.
 */
export function parseEnvFile(text: string, env: NodeJS.ProcessEnv): Map<string, string> {
    const out = new Map<string, string>();

    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
        const eq = body.indexOf("=");
        if (eq <= 0) continue;

        const key = body.slice(0, eq).trim();
        const rest = body.slice(eq + 1).trim();

        if (rest.startsWith("'")) {
            const end = rest.indexOf("'", 1);
            out.set(key, end === -1 ? rest.slice(1) : rest.slice(1, end));
        } else if (rest.startsWith('"')) {
            const end = rest.indexOf('"', 1);
            out.set(key, expand(end === -1 ? rest.slice(1) : rest.slice(1, end), env));
        } else {
            // A bare value ends at whitespace, so a trailing comment is dropped
            // the way a shell drops it.
            out.set(key, expand(rest.split(/\s+/)[0] ?? "", env));
        }
    }
    return out;
}

/** Substitutes `$VAR` and `${VAR}`, leaving an unset name as the empty string. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) =>
        (env[braced ?? bare] ?? "").toString()
    );
}

/** The `userToken` of an MCP stream URL, or undefined when there is none. */
function tokenOf(url: string | undefined): string | undefined {
    if (url === undefined || url === "") return undefined;
    const question = url.indexOf("?");
    if (question === -1) return undefined;
    return new URLSearchParams(url.slice(question + 1)).get("userToken") ?? undefined;
}

/**
 * The document an account file names, or undefined when it names none.
 *
 * Tolerant on purpose: an account provisioned without a scratch file has an
 * empty `file-id` in its URL, and that is a normal state rather than a broken
 * file. A lane that needs a document is told which one at the call.
 */
function defaultDocument(url: string | undefined): DocumentRef | undefined {
    if (url === undefined || url === "") return undefined;
    try {
        return parseWorkspaceUrl(url);
    } catch {
        return undefined;
    }
}

/** Spreads a key only when there is a value, so optional fields stay absent. */
function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
    return value === undefined || value === "" ? {} : ({ [key]: value } as Record<K, string>);
}

/** Joins two path segments without dragging in `node:path`. */
function join(dir: string, entry: string): string {
    return dir.endsWith("/") ? `${dir}${entry}` : `${dir}/${entry}`;
}

function parseJson(json: string, file: string): Record<string, unknown> {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (err) {
        fail("not-configured", `${file} is not valid JSON: ${(err as Error).message}`, {});
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        fail("not-configured", `${file} must hold a JSON object`, {});
    }
    return raw as Record<string, unknown>;
}

function str(raw: Record<string, unknown>, key: string): string {
    const value = raw[key];
    if (typeof value !== "string" || value === "") {
        fail("not-configured", `${DEPLOYMENT_FILE} needs a non-empty ${key}`, { field: key });
    }
    return value;
}

function range(value: unknown): PortRange {
    if (!Array.isArray(value) || value.length !== 2) {
        fail("not-configured", `${DEPLOYMENT_FILE} needs a port range as [lo, hi]`, { field: "portRange" });
    }
    const [lo, hi] = value;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        fail("not-configured", `${DEPLOYMENT_FILE} port range must hold two integers`, { field: "portRange" });
    }
    return { lo: lo as number, hi: hi as number };
}
