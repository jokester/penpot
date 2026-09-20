// Reading which ports are listening inside a container, from /proc.
//
// Separate from the backends, and pure, because both of them ask the same
// question of the same two files and the parser is where the bug lived.
//
// Why /proc rather than a tool: the stock penpot-mcp image has no ss, no
// netstat and no lsof, and its awk has no strtonum -- so the shell script this
// replaces printed hex and converted it outside. Node can read the files
// whole and do the arithmetic here, which is both simpler and testable.

import { fail } from "../core/errors.ts";

/** The `st` column's value for a socket in LISTEN. */
const LISTEN = "0A";

/**
 * Ports listening inside the container, from both /proc/net files, ascending.
 *
 * Both files, always. The MCP server binds its HTTP port on IPv4 and its
 * WebSocket port on IPv6, so a reader that takes only /proc/net/tcp reports
 * every WebSocket port as free -- and the allocator then hands out a pair whose
 * second half is already serving, producing two servers that each half work
 * (invariant 4). The captured fixtures beside this file are a live container
 * showing exactly that: 4401 appears only in tcp, 4402 only in tcp6.
 *
 * Bind addresses are not filtered. A port held by anything at all is a port a
 * lane cannot have, including Docker's embedded DNS on 127.0.0.11, and
 * deciding which ports are *interesting* is the range's job, not this one's.
 */
export function parseListeningPorts(tcp: string, tcp6: string): number[] {
    const ports = new Set<number>();
    for (const [name, text] of [
        ["/proc/net/tcp", tcp],
        ["/proc/net/tcp6", tcp6],
    ] as const) {
        for (const port of portsIn(name, text)) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
}

/** The listening ports of one /proc/net file. */
function portsIn(name: string, text: string): number[] {
    const out: number[] = [];

    for (const line of text.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length === 1 && fields[0] === "") continue;
        if (fields[0] === "sl") continue; // the header

        // sl, local_address, rem_address, st, … -- a row shorter than that is
        // not a row we understand, and guessing at a truncated probe means
        // allocating over a live server.
        const local = fields[1];
        const state = fields[3];
        if (local === undefined || state === undefined) {
            fail("probe-failed", `${name} has a row with ${fields.length} columns: ${line.trim()}`, {
                file: name,
                columns: fields.length,
            });
        }
        if (state !== LISTEN) continue;

        out.push(portOf(name, local));
    }
    return out;
}

/** The port half of a `<hex address>:<hex port>` column. */
function portOf(name: string, local: string): number {
    const colon = local.lastIndexOf(":");
    const hex = colon === -1 ? "" : local.slice(colon + 1);

    if (!/^[0-9A-Fa-f]{1,4}$/.test(hex)) {
        fail("probe-failed", `${name} has an unreadable local address: ${local}`, { file: name, local });
    }
    return Number.parseInt(hex, 16);
}
