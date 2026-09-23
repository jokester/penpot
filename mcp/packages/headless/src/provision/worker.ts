// Creating the one kind of Penpot account that has a password.
//
// People sign in through an identity provider; a worker cannot, so it gets a
// password of its own. Keeping worker accounts separate from human ones is what
// bounds the blast radius of a leaked worker credential -- it reaches the teams
// that invited the worker, and nothing else.
//
// Re-running is the supported way to add a team, rotate the MCP token, or
// rewrite a lost account file. That is why so much of this reads what is
// already there before changing it: an existing profile keeps its password, an
// invitation already accepted is not an error, and a token is only replaced
// when someone asks in as many words.

import { parseAccount } from "../core/config.ts";
import type { ConfigIo } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { normalizeOrigin } from "../core/target.ts";
import type { PenpotApi } from "../penpot/rpc.ts";
import type { WorkerAdmin } from "./admin.ts";
import type { ProvisioningApi } from "./api.ts";

/** What to provision. */
export interface WorkerRequest {
    readonly email: string;
    readonly origin: string;
    /** The account file's name under `accounts/`, and the lane's name. */
    readonly account: string;
    /** Display name in Penpot. */
    readonly fullName: string;
    /** Invitation links or bare tokens; one per team the worker should reach. */
    readonly invitations: readonly string[];
    /** Set a new password on a profile that already exists. */
    readonly resetPassword: boolean;
    /** Replace the account's MCP token even though it has one. */
    readonly mintToken: boolean;
    /** A scratch document to create, or "" for none. */
    readonly fileName: string;
}

/** Writes a file only its owner can read, creating parent directories. */
export type WriteSecret = (path: string, contents: string) => Promise<void>;

export interface WorkerDeps {
    readonly admin: WorkerAdmin;
    readonly api: ProvisioningApi;
    /** Reading the account file back, so a re-run keeps the password. */
    readonly io: ConfigIo;
    readonly tokens: Pick<PenpotApi, "readMcpToken">;
    readonly accountsDir: string;
    readonly write: WriteSecret;
    readonly log: (line: string) => void;
    /** Where a fresh password comes from. Overridden in tests. */
    readonly newPassword: () => string;
    /** Read for $MCP_HEADLESS_WORKER_PASSWORD, and nothing else. */
    readonly env: NodeJS.ProcessEnv;
}

/** What provisioning did, for the caller to print. */
export interface WorkerReport {
    readonly path: string;
    readonly profile: "created" | "existing";
    readonly teams: readonly string[];
    readonly token: "minted" | "reused";
    readonly fileId: string;
}

export async function provisionWorker(request: WorkerRequest, deps: WorkerDeps): Promise<WorkerReport> {
    const origin = normalizeOrigin(request.origin);
    const path = `${deps.accountsDir}/${request.account}.env`;
    const known = existing(path, deps);

    const chosen = password(known, deps);
    const state = await deps.admin.createProfile(request.fullName, request.email, chosen.value);

    if (state === "exists") {
        // A generated password cannot log into an account that already has one,
        // and setting a new one is a real change to somebody's account, so it
        // stays behind a flag rather than happening because a re-run needed it.
        if (!request.resetPassword && chosen.source === "generated") {
            fail(
                "not-configured",
                `${request.email} already exists and ${path} does not hold its password. ` +
                    `Pass --reset-password to set a new one, or put the old one in ` +
                    `$MCP_HEADLESS_WORKER_PASSWORD.`,
                { email: request.email }
            );
        }
        if (request.resetPassword) {
            await deps.admin.setPassword(request.email, chosen.value);
            deps.log(`reset the password for ${request.email}`);
        } else {
            deps.log(`${request.email} already exists; keeping the password in ${path}`);
        }
    } else {
        deps.log(`created ${request.email} (${chosen.source} password)`);
    }

    let { session, profile } = await deps.api.login(origin, request.email, chosen.value);

    const teams: string[] = [];
    for (const invitation of request.invitations) {
        const joined = await deps.api.acceptInvitation(origin, session, invitation);
        if (joined.joined) {
            teams.push(joined.teamId);
            deps.log(`joined team ${joined.teamId} as ${joined.role}`);
        } else {
            deps.log("an invitation was already used or has expired; membership left as it is");
        }
    }
    // The claims in the cookie are from before the memberships changed.
    if (request.invitations.length > 0) {
        ({ session, profile } = await deps.api.login(origin, request.email, chosen.value));
    }

    const token = await mcpToken(request, origin, session, deps);
    await deps.api.enableMcp(origin, session);
    deps.log(`MCP enabled, token ${token.how}`);

    let fileId = "";
    if (request.fileName !== "") {
        fileId = await deps.api.createFile(origin, session, profile.defaultProjectId, request.fileName);
        deps.log(`scratch document ${request.fileName} ${fileId}`);
    }

    await deps.write(
        path,
        accountFile({
            origin,
            email: request.email,
            password: chosen.value,
            teamId: profile.defaultTeamId,
            fileId,
            token: token.value,
            account: request.account,
        })
    );
    deps.log(`wrote ${path}`);

    return {
        path,
        profile: state === "exists" ? "existing" : "created",
        teams,
        token: token.how,
        fileId,
    };
}

