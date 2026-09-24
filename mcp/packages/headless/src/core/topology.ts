// Who runs the MCP server, and therefore every address in the system.
//
// One function decides them all. The URI injected into the page, the URL the
// agent connects to, and the pattern that recognises the plugin's socket are
// three views of one decision, and they have disagreed in production: the
// readiness check matched the default WebSocket port instead of the injected
// one and reported a healthy lane as a 90-second timeout (invariant 11).
// Deriving all three from a single `Wiring` makes that unrepresentable.

import { fail } from "./errors.ts";
import type { AccountRef } from "./target.ts";
import { normalizeOrigin } from "./target.ts";
import type { PortPair } from "./ports.ts";

/**
 * A lane's two port pairs, which are the same pair in most deployments.
 *
 * They differ when the container's ports are published somewhere else -- a
 * local range that collides with something already on the host, say. The
 * distinction is not cosmetic: `local` is what the browser dials and what the
 * agent connects to, `upstream` is what the server inside the container binds,
 * and wiring a lane with the wrong one of them produces a server nothing can
 * reach and a readiness check that waits for a socket that will never open.
 */
export interface LanePorts {
    readonly local: PortPair;
    readonly upstream: PortPair;
}

/**
 * Where a lane's MCP server comes from.
 *
 * All four are wired here even though v1 implements only `exec` (SPEC 3b).
 * Wiring is pure and cheap, and keeping the full union means the map is
 * executable rather than prose: a lane in an unbuilt mode fails with a reason,
 * not with a missing branch.
 */
export type Mode =
    /** The instance's own multi-user server, routed by the account's token. */
    | "builtin"
    /** A single-user server started inside the stock container we already run. */
    | "exec"
    /** A single-user server built from this repo, running on the host. */
    | "local"
    /** A single-user server from the published image, in a container of ours. */
    | "image";

/** Every address a lane needs, derived together so they cannot disagree. */
export interface Wiring {
    readonly mode: Mode;
    /** What to set `window.penpotMcpServerURI` to, or null to leave Penpot's default. */
    readonly injectWsUri: string | null;
    /** What an agent puts in its MCP client configuration. */
    readonly clientUrl: string;
    /** Whether the launcher has to start a server for this lane. */
    readonly needsServer: boolean;
    /** Whether the lane routes by the account's MCP token, and so contends for its one slot. */
    readonly needsUserToken: boolean;
    /** Environment for the server process. Empty when `needsServer` is false. */
    readonly serverEnv: Readonly<Record<string, string>>;
}

/** The common case: the container's ports are published as themselves. */
export function samePorts(pair: PortPair): LanePorts {
    return { local: pair, upstream: pair };
}

/**
 * Builds the wiring for one lane.
 *
 * `ports` is required for every mode that runs its own server and ignored for
 * `builtin`; `userToken` is the reverse. Passing the wrong combination throws
 * rather than producing a half-addressed lane.
 */
export function wire(mode: Mode, account: AccountRef, ports: LanePorts | null, userToken?: string): Wiring {
    const origin = normalizeOrigin(account.origin);

    if (mode === "builtin") {
        if (userToken === undefined || userToken === "") {
            fail("not-configured", `${mode} routes by the account's MCP token, and ${account.name} has none`, {
                account: account.name,
                mode,
            });
        }
        return {
            mode,
            injectWsUri: null,
            clientUrl: `${origin}/mcp/stream?userToken=${encodeURIComponent(userToken)}`,
            needsServer: false,
            needsUserToken: true,
            serverEnv: {},
        };
    }

    if (ports === null) {
        fail("not-configured", `${mode} runs its own server and needs a port pair`, { mode });
    }

    // localhost, never a LAN address (invariant 7). The browser runs where the
    // launcher runs, and a hardened session cookie is Secure: only a
    // trustworthy origin keeps it, so a lane addressed by IP loses its session
    // while the login appears to have worked.
    return {
        mode,
        // The browser's half is local: it runs where the launcher runs.
        injectWsUri: `ws://localhost:${ports.local.ws}`,
        clientUrl: `http://127.0.0.1:${ports.local.http}/mcp`,
        needsServer: true,
        needsUserToken: false,
        // The server's half is upstream: it binds inside the container.
        serverEnv: {
            PENPOT_MCP_SERVER_PORT: String(ports.upstream.http),
            PENPOT_MCP_WEBSOCKET_PORT: String(ports.upstream.ws),
            // Invariant 9. The 2.17 bundle builds its ReplServer unconditionally
            // and has no switch, but it does read this port -- so aim it at a
            // port that is already bound and the listen fails, silently and
            // harmlessly. The server's own HTTP port is bound first, so it is
            // always the right collision to pick.
            PENPOT_MCP_REPL_PORT: String(ports.upstream.http),
        },
    };
}

/**
 * True when `url` is the socket the MCP plugin dials under this wiring.
 *
 * The only trustworthy readiness signal a lane has (invariant 10), so it must
 * not match on the default port when a different one was injected
 * (invariant 11).
 */
export function isPluginSocket(url: string, wiring: Wiring): boolean {
    if (wiring.injectWsUri === null) return pathOf(url) === "/mcp/ws";

    const wanted = portOf(wiring.injectWsUri);
    return wanted !== null && portOf(url) === wanted;
}

/** The path of a URL, or the whole string when it does not parse. */
function pathOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

/** The explicit port of a URL, or null when it has none or does not parse. */
function portOf(url: string): string | null {
    try {
        const port = new URL(url).port;
        return port === "" ? null : port;
    } catch {
        return null;
    }
}
