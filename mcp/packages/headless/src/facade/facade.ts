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
    /**
     * The worker pool, in preference order.
     *
     * The façade asks every one of them what it can see, because two workers
     * need not be in the same teams -- and then a lane is opened by a worker
     * that can actually see the document, rather than by whichever was free.
     */
    readonly accounts: readonly Account[];
    /**
     * The instance's own MCP endpoint, where static tools go.
     *
     * Always up, needs no lane, and needs no plugin -- so the first call an
     * agent makes cannot fail for want of a document.
     */
    readonly staticEndpoint: string;
}

/**
 * Makes every document's label unique, by adding the start of its id.
 *
 * Two files can share a name in one team, and the pool makes that likelier:
 * every worker is provisioned with a scratch document. Left alone, both
 * render as the same row, `resolveDocument` refuses the ambiguity, and the
 * refusal lists the same words twice -- true, and no help at all.
 */
function disambiguate<T extends { choice: DocumentChoice }>(seen: Map<string, T>): Map<string, T> {
    const counts = new Map<string, number>();
    for (const entry of seen.values()) {
        const label = describeChoice(entry.choice);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    for (const entry of seen.values()) {
        if ((counts.get(describeChoice(entry.choice)) ?? 0) < 2) continue;
        // The END of the id, not the start. Penpot's file ids are time-ordered
        // with the entropy last: two documents created seconds apart came back
        // as a5ca2f23-cfad-8091-8008-af1cd3f4cd2c and
        // a5ca2f23-cfad-8091-8008-af1cd4a03b9d, identical for 28 characters.
        // A leading slice disambiguates nothing at all.
        const short = entry.choice.fileId.slice(-8);
        (entry as { choice: DocumentChoice }).choice = {
            ...entry.choice,
            fileName: `${entry.choice.fileName} (${short})`,
        };
    }
    return seen;
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
    /** Why a worker's list was empty or stale, from the last look. */
    #problem: string | null = null;

    constructor(deps: FacadeDeps) {
        this.#deps = deps;
    }

    /** Every document any worker can drive, by name. */
    async listDocuments(signal: AbortSignal): Promise<{ documents: readonly string[]; problem: string | null }> {
        const seen = await this.#visible(signal);
        return {
            documents: [...seen.values()].map((entry) => describeChoice(entry.choice)),
            problem: seen.size === 0 ? (this.#problem ?? "no worker can see any documents") : null,
        };
    }

    /**
     * Gives this session a document, opening a lane if one is needed.
     *
     * Blocks until the lane is connected. An agent that gets a fast success and
     * then a slow first call reads the second as a hang.
     */
    async connectDoc(sessionId: string, query: string, signal: AbortSignal): Promise<Connected> {
        const { choice, eligible } = await this.#resolve(query, signal);
        const document = documentRefOf(choice);
        const lease = await this.#deps.leases.acquire(sessionId, document, signal, eligible);

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

    async #resolve(query: string, signal: AbortSignal): Promise<{ choice: DocumentChoice; eligible: string[] }> {
        const seen = await this.#visible(signal);
        if (seen.size === 0) {
            fail("not-configured", this.#problem ?? "no worker can see any documents", {});
        }

        const choice = resolveDocument(
            query,
            [...seen.values()].map((entry) => entry.choice)
        );
        return { choice, eligible: seen.get(choice.fileId)?.accounts ?? [] };
    }

    /**
     * Every document the pool can reach, and which workers can reach each.
     *
     * The union rather than one worker's view: a document only worker-b was
     * invited to is still drivable, and listing only worker-a's would hide it.
     * Deduplicated by file id, so a document two workers share appears once.
     */
    async #visible(signal: AbortSignal): Promise<Map<string, { choice: DocumentChoice; accounts: string[] }>> {
        const seen = new Map<string, { choice: DocumentChoice; accounts: string[] }>();
        const problems: string[] = [];

        for (const account of this.#deps.accounts) {
            const result = await this.#deps.catalogue.forAccount(account, signal);
            if (result.problem !== null) problems.push(`${account.name}: ${result.problem}`);

            for (const choice of result.documents) {
                const entry = seen.get(choice.fileId);
                if (entry === undefined) seen.set(choice.fileId, { choice, accounts: [account.name] });
                else entry.accounts.push(account.name);
            }
        }

        this.#problem = problems.length === 0 ? null : problems.join("; ");
        return disambiguate(seen);
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
