// Wreckage from a previous run: found, reported, never adopted.
//
// A SIGKILL, a crashed terminal or a laptop lid ends a process without running
// any finally, so the launcher can start next to servers and browsers nobody
// owns. This module is deliberately not part of the supervisor, and a Leftover
// is deliberately not a LaneRecord: keeping the types apart is what stops
// "adopt it" from ever looking like a one-line change.
//
// Adoption was considered and dropped (SPEC 14.2). It bought detachment nobody
// wanted and cost a second port range, a tab-verification step and an "is this
// browser ours" problem that has no good answer.

import type { PortRange } from "../core/ports.ts";
import type { AccountRef } from "../core/target.ts";
import type { ExecBackend } from "../exec/backend.ts";

/** Something running that no live lane owns. */
export interface Leftover {
    readonly kind: "server" | "browser";
    /** In-container for a server, on this host for a browser. */
    readonly pid: number;
    readonly port?: number;
    readonly detail: string;
}

/** A process on this host, as `reap` and the scan need to see it. */
export interface HostProcesses {
    list(): Promise<readonly { readonly pid: number; readonly command: string }[]>;
    kill(pid: number): Promise<void>;
}

/** What a scan needs to know about. */
export interface ScanDeps {
    readonly backend?: ExecBackend;
    readonly portRange: PortRange;
    readonly accounts: Iterable<AccountRef>;
    readonly host: HostProcesses;
}

/**
 * Lists every in-container process that has a PENPOT_MCP_SERVER_PORT, as text.
 *
 * Reads /proc directly because the stock image has no ps worth using. The
 * port comes from the environment rather than from a listening socket, so a
 * server that has died halfway -- started, not yet listening -- is still found.
 */
const SERVER_SCAN = `for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ -r "$d/environ" ] || continue
  port=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^PENPOT_MCP_SERVER_PORT=//p')
  [ -n "$port" ] || continue
  echo "$pid $port $(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)"
done`;

/**
 * Finds what a previous run left behind, in the container and on this host.
 *
 * Never throws for want of a backend or a readable /proc: a launcher that
 * cannot check for wreckage should still start, and say it could not check.
 */
export async function scan(deps: ScanDeps): Promise<Leftover[]> {
    const found: Leftover[] = [];

    if (deps.backend !== undefined) {
        const result = await deps.backend.run(["sh", "-c", SERVER_SCAN], AbortSignal.timeout(15_000)).catch(() => null);
        if (result !== null && result.code === 0) found.push(...parseServers(result.stdout, deps.portRange));
    }

    const processes = await deps.host.list().catch(() => []);
    found.push(...parseBrowsers(processes, deps.accounts));

    return found;
}

/**
 * Reads the scan script's output into leftovers.
 *
 * Only ports inside the deployment's range count. That excludes the image's own
 * default server, which is pid 1, sets no port variable and must never be
 * offered for reaping -- killing it would take the container down.
 */
export function parseServers(stdout: string, range: PortRange): Leftover[] {
    const out: Leftover[] = [];

    for (const line of stdout.split("\n")) {
        const [rawPid, rawPort, ...rest] = line.trim().split(/\s+/);
        const pid = Number(rawPid);
        const port = Number(rawPort);
        if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
        if (port < range.lo || port > range.hi) continue;

        out.push({ kind: "server", pid, port, detail: rest.join(" ").trim() || "node" });
    }
    return out;
}

/**
 * Finds host browsers holding one of our profile directories.
 *
 * The profile directory is the only honest marker. A chromium started by
 * anything else is somebody's browser, and the operator gets to decide --
 * which is why ignoring a leftover is allowed.
 */
export function parseBrowsers(
    processes: readonly { readonly pid: number; readonly command: string }[],
    accounts: Iterable<AccountRef>
): Leftover[] {
    const profiles = [...accounts].map((account) => account.profileDir).filter((dir) => dir !== "");
    if (profiles.length === 0) return [];

    const out: Leftover[] = [];
    for (const { pid, command } of processes) {
        const profile = profiles.find((dir) => command.includes(dir));
        if (profile === undefined) continue;

        out.push({ kind: "browser", pid, detail: profile });
    }
    return out;
}

/** Ends one leftover, by the only handle that can end it. */
export async function reap(leftover: Leftover, deps: { backend?: ExecBackend; host: HostProcesses }): Promise<void> {
    if (leftover.kind === "server") {
        // An in-container pid means nothing to the host; only the backend can
        // reach it (invariant 6).
        await deps.backend?.kill(leftover.pid);
        return;
    }
    await deps.host.kill(leftover.pid);
}

/** Renders a leftover the way the TUI lists it. */
export function describe(leftover: Leftover): string {
    const where = leftover.port === undefined ? "" : `:${leftover.port}  `;
    return `${where}${leftover.kind}  pid ${leftover.pid}  ${leftover.detail}`;
}
