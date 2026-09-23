// What the façade does, with no MCP server attached.
//
// Every rule lives here and the SDK wiring in `server.ts` is a thin shell over
// it, for the same reason `render` is a pure function and the form is a pure
// model: the part that can be wrong should be testable without standing a
// server up.
//
// The tool set is hard-coded rather than mirrored from a lane, because no lane
// exists before the first `connect_doc` and there would be nothing to mirror
// from at startup. A live test asserts the list still matches what a lane
// advertises, so drift fails a test instead of surprising an agent.

import type { Account } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { describeChoice, documentRefOf, type Catalogue, type DocumentChoice } from "../penpot/catalogue.ts";
import type { LeaseRegistry } from "./leases.ts";

/** A tool call's answer, in the shape MCP returns. */
export interface CallResult {
    readonly content: readonly unknown[];
    readonly isError?: boolean;
}

/** Calling a tool on some MCP endpoint. Bound to the SDK client in `main.ts`. */
export interface Backend {
    call(
        endpoint: string,
        tool: string,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal
    ): Promise<CallResult>;
}

/**
 * The tools a lane serves that act on a document.
 *
 * Measured against a single-user lane on 2026-09-23. Multi-user drops
 * `import_image`, which is why the list was taken from a lane rather than from
 * the instance's own endpoint.
 */
export const DOCUMENT_TOOLS = ["execute_code", "export_shape", "import_image"] as const;

/**
 * The tools that need no document, and therefore no lane.
 *
 * Both return content the server carries rather than anything about a file, so
 * they answer with no plugin connected -- verified against the instance's own
 * endpoint. That matters because the server's instructions tell an agent to
 * read the overview *first*, before it could possibly have connected.
 */
export const STATIC_TOOLS = ["high_level_overview", "penpot_api_info"] as const;

export type DocumentTool = (typeof DOCUMENT_TOOLS)[number];
export type StaticTool = (typeof STATIC_TOOLS)[number];

/** What `connect_doc` tells the agent it got. */
export interface Connected {
    readonly document: string;
    readonly fileId: string;
    readonly teamId: string;
    /** Anyone else in the file right now, which the façade cannot prevent. */
    readonly alsoEditing: readonly string[];
}

export interface FacadeDeps {
    readonly leases: LeaseRegistry;
    readonly backend: Backend;
    readonly catalogue: Catalogue;
    readonly account: Account;
    /**
     * The instance's own MCP endpoint, where static tools go.
     *
     * Always up, needs no lane, and needs no plugin -- so the first call an
     * agent makes cannot fail for want of a document.
     */
    readonly staticEndpoint: string;
}

/**
 * Finds the one document a query means, or says why it cannot.
 *
 * Agents pass names, people paste ids, and both should work. Ambiguity is
 * refused rather than guessed at: driving the wrong document is the expensive
 * mistake in this system.
 */
export function resolveDocument(query: string, documents: readonly DocumentChoice[]): DocumentChoice {
    const wanted = query.trim().toLowerCase();
    if (wanted === "") fail("blank-id", "which document? pass a name or a file id", {});

    const byId = documents.find((d) => d.fileId.toLowerCase() === wanted);
    if (byId !== undefined) return byId;

    const exact = documents.filter((d) => d.fileName.toLowerCase() === wanted);
    if (exact.length === 1) return exact[0] as DocumentChoice;

    const partial = documents.filter((d) => describeChoice(d).toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0] as DocumentChoice;

    const known = documents.map(describeChoice).join(", ") || "none";
    if (partial.length > 1) {
        fail("bad-id", `"${query}" matches ${partial.length} documents: ${partial.map(describeChoice).join(", ")}`, {
            query,
        });
    }
    fail("bad-id", `no document matches "${query}"; there is: ${known}`, { query });
}

/** The façade's behaviour, with no transport attached. */
export class Facade {
    readonly #deps: FacadeDeps;

    constructor(deps: FacadeDeps) {
        this.#deps = deps;
    }

