// The RPC commands only provisioning is allowed to send.
//
// Separate from `PenpotApi` on purpose. That interface is what the TUI holds,
// and it documents its own omission: calling `create-access-token` with type
// `mcp` deletes the account's existing token, which once broke MCP in a real
// person's open Penpot tab. Keeping the capability in a module nothing else
// imports is a cheaper guarantee than remembering not to call it.
//
// Both modules post through `rpcCaller`, so kebab-case parameters, the
// by-hand cookie and what an HTTP failure becomes are still decided once.

import { fail } from "../core/errors.ts";
import { rpcCaller, type RpcCall, type RpcFetch, type Session } from "../penpot/rpc.ts";

/** Who we logged in as, and the two ids a fresh account is given. */
export interface Profile {
    readonly id: string;
    readonly defaultTeamId: string;
    readonly defaultProjectId: string;
}

/** What accepting an invitation did. */
export type Joined =
    | { readonly joined: true; readonly teamId: string; readonly role: string }
    /** Spent, expired, or already accepted -- normal when re-provisioning. */
    | { readonly joined: false };

/** The commands provisioning sends and nothing else may. */
export interface ProvisioningApi {
    /** Logs in and reports the profile, which a plain session does not carry. */
    login(origin: string, email: string, password: string): Promise<{ session: Session; profile: Profile }>;
    acceptInvitation(origin: string, session: Session, token: string): Promise<Joined>;
    /** Mints an MCP token, **deleting the account's existing one**. */
    createMcpToken(origin: string, session: Session): Promise<string>;
    /** Turns MCP on for the account, and clears the first-run screens. */
    enableMcp(origin: string, session: Session): Promise<void>;
    createFile(origin: string, session: Session, projectId: string, name: string): Promise<string>;
}

/** Finds the token inside an invitation link, or the token on its own. */
const TOKEN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,}/;

export function provisioningApi(doFetch?: RpcFetch, call: RpcCall = rpcCaller(doFetch)): ProvisioningApi {
    return {
        async login(origin, email, password) {
            const { body, setCookie } = await call(origin, "login-with-password", { email, password });
            const match = /(auth-token=[^;]+)/.exec(setCookie ?? "");
            if (match?.[1] === undefined) {
                fail("unreachable", `login as ${email} returned no auth-token cookie`, { email });
            }

            const row = object(body, "login-with-password");
            return {
                session: { cookie: match[1] },
                profile: {
                    id: str(row, "id", "login-with-password"),
                    defaultTeamId: str(row, "defaultTeamId", "login-with-password"),
                    defaultProjectId: str(row, "defaultProjectId", "login-with-password"),
                },
            };
        },

        async acceptInvitation(origin, session, invitation) {
            const token = TOKEN.exec(invitation)?.[0];
            if (token === undefined) {
                fail("not-configured", "no invitation token in that link", {});
            }

            try {
                const row = object((await call(origin, "verify-token", { token }, session)).body, "verify-token");
                return {
                    joined: true,
                    teamId: typeof row.teamId === "string" ? row.teamId : "",
                    role: typeof row.role === "string" ? row.role : "",
                };
            } catch (err) {
                // A worker belongs to as many teams as it was invited to, and
                // re-provisioning is the normal way to add one, so an
                // invitation already spent is not a failure.
                if (spent(err)) return { joined: false };
                throw err;
            }
        },

        async createMcpToken(origin, session) {
            const reply = await call(origin, "create-access-token", { name: "MCP", type: "mcp" }, session);
            const row = object(reply.body, "create-access-token");
            return str(row, "token", "create-access-token");
        },

        async enableMcp(origin, session) {
            await call(
                origin,
                "update-profile-props",
                { props: { mcpEnabled: true, onboardingViewed: true, releaseNotesViewed: "2.17" } },
                session
            );
        },

        async createFile(origin, session, projectId, name) {
            const reply = await call(origin, "create-file", { name, "project-id": projectId }, session);
            const row = object(reply.body, "create-file");
            return str(row, "id", "create-file");
        },
    };
}

/** True when the failure is an invitation that cannot be accepted again. */
function spent(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /HTTP 400/.test(err.message) && /invalid-token|already/.test(err.message);
}

function object(body: unknown, command: string): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        fail("probe-failed", `${command} did not answer with an object`, { command });
    }
    return body as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, command: string): string {
    const value = row[key];
    if (typeof value !== "string" || value === "") {
        fail("probe-failed", `${command} answered without ${key}`, { command, field: key });
    }
    return value;
}
