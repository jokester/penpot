// The one error type the launcher raises deliberately.
//
// Callers branch on `code`, never on the message. Every message in this package
// is written for a person reading a TUI pane at the moment something refused to
// start, so it is free to change; the code is the contract.

/**
 * A reason the launcher refused or failed, stable enough to switch on.
 *
 * The first three come from a workspace URL, the next three from port
 * allocation, and the rest from the supervisor. Each corresponds to an
 * invariant in SPEC section 11 or to a scope limit in section 3b.
 */
export type ErrorCode =
    /** An id was present but empty -- the failure that renders a blank workspace. */
    | "blank-id"
    /** An id was present and not a UUID. */
    | "bad-id"
    /** A workspace URL carried no team-id, which renders nothing at all. */
    | "no-team-id"
    /** A port sits outside the range the deployment publishes. */
    | "port-out-of-range"
    /** A port is already serving inside the container. */
    | "port-busy"
    /** No free pair is left in the range. */
    | "range-exhausted"
    /** The mode is in the map but not in v1 (SPEC section 3b). */
    | "mode-not-implemented"
    /** The supervisor will not open this lane beside the ones it already has. */
    | "lane-refused"
    /** Something that must be reachable is not. */
    | "unreachable"
    /** The launcher was asked for something its configuration does not describe. */
    | "not-configured";

/** Structured context for an error, rendered beside the message in the TUI. */
export type ErrorDetail = Readonly<Record<string, string | number>>;

/**
 * An error the launcher raised on purpose, carrying a code and its context.
 *
 * Anything else reaching a catch block is a bug rather than a refusal, which is
 * why the supervisor reports the two differently.
 */
export class LauncherError extends Error {
    readonly code: ErrorCode;
    readonly detail: ErrorDetail;

    constructor(code: ErrorCode, message: string, detail: ErrorDetail = {}) {
        super(message);
        this.name = "LauncherError";
        this.code = code;
        this.detail = detail;
    }
}

/** True when `value` is an error this package raised deliberately. */
export function isLauncherError(value: unknown): value is LauncherError {
    return value instanceof LauncherError;
}

/** Raises a `LauncherError`; exists so call sites read as one statement. */
export function fail(code: ErrorCode, message: string, detail: ErrorDetail = {}): never {
    throw new LauncherError(code, message, detail);
}
