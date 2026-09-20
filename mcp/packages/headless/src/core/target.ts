// What a lane drives: an account, and a document inside it.
//
// Both halves are addresses rather than state. The workspace URL is the only
// thing the browser is ever told, so building it correctly is the whole job of
// this module, and the two ways to get it wrong are invariants 1 and 2.

import { fail } from "./errors.ts";

/** A Penpot login the launcher can drive, and the browser profile holding its session. */
export interface AccountRef {
    /** Short local name, from the account file's basename. Not the email. */
    readonly name: string;
    /** Origin with no trailing slash, e.g. `http://localhost:9001`. */
    readonly origin: string;
    /** Directory holding this account's persistent browser profile. */
    readonly profileDir: string;
}

/**
 * A document a lane drives, addressed the way Penpot addresses it.
 *
 * `teamId` is not optional. A workspace URL carrying only a file id loads,
 * authenticates, opens the notifications socket, reports no error and renders
 * nothing (invariant 1) -- the most expensive failure in this system to
 * diagnose. Requiring the field moves it from a blank screen to a type error.
 */
export interface DocumentRef {
    readonly fileId: string;
    readonly teamId: string;
    /** Opens on a specific page when given; Penpot picks the first otherwise. */
    readonly pageId?: string;
    /** For display only. Never part of identity. */
    readonly name?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks one id and returns it lowercased, or throws naming the field.
 *
 * Lowercasing is not cosmetic: a `DocumentRef` is compared to decide whether a
 * document is already being driven, and two spellings of one uuid must not
 * look like two documents.
 */
function requireId(field: string, value: string | null | undefined): string {
    if (value === null || value === undefined) {
        fail("missing-id", `${field} is missing from the workspace URL`, { field });
    }
    if (value.trim() === "") {
        fail("blank-id", `${field} is present but empty, which silently drives the wrong document`, { field });
    }
    if (!UUID.test(value)) {
        fail("bad-id", `${field} is not a uuid: ${value}`, { field, value });
    }
    return value.toLowerCase();
}

/** Strips a trailing slash so origins concatenate predictably. */
export function normalizeOrigin(origin: string): string {
    return origin.replace(/\/+$/, "");
}

/**
 * Builds the workspace URL a worker tab should open.
 *
 * Emits the legacy hash form, `#/workspace?team-id=…&file-id=…`, because that
 * is what the deployed 2.17 instances answer. Penpot's `develop` has since
 * moved to query-string routing (`?screen=workspace&…`) and keeps the hash
 * form only "during the compatibility window", with a TODO to delete it --
 * see `frontend/src/app/main/ui/routes.cljs`. When the target instance crosses
 * that version, this function is the one place that has to change, and
 * `parseWorkspaceUrl` already reads both forms.
 */
export function workspaceUrl(account: AccountRef, doc: DocumentRef): string {
    const teamId = requireId("team-id", doc.teamId);
    const fileId = requireId("file-id", doc.fileId);

    const query = new URLSearchParams({ "team-id": teamId, "file-id": fileId });
    if (doc.pageId !== undefined) query.set("page-id", requireId("page-id", doc.pageId));

    return `${normalizeOrigin(account.origin)}/#/workspace?${query.toString()}`;
}

/**
 * Reads a workspace URL back into a `DocumentRef`, in either routing style.
 *
 * Accepts the legacy `…/#/workspace?…` hash form and the query-string form
 * `…/?screen=workspace&…`, because an operator pastes whatever their browser
 * showed them. Throws rather than returning a reference with an empty field:
 * the regex this replaces matched `file-id=[0-9a-f-]*` with a `*`, so an empty
 * value parsed cleanly and drove the wrong document (invariant 2).
 */
export function parseWorkspaceUrl(url: string): DocumentRef {
    const query = workspaceQuery(url);

    const doc: DocumentRef = {
        teamId: requireId("team-id", query.get("team-id")),
        fileId: requireId("file-id", query.get("file-id")),
    };

    const pageId = query.get("page-id");
    return pageId === null ? doc : { ...doc, pageId: requireId("page-id", pageId) };
}

/** Extracts the parameter block of a workspace URL, whichever style it is in. */
function workspaceQuery(url: string): URLSearchParams {
    const hash = url.indexOf("#");
    if (hash !== -1) {
        const question = url.indexOf("?", hash);
        if (question === -1) {
            fail("missing-id", `no parameters in the workspace URL after the #: ${url}`, { url });
        }
        return new URLSearchParams(url.slice(question + 1));
    }

    const question = url.indexOf("?");
    if (question === -1) {
        fail("missing-id", `no parameters in the workspace URL: ${url}`, { url });
    }
    return new URLSearchParams(url.slice(question + 1));
}
