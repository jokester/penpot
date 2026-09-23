// Who holds which document, and one call at a time on each.
//
// Two rules live here, for two different reasons, and conflating them was a
// wrong turn in the design (FACADE.md sections 6b and 6c).
//
// The **lease** is an allocation policy: one lane per document, held by one
// session. It is not a lock and claims nothing about anyone else -- a person
// editing in their own browser is beyond our reach -- it declines to create the
// one collision we control. Two agents on one document is hazardous in itself:
// plugin objects are live handles, so values stay fresh while an agent's plan
// goes stale, and a handle to a shape the other agent deleted throws.
//
// The **lock** is concurrency, and is needed even with one agent. A client may
// issue parallel tool calls, and the plugin dispatches without awaiting, so two
// calls interleave in one JS context -- sharing a console buffer that each call
// resets, and a flag save-and-restore that is not reentrant.

import { fail } from "../core/errors.ts";
import type { DocumentRef } from "../core/target.ts";

/** How long a released lane is kept warm before it is torn down. */
export const IDLE_MS = 10 * 60 * 1000;

/** How long one call may hold a lane before the lane is considered lost. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** A lane the façade has allocated, as much of it as the registry needs. */
export interface LaneHandle {
    readonly id: string;
    /** Where the façade forwards calls for this lane. */
    readonly clientUrl: string;
}

/** Making and unmaking lanes, so the registry can be tested without one. */
export interface LaneSource {
    /** Opens a lane on a document and resolves once its plugin has connected. */
    open(document: DocumentRef, signal: AbortSignal): Promise<LaneHandle>;
    close(id: string): Promise<void>;
    /**
     * Clears the lane's `storage`, so the next holder sees nothing of the last.
     *
     * The server's own instructions tell the agent to use `storage`
     * "extensively... across tool calls", and it is one object per tab. Wiping
     * on release is what makes a lane safe to hand on.
     */
    wipe(lane: LaneHandle, signal: AbortSignal): Promise<void>;
}

export interface LeaseOptions {
    /** How many lanes may exist at once; the published range allows eight. */
    readonly capacity: number;
    readonly idleMs?: number;
    readonly lockTimeoutMs?: number;
    readonly now?: () => number;
}

/** A document a session holds, and the lane serving it. */
export interface Lease {
    readonly document: DocumentRef;
    readonly lane: LaneHandle;
}

/** What a call saw when it arrived, so a slow answer can explain itself. */
export interface Ran<T> {
    readonly value: T;
    /** How many calls were already queued on this lane. */
    readonly queuedBehind: number;
}

/** A lane and who, if anyone, has it. */
interface Slot {
    readonly document: DocumentRef;
    readonly lane: LaneHandle;
    /** The session holding it, or null when it is warm. */
    holder: string | null;
    /** When it became warm, for the idle sweep and for eviction order. */
    releasedAt: number | null;
    /** The tail of the FIFO; a new call waits on it and becomes the new tail. */
    queue: Promise<unknown>;
    /** Calls queued or running, so a caller can be told what it waited behind. */
    waiting: number;
}

/** The name to put in a message, which is the file's name if it has one. */
function describe(document: DocumentRef): string {
    return document.name ?? document.fileId;
}

export class LeaseRegistry {
    readonly #lanes: LaneSource;
    readonly #capacity: number;
    readonly #idleMs: number;
    readonly #lockTimeoutMs: number;
    readonly #now: () => number;

    /** Slots by file id: one per document, which is the whole policy. */
    readonly #slots = new Map<string, Slot>();
    /** Serialises acquire, because choosing a lane is a read then a write. */
    #gate: Promise<unknown> = Promise.resolve();

    constructor(lanes: LaneSource, options: LeaseOptions) {
        this.#lanes = lanes;
        this.#capacity = options.capacity;
        this.#idleMs = options.idleMs ?? IDLE_MS;
        this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
        this.#now = options.now ?? Date.now;
    }

    /**
     * Gives a session the document, or says who has it.
     *
     * A session holds one document at a time, so asking for a second releases
     * the first. That keeps one agent from taking the whole budget, and makes
     * the held set something a person can reason about.
     */
    async acquire(sessionId: string, document: DocumentRef, signal: AbortSignal): Promise<Lease> {
        const run = this.#gate.then(() => this.#acquireOne(sessionId, document, signal));
        this.#gate = run.catch(() => undefined);
        return await run;
    }

    async #acquireOne(sessionId: string, document: DocumentRef, signal: AbortSignal): Promise<Lease> {
        const existing = this.#slots.get(document.fileId);

        if (existing?.holder === sessionId) return { document: existing.document, lane: existing.lane };

        if (existing !== undefined && existing.holder !== null) {
            fail("lane-refused", `"${describe(existing.document)}" is already held by another client`, {
                fileId: document.fileId,
            });
        }

        // One document per session: whatever this session had, it has no longer.
        await this.#releaseHeldBy(sessionId);

        if (existing !== undefined) {
            // Warm, and already wiped when it was released.
            existing.holder = sessionId;
            existing.releasedAt = null;
            return { document: existing.document, lane: existing.lane };
        }