/**
 * The account's MCP token, minted only when there is nothing to destroy.
 *
 * `create-access-token` with type `mcp` deletes the account's existing token,
 * which breaks MCP in whatever is already using it. A profile we just created
 * has none, so minting is free; for one that already exists the caller has to
 * say so.
 */
async function mcpToken(
    request: WorkerRequest,
    origin: string,
    session: { readonly cookie: string },
    deps: WorkerDeps
): Promise<{ value: string; how: "minted" | "reused" }> {
    if (!request.mintToken) {
        const held = await deps.tokens.readMcpToken(origin, session);
        if (held !== null) return { value: held, how: "reused" };
    }
    return { value: await deps.api.createMcpToken(origin, session), how: "minted" };
}

/** The account file as it already stands, or undefined when there is none. */
function existing(path: string, deps: WorkerDeps): { readonly password?: string } | undefined {
    const text = deps.io.read(path);
    if (text === null) return undefined;
    try {
        return parseAccount("existing", text, {});
    } catch {
        return undefined;
    }
}

/** Which password to use, and where it came from. */
function password(
    known: { readonly password?: string } | undefined,
    deps: WorkerDeps
): { value: string; source: "environment" | "account file" | "generated" } {
    const fromEnv = deps.env.MCP_HEADLESS_WORKER_PASSWORD;
    if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, source: "environment" };
    if (known?.password !== undefined && known.password !== "") {
        return { value: known.password, source: "account file" };
    }
    return { value: deps.newPassword(), source: "generated" };
}

/** The account file, in the shape `parseAccount` reads and a shell can source. */
export function accountFile(fields: {
    origin: string;
    email: string;
    password: string;
    teamId: string;
    fileId: string;
    token: string;
    account: string;
}): string {
    return [
        "# Written by mcp-headless provision-worker-user.",
        "# Holds a password and an MCP token; keep it mode 600.",
        `PENPOT_ORIGIN="${fields.origin}"`,
        `PENPOT_EMAIL="${fields.email}"`,
        `PENPOT_PASSWORD="${fields.password}"`,
        "# Both ids are required: a workspace URL carrying only a file id",
        "# renders an empty page. The launcher rewrites them per document.",
        `PENPOT_FILE_URL="${fields.origin}/#/workspace?team-id=${fields.teamId}&file-id=${fields.fileId}"`,
        `PENPOT_MCP_URL="${fields.origin}/mcp/stream?userToken=${fields.token}"`,
        `PENPOT_PROFILE_DIR="$HOME/.cache/penpot-headless/profile-${fields.account}"`,
        "",
    ].join("\n");
}
