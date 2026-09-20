// Penpot's RPC, narrowed to what the launcher asks it.
//
// Only four questions: who am I, which teams, which files, and what is this
// account's MCP token. The TUI asks them while building a form; no lane ever
// makes an RPC call.
//
// There is deliberately no createMcpToken. Calling create-access-token with
// type "mcp" deletes the account's existing token and breaks MCP in that user's
// real Penpot tab, which has happened. Provisioning a new worker account is a
// separate command that does it knowingly, once, and the capability is left out
// of this interface so it cannot be reached by accident.

import { fail } from "../core/errors.ts";
import { normalizeOrigin } from "../core/target.ts";

/**
 * An authenticated session, carrying its cookie by hand.
 *
 * Explicit because Node will not send a `Secure` cookie over loopback http,
 * however the jar is configured. A browser does, which is why the same request
 * works there and 401s here -- a difference that looked like an auth bug for an
 * afternoon.
 */
export interface Session {
    readonly cookie: string;
}

export interface Team {
    readonly id: string;
    readonly name: string;
    /** True for the team Penpot created with the account. */
    readonly isDefault: boolean;
}

export interface FileSummary {
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
    readonly modifiedAt: string;
}

/** What the launcher asks Penpot. */
export interface PenpotApi {
    loginWithPassword(origin: string, email: string, password: string): Promise<Session>;
    teams(origin: string, session: Session): Promise<Team[]>;
    recentFiles(origin: string, session: Session, teamId: string): Promise<FileSummary[]>;
    /** The account's MCP token, or null when it has none. Never creates one. */
    readMcpToken(origin: string, session: Session): Promise<string | null>;
}

/** The part of a `Response` this module uses. */
export interface RpcResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
}

/** Satisfied by the global `fetch`, and by a fake in the tests. */
export type RpcFetch = (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<RpcResponse>;

/** Builds the API over whatever performs requests. */
export function penpotApi(doFetch: RpcFetch = globalThis.fetch as unknown as RpcFetch): PenpotApi {
    /** Posts one RPC command and returns its parsed body and any Set-Cookie. */
    async function call(
        origin: string,
        command: string,
        payload: unknown,
        session?: Session
    ): Promise<{ body: unknown; setCookie: string | null }> {
        const url = `${normalizeOrigin(origin)}/api/rpc/command/${command}`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (session !== undefined) headers.Cookie = session.cookie;

        const response = await doFetch(url, { method: "POST", headers, body: JSON.stringify(payload ?? {}) });
        const text = await response.text();

        if (!response.ok) {
            fail(
                "unreachable",
                `${command} failed against ${normalizeOrigin(origin)}: HTTP ${response.status} ${text.slice(0, 200)}`.trim(),
                {
                    command,
                    origin: normalizeOrigin(origin),
                    status: response.status,
                }
            );
        }

        return {
            body: text.trim() === "" ? null : JSON.parse(text),
            setCookie: response.headers.get("set-cookie"),
        };
    }

    return {
        async loginWithPassword(origin, email, password) {
            const { setCookie } = await call(origin, "login-with-password", { email, password });
            const match = /(auth-token=[^;]+)/.exec(setCookie ?? "");

            if (match?.[1] === undefined) {
                fail("unreachable", `login against ${normalizeOrigin(origin)} returned no auth-token cookie`, {
                    origin: normalizeOrigin(origin),
                });
            }
            return { cookie: match[1] };
        },

        async teams(origin, session) {
            const { body } = await call(origin, "get-teams", {}, session);

            return rows(body, "get-teams").map((row) => ({
                id: str(row, "id"),
                name: str(row, "name"),
                isDefault: row["is-default"] === true,
            }));
        },

        async recentFiles(origin, session, teamId) {
            // The team id is not in the rows -- the query selects files, not
            // memberships -- so it comes from the question rather than the
            // answer. A DocumentRef needs both ids (invariant 1).
            const { body } = await call(origin, "get-team-recent-files", { "team-id": teamId }, session);

            return rows(body, "get-team-recent-files").map((row) => ({
                id: str(row, "id"),
                name: str(row, "name"),
                teamId,
                modifiedAt: String(row["modified-at"] ?? ""),
            }));
        },

        async readMcpToken(origin, session) {
            const { body } = await call(origin, "get-access-tokens", {}, session);
            const mcp = rows(body, "get-access-tokens").find((row) => row.type === "mcp");

            // Only mcp rows carry their token; the backend strips it from the
            // others, so an absent token here means there is none to read.
            return typeof mcp?.token === "string" ? mcp.token : null;
        },
    };
}

/** Insists the body is a list of objects, because a silent [] hides a lot. */
function rows(body: unknown, command: string): Record<string, unknown>[] {
    if (!Array.isArray(body)) {
        fail("probe-failed", `${command} did not answer with a list`, { command });
    }
    return body.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

function str(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value !== "string" || value === "") {
        fail("probe-failed", `a row is missing ${key}`, { field: key });
    }
    return value;
}
