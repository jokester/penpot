// The one file an operator writes by hand.
//
// `deployment.json` grew a field at a time and says nothing about the worker
// accounts, the façade's address, or the browser -- so those live in three
// other places and nothing reads as a description of the deployment. This is
// that description: one YAML file, and the flags still win over it.
//
// Two rules give it its shape.
//
// **No secrets.** A worker's password and MCP token stay in
// `accounts/<name>.env`, mode 600, written by provisioning and never by a
// person. This file names the workers; it does not hold what they know. That
// is what makes it safe to commit, diff and paste into an issue.
//
// **Unknown keys are refused.** A hand-written file's worst failure is a
// mistyped key that is silently ignored, leaving a setting that reads as
// present and is not. Everything here is either understood or named in an
// error.

import { parse as parseYaml } from "yaml";

import { fail } from "./errors.ts";
import type { PortRange } from "./ports.ts";

/** A worker account the pool may draw on. */
export interface WorkerUser {
    /** The account file's name under `accounts/`, and what `--account` takes. */
    readonly name: string;
    readonly email: string;
    /** The display name in Penpot. Defaults to `name`. */
    readonly fullName?: string;
}

/** Where a lane's MCP server runs, and how its ports are reached. */
export interface McpBackendConf {
    readonly type: "kubectl" | "docker-compose";
    /** Where a lane's ports appear, to the browser and to the agent. */
    readonly hostname: string;
    readonly portRange: PortRange;
    readonly upstreamPortRange?: PortRange;
    readonly exposure: "none" | "port-forward";
    readonly kubectl?: {
        readonly namespace: string;
        readonly selector: string;
        readonly adminSelector?: string;
        readonly context?: string;
        readonly kubeconfig?: string;
    };
    readonly dockerCompose?: {
        readonly projectDir: string;
        readonly service: string;
        readonly adminService?: string;
    };
}

/** The whole file. */
export interface Conf {
    /** The Penpot instance: what the browser loads and provisioning talks to. */
    readonly penpotUrl?: string;
    readonly workerUsers: readonly WorkerUser[];
    readonly facade?: { readonly host?: string; readonly port?: number };
    readonly mcpBackend?: McpBackendConf;
    readonly browser: { readonly type: "local" | "container" };
}

export const CONF_FILE = "conf.yaml";

const TOP_KEYS = ["penpot", "workerUsers", "mcpFacade", "mcpBackend", "browserBackend"] as const;

/**
 * Reads the file, or says exactly what is wrong with it.
 *
 * Every refusal names the path it was at -- `mcpBackend.portRange`, not "the
 * port range" -- because the reader is looking at a file and needs to know
 * which line to change.
 */
export function parseConf(text: string, file = CONF_FILE): Conf {
    let raw: unknown;
    try {
        raw = parseYaml(text);
    } catch (err) {
        fail("not-configured", `${file} is not valid YAML: ${(err as Error).message.split("\n")[0]}`, { file });
    }
    if (raw === null || raw === undefined) return { workerUsers: [], browser: { type: "local" } };

    const top = object(raw, file, file);
    known(top, TOP_KEYS, file);

    const penpot = top.penpot === undefined ? undefined : object(top.penpot, "penpot", file);
    if (penpot !== undefined) known(penpot, ["url"] as const, file);

    const facade = top.mcpFacade === undefined ? undefined : object(top.mcpFacade, "mcpFacade", file);
    if (facade !== undefined) known(facade, ["host", "port"] as const, file);

    const browser = top.browserBackend === undefined ? undefined : object(top.browserBackend, "browserBackend", file);
    if (browser !== undefined) known(browser, ["type"] as const, file);
    const browserType = browser?.type === undefined ? "local" : str(browser, "type", "browserBackend.type", file);
    if (browserType !== "local" && browserType !== "container") {
        fail("not-configured", `${file}: browserBackend.type must be local or container, not ${browserType}`, {
            file,
        });
    }
    if (browserType === "container") {
        fail("not-configured", `${file}: browserBackend.type container is documented but not built (SPEC 14.3)`, {
            file,
        });
    }

    const penpotUrl = penpot?.url === undefined ? undefined : str(penpot, "url", "penpot.url", file);
    const port = facade?.port === undefined ? undefined : int(facade.port, "mcpFacade.port", file);

    return {
        ...(penpotUrl === undefined ? {} : { penpotUrl }),
        workerUsers: workers(top.workerUsers, file),
        ...(facade === undefined
            ? {}
            : {
                  facade: {
                      ...(facade.host === undefined ? {} : { host: str(facade, "host", "mcpFacade.host", file) }),
                      ...(port === undefined ? {} : { port }),
                  },
              }),
        ...(top.mcpBackend === undefined ? {} : { mcpBackend: backend(top.mcpBackend, file) }),
        browser: { type: browserType },
    };
}

/**
 * The worker pool, in the order it was written.
 *
 * Order matters a little: the first worker with an MCP token is the one whose
 * endpoint answers the document-free tools, so the file's order is the
 * operator's preference rather than a map's iteration order.
 */