        await this.#makeRoom(document);

        const lane = await this.#lanes.open(document, signal);
        const slot: Slot = {
            document,
            lane,
            holder: sessionId,
            releasedAt: null,
            queue: Promise.resolve(),
            waiting: 0,
        };
        this.#slots.set(document.fileId, slot);
        return { document, lane };
    }

    /**
     * Frees a port for a new document, or refuses.
     *
     * A warm lane has no holder, so taking it costs nobody anything; the oldest
     * goes first. A held lane is never taken -- an agent must not be able to
     * evict another agent -- so when every lane is held the answer is no.
     */
    async #makeRoom(wanted: DocumentRef): Promise<void> {
        if (this.#slots.size < this.#capacity) return;

        const warm = [...this.#slots.values()]
            .filter((slot) => slot.holder === null)
            .sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0));

        const oldest = warm[0];
        if (oldest === undefined) {
            const held = [...this.#slots.values()].map((slot) => describe(slot.document)).join(", ");
            fail(
                "lane-refused",
                `all ${this.#capacity} lanes are in use, so "${describe(wanted)}" cannot be opened; ` +
                    `in use: ${held}`,
                { capacity: this.#capacity, wanted: wanted.fileId }
            );
        }
        await this.#tearDown(oldest);
    }

    /** Gives back whatever this session holds, wiping the scratchpad on the way. */
    async release(sessionId: string): Promise<void> {
        await this.#releaseHeldBy(sessionId);
    }

    async #releaseHeldBy(sessionId: string): Promise<void> {
        const slot = [...this.#slots.values()].find((candidate) => candidate.holder === sessionId);
        if (slot === undefined) return;

        // Best effort: a lane that cannot be wiped is torn down instead, since
        // handing on a dirty scratchpad is the one thing this must not do.
        try {
            await this.#lanes.wipe(slot.lane, AbortSignal.timeout(30_000));
        } catch {
            await this.#tearDown(slot);
            return;
        }

        slot.holder = null;
        slot.releasedAt = this.#now();
    }

    /** The document this session holds, if any. */
    heldBy(sessionId: string): Lease | undefined {
        const slot = [...this.#slots.values()].find((candidate) => candidate.holder === sessionId);
        return slot === undefined ? undefined : { document: slot.document, lane: slot.lane };
    }

    /**
     * Runs one call against a lane, with nothing else running on it.
     *
     * A call that outlives the lock timeout does not merely fail: the lane is
     * torn down. Releasing the lock while the old call is still running inside
     * the tab would let the next one interleave, which is the thing the lock
     * exists to prevent, and a tab in an unknown state is worse than a cold
     * start.
     */
    async run<T>(lease: Lease, fn: () => Promise<T>): Promise<Ran<T>> {
        const slot = this.#slots.get(lease.document.fileId);
        if (slot === undefined || slot.lane.id !== lease.lane.id) {
            fail("lane-refused", `the lane for "${describe(lease.document)}" is gone; connect to it again`, {
                fileId: lease.document.fileId,
            });
        }

        const queuedBehind = slot.waiting;
        slot.waiting += 1;

        const ahead = slot.queue;
        let releaseLock: () => void = () => undefined;
        slot.queue = new Promise<void>((resolve) => (releaseLock = resolve));

        await ahead.catch(() => undefined);

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const value = await new Promise<T>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), this.#lockTimeoutMs);
                fn().then(resolve, reject);
            }).catch(async (err: unknown) => {
                if (err instanceof Error && err.message === "timeout") {
                    await this.#tearDown(slot);
                    fail(
                        "unreachable",
                        `a call held "${describe(slot.document)}" for longer than ` +
                            `${Math.round(this.#lockTimeoutMs / 1000)}s; the lane was torn down`,
                        { fileId: slot.document.fileId }
                    );
                }
                throw err;
            });

            return { value, queuedBehind };
        } finally {
            clearTimeout(timer);
            slot.waiting -= 1;
            releaseLock();
        }
    }

    /** Tears down warm lanes nobody has come back for. */
    async collectIdle(): Promise<number> {
        const now = this.#now();
        const stale = [...this.#slots.values()].filter(
            (slot) => slot.holder === null && slot.releasedAt !== null && now - slot.releasedAt >= this.#idleMs
        );

        for (const slot of stale) await this.#tearDown(slot);
        return stale.length;
    }

    /** Every lane, held or warm, for a status line. */
    list(): readonly { document: DocumentRef; holder: string | null }[] {
        return [...this.#slots.values()].map((slot) => ({ document: slot.document, holder: slot.holder }));
    }

    /** Ends every lane. The façade's last act. */
    async closeAll(): Promise<void> {
        const slots = [...this.#slots.values()];
        this.#slots.clear();
        await Promise.all(slots.map((slot) => this.#lanes.close(slot.lane.id).catch(() => undefined)));
    }

    async #tearDown(slot: Slot): Promise<void> {
        this.#slots.delete(slot.document.fileId);
        await this.#lanes.close(slot.lane.id).catch(() => undefined);
    }
}
