// Which ports a lane may use, and why the answer cannot be worked out here.
//
// Pure on purpose. Every function takes the busy list as an argument because
// only the container can produce it: Docker publishes the whole range, so a
// host-side probe reports every port in it as in use whether or not anything
// is behind it, and under kubectl the host cannot see them at all
// (invariant 5). Keeping the arithmetic separate from the probe is what makes
// the arithmetic testable -- both halves of it shipped a bug in bash.

import { fail } from "./errors.ts";

/** The inclusive span of ports a deployment makes reachable. */
export interface PortRange {
    readonly lo: number;
    readonly hi: number;
}

/** The two ports one MCP server binds: streamable HTTP, and the plugin WebSocket. */
export interface PortPair {
    readonly http: number;
    readonly ws: number;
}

/** Renders a range the way the error messages and the TUI both want it. */
export function describeRange(range: PortRange): string {
    return `${range.lo}-${range.hi}`;
}

/** Rejects a range that could never yield a pair, so the failure names the config. */
function assertRange(range: PortRange): void {
    const sane = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
    if (!sane(range.lo) || !sane(range.hi) || range.lo > range.hi) {
        fail("not-configured", `port range ${describeRange(range)} is not a usable range`, {
            lo: range.lo,
            hi: range.hi,
        });
    }
}

/** Ports inside `range` that nothing is serving, ascending. */
export function free(range: PortRange, busy: readonly number[]): number[] {
    assertRange(range);
    const taken = new Set(busy);
    const out: number[] = [];
    for (let p = range.lo; p <= range.hi; p += 1) {
        if (!taken.has(p)) out.push(p);
    }
    return out;
}

/**
 * Lists the pairs a lane could take, in the order `allocate` prefers them.
 *
 * Pairs are adjacent and start on `lo`, stepping by two, so a range holds
 * floor(size / 2) of them and an odd-sized range leaves its last port unusable.
 * That is not an accident to fix: the WebSocket port is conventionally the HTTP
 * port plus one, which is what makes a lane addressable from its HTTP port
 * alone.
 */
function pairs(range: PortRange): PortPair[] {
    const out: PortPair[] = [];
    for (let http = range.lo; http + 1 <= range.hi; http += 2) {
        out.push({ http, ws: http + 1 });
    }
    return out;
}

/**
 * Picks the lowest free pair in `range`.
 *
 * Throws `range-exhausted` rather than returning null: there is nothing a
 * caller can usefully do with a missing port, and the message has to carry the
 * range and what is left of it.
 */
export function allocate(range: PortRange, busy: readonly number[]): PortPair {
    assertRange(range);
    const taken = new Set(busy);
    const pair = pairs(range).find((p) => !taken.has(p.http) && !taken.has(p.ws));

    if (pair === undefined) {
        const remaining = free(range, busy);
        fail("range-exhausted", `no free port pair in ${describeRange(range)}`, {
            range: describeRange(range),
            free: remaining.length === 0 ? "none" : remaining.join(" "),
        });
    }
    return pair;
}

/**
 * Checks a pair an operator chose, with the same rules `allocate` obeys.
 *
 * A port outside the published range is the trap this exists for: the server
 * starts, binds and works perfectly, and nothing on the host can reach it --
 * the MCP client gets a connection refused and the browser never reaches the
 * WebSocket, so the worker sits there connected to nothing (invariant 3).
 */
export function assertUsable(pair: PortPair, range: PortRange, busy: readonly number[]): void {
    assertRange(range);

    if (pair.http === pair.ws) {
        fail("not-configured", `the HTTP and WebSocket ports are both ${pair.http}`, { port: pair.http });
    }

    const remaining = () => {
        const f = free(range, busy);
        return f.length === 0 ? "none" : f.join(" ");
    };

    for (const [role, port] of [
        ["HTTP", pair.http],
        ["WebSocket", pair.ws],
    ] as const) {
        if (port < range.lo || port > range.hi) {
            fail(
                "port-out-of-range",
                `${role} port ${port} is outside the published range ${describeRange(range)}, ` +
                    `so nothing on this host could reach it`,
                { role, port, range: describeRange(range), free: remaining() }
            );
        }
        if (busy.includes(port)) {
            fail("port-busy", `${role} port ${port} is already serving inside the container`, {
                role,
                port,
                free: remaining(),
            });
        }
    }
}
