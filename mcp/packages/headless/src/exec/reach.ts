// Proving a port answers, shared by both backends.
//
// Extracted from the compose backend when kubectl needed the same thing. The
// comment below is the whole reason this is an HTTP exchange and not a connect,
// and it belongs wherever the check lives.

import { request } from "node:http";

/**
 * True when something answers an HTTP request on `host:port`.
 *
 * An HTTP exchange, not a TCP connect, and the difference is the whole point.
 * Docker's proxy accepts a connection on every published port whether or not
 * anything is behind it inside the container, so a connect to a free port in
 * the range succeeds and then resets. Measured on this host: connecting to a
 * published, unoccupied 4608 succeeded, and the GET that followed failed with
 * ECONNRESET. A connect-based check would have called every port in the range
 * reachable -- the same lie invariant 5 describes, from the other direction.
 *
 * `kubectl port-forward` lies in the same shape and worse: it accepts the local
 * connection before it has spoken to the API server at all, so the forward
 * looks up the instant it is spawned.
 *
 * Any response counts, status included. A bare GET to an MCP endpoint is
 * answered with a 4xx, and that is still proof that a server is behind the
 * port.
 */
export function reachable(host: string, port: number): Promise<boolean> {
    return new Promise((resolveP) => {
        const req = request({ host, port, path: "/mcp", method: "GET", timeout: 1000 }, (res) => {
            res.resume();
            resolveP(true);
        });
        req.on("error", () => resolveP(false));
        req.on("timeout", () => {
            req.destroy();
            resolveP(false);
        });
        req.end();
    });
}

/** Waits, unless the signal fires first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolveP) => {
        const timer = setTimeout(finish, ms);
        function finish() {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolveP();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}
