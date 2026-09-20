// What an account can drive, by name.
//
// A uuid is not something anyone recognises, and typing one is where blank and
// wrong ids came from. The RPC to list teams and files has existed and been
// tested since the start; this is what calls it.
//
// Degrading is the important part. A launcher that cannot reach Penpot must
// still open a lane -- the ids can be typed, as they always could -- so a
// failure here is recorded and reported, never thrown at the caller.

import type { Account } from "../core/config.ts";
import type { DocumentRef } from "../core/target.ts";
import type { PenpotApi, Session } from "./rpc.ts";

/** One document, as a person would pick it out of a list. */
export interface DocumentChoice {
    readonly fileId: string;
    readonly teamId: string;
    readonly fileName: string;
    readonly teamName: string;
    /** ISO timestamp, or empty when the server did not say. */
    readonly modifiedAt: string;
}

/** What an account can drive, and why it might not be known. */
export interface AccountCatalogue {
    readonly documents: readonly DocumentChoice[];
    /** Why the list is empty or stale, or null when it is neither. */
    readonly problem: string | null;
}

export interface Catalogue {
    /** Documents for an account, fetched once and remembered. */
    forAccount(account: Account, signal: AbortSignal): Promise<AccountCatalogue>;
    /** What is already known, without going and asking. */
    cached(accountName: string): AccountCatalogue | undefined;
    /** Drops what is remembered, so the next call asks again. */
    forget(accountName: string): void;
}

/** Turns a choice into the reference a lane is opened with. */
export function documentRefOf(choice: DocumentChoice): DocumentRef {
    return {
        fileId: choice.fileId,
        teamId: choice.teamId,
        name: choice.fileName,
        teamName: choice.teamName,
    };
}

/** How a choice reads in a picker. */
export function describeChoice(choice: DocumentChoice): string {
    return `${choice.teamName} / ${choice.fileName}`;
}

/** Builds a catalogue over the RPC surface. */
export function catalogue(api: PenpotApi): Catalogue {
    const known = new Map<string, AccountCatalogue>();
    const sessions = new Map<string, Session>();
    /** In-flight fetches, so opening the picker twice asks once. */
    const pending = new Map<string, Promise<AccountCatalogue>>();

    async function fetchFor(account: Account, signal: AbortSignal): Promise<AccountCatalogue> {
        if (account.email === undefined || account.password === undefined) {
            return { documents: [], problem: `${account.name} has no credentials to list its documents with` };
        }

        try {
            let session = sessions.get(account.name);
            if (session === undefined) {
                session = await api.loginWithPassword(account.origin, account.email, account.password);
                sessions.set(account.name, session);
            }

            const teams = await api.teams(account.origin, session);
            const documents: DocumentChoice[] = [];

            for (const team of teams) {
                if (signal.aborted) break;
                const files = await api.recentFiles(account.origin, session, team.id);

                for (const file of files) {
                    documents.push({
                        fileId: file.id,
                        teamId: file.teamId,
                        fileName: file.name,
                        teamName: team.name,
                        modifiedAt: file.modifiedAt,
                    });
                }
            }

            // Most recently touched first: the one someone wants is nearly
            // always the one they were last in. Files with no timestamp sort
            // last rather than first, where they would push the useful ones
            // off the top.
            documents.sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""));

            return { documents, problem: documents.length === 0 ? `${account.name} has no documents` : null };
        } catch (err) {
            // A stale session is the common cause, so drop it and let the next
            // attempt log in again.
            sessions.delete(account.name);
            return { documents: [], problem: reasonOf(err) };
        }
    }

    return {
        async forAccount(account, signal) {
            const cachedResult = known.get(account.name);
            if (cachedResult !== undefined) return cachedResult;

            const inFlight = pending.get(account.name);
            if (inFlight !== undefined) return await inFlight;

            const work = fetchFor(account, signal).then((result) => {
                pending.delete(account.name);
                // A failure is not cached: the network may be back by the time
                // someone presses the key again.
                if (result.problem === null) known.set(account.name, result);
                return result;
            });

            pending.set(account.name, work);
            return await work;
        },

        cached(accountName) {
            return known.get(accountName);
        },

        forget(accountName) {
            known.delete(accountName);
            sessions.delete(accountName);
        },
    };
}

function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