function workers(raw: unknown, file: string): WorkerUser[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        fail("not-configured", `${file}: workerUsers must be a list`, { file });
    }

    const seen = new Set<string>();
    return raw.map((entry, index) => {
        const where = `workerUsers[${index}]`;
        const row = object(entry, where, file);
        known(row, ["name", "email", "fullName"] as const, file, where);

        const email = str(row, "email", `${where}.email`, file);
        // The local part is the obvious default and the one provisioning used
        // before this file existed, so an account file written then still
        // matches the worker named here.
        const name = row.name === undefined ? (email.split("@")[0] as string) : str(row, "name", `${where}.name`, file);

        if (seen.has(name)) {
            fail("not-configured", `${file}: two workers are both named ${name}; they would share an account file`, {
                file,
                name,
            });
        }
        seen.add(name);

        return {
            name,
            email,
            ...(row.fullName === undefined ? {} : { fullName: str(row, "fullName", `${where}.fullName`, file) }),
        };
    });
}

function backend(raw: unknown, file: string): McpBackendConf {
    const row = object(raw, "mcpBackend", file);
    known(
        row,
        ["type", "hostname", "portRange", "upstreamPortRange", "exposure", "kubectl", "dockerCompose"] as const,
        file,
        "mcpBackend"
    );

    const type = str(row, "type", "mcpBackend.type", file);
    if (type !== "kubectl" && type !== "docker-compose") {
        fail("not-configured", `${file}: mcpBackend.type must be kubectl or docker-compose, not ${type}`, { file });
    }

    const exposure = row.exposure === undefined ? "none" : str(row, "exposure", "mcpBackend.exposure", file);
    if (exposure !== "none" && exposure !== "port-forward") {
        fail("not-configured", `${file}: mcpBackend.exposure must be none or port-forward, not ${exposure}`, { file });
    }

    const common = {
        type,
        // Loopback, and not as a default chosen for tidiness: a hardened
        // session cookie is Secure, so the browser keeps it for localhost and
        // drops it silently for a LAN address (invariant 7).
        hostname: row.hostname === undefined ? "127.0.0.1" : str(row, "hostname", "mcpBackend.hostname", file),
        portRange: range(row.portRange, "mcpBackend.portRange", file),
        exposure,
        ...(row.upstreamPortRange === undefined
            ? {}
            : { upstreamPortRange: range(row.upstreamPortRange, "mcpBackend.upstreamPortRange", file) }),
    } as const;

    if (type === "kubectl") {
        const k = object(row.kubectl, "mcpBackend.kubectl", file);
        known(
            k,
            ["namespace", "selector", "adminSelector", "context", "kubeconfig"] as const,
            file,
            "mcpBackend.kubectl"
        );
        return {
            ...common,
            kubectl: {
                namespace: str(k, "namespace", "mcpBackend.kubectl.namespace", file),
                selector: str(k, "selector", "mcpBackend.kubectl.selector", file),
                ...optional(k, "adminSelector", "mcpBackend.kubectl.adminSelector", file),
                ...optional(k, "context", "mcpBackend.kubectl.context", file),
                ...optional(k, "kubeconfig", "mcpBackend.kubectl.kubeconfig", file),
            },
        };
    }

    const c = object(row.dockerCompose, "mcpBackend.dockerCompose", file);
    known(c, ["projectDir", "service", "adminService"] as const, file, "mcpBackend.dockerCompose");
    return {
        ...common,
        dockerCompose: {
            projectDir: str(c, "projectDir", "mcpBackend.dockerCompose.projectDir", file),
            service: str(c, "service", "mcpBackend.dockerCompose.service", file),
            ...optional(c, "adminService", "mcpBackend.dockerCompose.adminService", file),
        },
    };
}

/** `4601-4608`, inclusive at both ends. */
function range(raw: unknown, where: string, file: string): PortRange {
    if (Array.isArray(raw)) {
        fail("not-configured", `${file}: ${where} is written lo-hi, as in 4601-4608, not as a list`, { file, where });
    }
    if (typeof raw !== "string") {
        fail("not-configured", `${file}: ${where} is required, written lo-hi as in 4601-4608`, { file, where });
    }

    const match = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
        fail("not-configured", `${file}: ${where} must look like 4601-4608, not ${JSON.stringify(raw)}`, {
            file,
            where,
        });
    }

    const lo = Number(match[1]);
    const hi = Number(match[2]);
    if (lo < 1 || hi > 65535 || hi < lo) {
        fail("not-configured", `${file}: ${where} ${raw} is not a port range`, { file, where });
    }
    return { lo, hi };
}

function known<K extends string>(row: Record<string, unknown>, keys: readonly K[], file: string, where?: string): void {
    for (const key of Object.keys(row)) {
        if ((keys as readonly string[]).includes(key)) continue;
        const at = where === undefined ? "" : ` under ${where}`;
        fail("not-configured", `${file}: unknown key ${key}${at}; expected one of ${keys.join(", ")}`, { file, key });
    }
}

function object(raw: unknown, where: string, file: string): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        fail("not-configured", `${file}: ${where} must be a block of keys`, { file, where });
    }
    return raw as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, where: string, file: string): string {
    const value = row[key];
    if (typeof value !== "string" || value.trim() === "") {
        fail("not-configured", `${file}: ${where} must be a non-empty string`, { file, where });
    }
    return value.trim();
}

function int(raw: unknown, where: string, file: string): number {
    if (!Number.isInteger(raw)) {
        fail("not-configured", `${file}: ${where} must be a whole number`, { file, where });
    }
    return raw as number;
}

function optional<K extends string>(
    row: Record<string, unknown>,
    key: K,
    where: string,
    file: string
): Partial<Record<K, string>> {
    return row[key] === undefined ? {} : ({ [key]: str(row, key, where, file) } as Record<K, string>);
}
