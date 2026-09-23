// Where the façade listens, and where that answer comes from.
//
// Pure, because the precedence is the part worth getting right and it should
// not need a socket to check.

import { fail } from "../core/errors.ts";

/** What the façade binds when nothing says otherwise. */
export const DEFAULT_ADDRESS = { host: "127.0.0.1", port: 4400 } as const;

export interface Address {
    readonly host: string;
    readonly port: number;
}

/**
 * Reads `--listen`, in any of the spellings a person would try.
 *
 * `--listen` rather than `--port` because `--port` already belongs to a lane
 * group and must follow an `--account`; two meanings for one flag would be a
 * trap rather than a convenience.
 */
export function parseListen(value: string): Partial<Address> {
    const text = value.trim();
    if (text === "") fail("not-configured", "--listen needs an address, for example 4400 or 127.0.0.1:4400", {});

    const colon = text.lastIndexOf(":");
    if (colon === -1) return { port: port(text) };

    const host = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1);
    return host === "" ? { port: port(rest) } : { host, port: port(rest) };
}

/**
 * Settles the address: the flag, then the environment, then the default.
 *
 * `HOST` and `PORT` are read bare because that is the convention asked for.
 * Worth knowing: zsh keeps a `HOST` parameter set to the machine's hostname but
 * does not export it, so a child process sees nothing -- but anything that does
 * export it would move the façade off loopback. The bind address is logged at
 * startup for exactly that reason.
 */
export function facadeAddress(
    listen: Partial<Address> | undefined,
    env: NodeJS.ProcessEnv,
    conf?: Partial<Address>
): Address {
    const fromEnv: Partial<Address> = {
        ...(env.HOST === undefined || env.HOST.trim() === "" ? {} : { host: env.HOST.trim() }),
        ...(env.PORT === undefined || env.PORT.trim() === "" ? {} : { port: port(env.PORT.trim()) }),
    };

    // The file beats the environment. $PORT is ambient -- inherited from a
    // shell, a supervisor, a parent process that had its own reasons -- while
    // conf.yaml was written for this deployment by someone who meant it. The
    // flag beats both, because it was typed just now.
    return { ...DEFAULT_ADDRESS, ...fromEnv, ...(conf ?? {}), ...(listen ?? {}) };
}

/** True when the address is reachable only from this machine. */
export function isLoopback(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function port(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        fail("not-configured", `${value} is not a port number`, { value });
    }
    return parsed;
}