    /** Every document the account can drive, by name. */
    async listDocuments(signal: AbortSignal): Promise<{ documents: readonly string[]; problem: string | null }> {
        const result = await this.#deps.catalogue.forAccount(this.#deps.account, signal);
        return { documents: result.documents.map(describeChoice), problem: result.problem };
    }

    /**
     * Gives this session a document, opening a lane if one is needed.
     *
     * Blocks until the lane is connected. An agent that gets a fast success and
     * then a slow first call reads the second as a hang.
     */
    async connectDoc(sessionId: string, query: string, signal: AbortSignal): Promise<Connected> {
        const choice = await this.#resolve(query, signal);
        const document = documentRefOf(choice);
        const lease = await this.#deps.leases.acquire(sessionId, document, signal);

        return {
            document: describeChoice(choice),
            fileId: document.fileId,
            teamId: document.teamId,
            alsoEditing: await this.#alsoEditing(lease, signal),
        };
    }

    /** Gives the document back, wiping the scratchpad on the way out. */
    async disconnectDoc(sessionId: string): Promise<{ released: string | null }> {
        const held = this.#deps.leases.heldBy(sessionId);
        await this.#deps.leases.release(sessionId);
        return { released: held?.document.name ?? held?.document.fileId ?? null };
    }

    /** Called when a transport closes, so a lane is not held by a session that is gone. */
    async releaseSession(sessionId: string): Promise<void> {
        await this.#deps.leases.release(sessionId);
    }

    /** Answers a tool that needs no document, and therefore no lane. */
    async callStatic(
        tool: StaticTool,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal
    ): Promise<CallResult> {
        return await this.#deps.backend.call(this.#deps.staticEndpoint, tool, args, signal);
    }

    /**
     * Answers a tool that acts on a document.
     *
     * `document` is optional and, when given, switches this session to it --
     * which is also how a client whose session was swept recovers without
     * having to notice that it was.
     */
    async callDocument(
        sessionId: string,
        tool: DocumentTool,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal
    ): Promise<CallResult & { queuedBehind: number }> {
        const { document: named, ...rest } = args as { document?: unknown };

        if (typeof named === "string" && named.trim() !== "") {
            await this.connectDoc(sessionId, named, signal);
        }

        const lease = this.#deps.leases.heldBy(sessionId);
        if (lease === undefined) {
            fail("not-configured", `no document is connected; call connect_doc first, or pass document`, {});
        }

        const ran = await this.#deps.leases.run(lease, () =>
            this.#deps.backend.call(lease.lane.clientUrl, tool, rest, signal)
        );
        return { ...ran.value, queuedBehind: ran.queuedBehind };
    }

    async #resolve(query: string, signal: AbortSignal): Promise<DocumentChoice> {
        const result = await this.#deps.catalogue.forAccount(this.#deps.account, signal);
        if (result.documents.length === 0) {
            fail("not-configured", result.problem ?? `${this.#deps.account.name} has no documents`, {});
        }
        return resolveDocument(query, result.documents);
    }

    /**
     * Who else is in the file, which is the one thing we can do about a person.
     *
     * A human editing the same document cannot be prevented -- no lock of ours
     * binds them -- so the next best thing is to say so. Best effort: failing to
     * ask must not fail the connection.
     */
    async #alsoEditing(lease: { lane: { clientUrl: string } }, signal: AbortSignal): Promise<readonly string[]> {
        try {
            const result = await this.#deps.backend.call(
                lease.lane.clientUrl,
                "execute_code",
                { code: "return (penpot.activeUsers ?? []).map((u) => u.name ?? u.id);" },
                signal
            );
            const text = firstText(result);
            const parsed = text === null ? null : (JSON.parse(text) as { result?: unknown });
            const names = Array.isArray(parsed?.result) ? parsed.result : [];
            return names.filter((name): name is string => typeof name === "string");
        } catch {
            return [];
        }
    }
}

/** The first text block of a result, or null when there is none. */
function firstText(result: CallResult): string | null {
    for (const block of result.content) {
        if (typeof block === "object" && block !== null && "text" in block) {
            const text = (block as { text: unknown }).text;
            if (typeof text === "string") return text;
        }
    }
    return null;
}
