// The set of lanes, their cancellation scopes, and what the TUI renders.
//
// State flows out and intents flow in. The supervisor owns every lane record
// and publishes the whole list on any change; the TUI renders it and sends
// intents back. No lane knows a TUI exists, and the TUI never reaches into a
// lane -- which is what lets the same supervisor run under --no-tui with a log
// writer where the renderer would be.

import { fail } from "../core/errors.ts";
import { allocate, assertUsable, type PortPair } from "../core/ports.ts";
import { runLane, type LaneDeps, type LaneEvent, type LaneSpec, type LaneState } from "./lane.ts";

/** What the TUI draws for one lane. */
export interface LaneRecord {
    readonly spec: LaneSpec;
    readonly state: LaneState;
    /** When the lane entered this state. */
    readonly since: number;
    /** The current step, while opening. */
    readonly detail?: string;
    readonly clientUrl?: string;
    readonly port?: PortPair;
    readonly error?: string;
    /** The last output of a failed lane's server. */
    readonly log?: readonly string[];
}

/** What the TUI and the non-interactive front end both drive. */
export interface Supervisor {
    /** Opens a lane, or rejects saying why this one cannot sit beside the others. */
    open(spec: Omit<LaneSpec, "id">): Promise<string>;
    close(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    list(): readonly LaneRecord[];
    subscribe(fn: (records: readonly LaneRecord[]) => void): () => void;
    /** Ends every lane under one deadline, reporting what had to be forced. */
    shutdown(deadlineMs: number): Promise<{ readonly forced: number }>;
}

/** Ports a previous run left behind, which no new lane may take. */
export interface SupervisorOptions {
    /** Swapped for a fake in tests; the real one is `runLane`. */
    readonly run?: typeof runLane;
    readonly now?: () => number;
}

/** A lane the supervisor is currently running. */
interface Live {
    record: LaneRecord;
    readonly control: AbortController;
    readonly finished: Promise<void>;
}

export class LaneSupervisor implements Supervisor {
    readonly #deps: LaneDeps;
    readonly #run: typeof runLane;
    readonly #now: () => number;
    readonly #lanes = new Map<string, Live>();
    readonly #subscribers = new Set<(records: readonly LaneRecord[]) => void>();
    /** Ports handed out but not yet listening, so a sibling cannot take them. */
    readonly #reserved = new Map<string, PortPair>();
    /** Serialises open(), because choosing a port is a read then a write. */
    #gate: Promise<unknown> = Promise.resolve();
    #nextId = 1;

    constructor(deps: LaneDeps, options: SupervisorOptions = {}) {
        this.#deps = deps;
        this.#run = options.run ?? runLane;
        this.#now = options.now ?? Date.now;
    }

    /**
     * Opens a lane, refusing the combinations that would fail later and worse.
     *
     * A refusal at the call is better than a mystery at the first tool call.
     * Both of these produced one: a second builtin lane on an account loses the
     * race for the account's single plugin slot and blames the browser, and two
     * lanes on one document leave the second driving a file the first is also
     * writing.
     */
    async open(spec: Omit<LaneSpec, "id">): Promise<string> {
        // Serialised, because choosing a port is a read of what is busy
        // followed by a write that makes it busy. Two concurrent opens each
        // probed the container before the other had started its server and
        // both took 4601 -- measured on the first two-lane run. A lane cannot
        // see its siblings; only this can.
        const run = this.#gate.then(() => this.#openOne(spec));
        this.#gate = run.catch(() => undefined);
        return await run;
    }

    async #openOne(spec: Omit<LaneSpec, "id">): Promise<string> {
        this.#refuseClashes(spec);

        const id = String(this.#nextId++);
        const port = await this.#choosePort(spec);
        if (port !== null) this.#reserved.set(id, port);

        this.#start({ ...spec, id, ...(port === null ? {} : { port }) });
        return id;
    }

    /**
     * Settles this lane's ports before it starts, or null when it needs none.
     *
     * The busy list is what the container reports plus what this supervisor has
     * already promised. The container alone is not enough: a port handed to a
     * lane that has not finished starting is still free as far as /proc is
     * concerned.
     */
    async #choosePort(spec: Omit<LaneSpec, "id">): Promise<PortPair | null> {
        const backend = this.#deps.backend;
        if (spec.mode === "builtin" || backend === undefined) return null;

        const reserved = [...this.#reserved.values()].flatMap((pair) => [pair.http, pair.ws]);
        const busy = [...new Set([...(await backend.listening()), ...reserved])];

        if (spec.port === undefined) return allocate(this.#deps.portRange, busy);

        assertUsable(spec.port, this.#deps.portRange, busy);
        return spec.port;
    }

    async close(id: string): Promise<void> {
        const lane = this.#lanes.get(id);
        if (lane === undefined) return;

        this.#set(id, { state: "closing", detail: "stopping" });
        lane.control.abort();
        await lane.finished;

        this.#set(id, { state: "closed" });
        this.#lanes.delete(id);
        this.#reserved.delete(id);
        this.#publish();
    }

    /** Re-runs a failed lane in place, keeping its id so the TUI row does not jump. */
    async retry(id: string): Promise<void> {
        const lane = this.#lanes.get(id);
        if (lane === undefined) fail("lane-refused", `there is no lane ${id}`, { id });
        if (lane.record.state !== "failed") {
            fail("lane-refused", `lane ${id} is ${lane.record.state}, and only a failed lane can be retried`, {
                id,
                state: lane.record.state,
            });
        }

        // Re-choose the port: the range has moved on since the lane failed,
        // and the pair it had may now be someone else's.
        const { port: _stale, ...spec } = lane.record.spec;
        this.#lanes.delete(id);
        this.#reserved.delete(id);

        const port = await this.#choosePort(spec);
        if (port !== null) this.#reserved.set(id, port);
        this.#start({ ...spec, id, ...(port === null ? {} : { port }) });
    }

    list(): readonly LaneRecord[] {
        return [...this.#lanes.values()].map((lane) => lane.record);
    }

    subscribe(fn: (records: readonly LaneRecord[]) => void): () => void {
        this.#subscribers.add(fn);
        fn(this.list());
        return () => this.#subscribers.delete(fn);
    }

    /**
     * Cancels every lane at once and waits out one shared deadline.
     *
     * Concurrent rather than sequential, and bounded rather than patient: a
     * wedged browser must not turn quitting into a hang. What is still running
     * past the deadline is counted and reported, and the pool is closed from
     * under it.
     */
    async shutdown(deadlineMs: number): Promise<{ readonly forced: number }> {
        const lanes = [...this.#lanes.values()];
        for (const lane of lanes) lane.control.abort();

        const outstanding = new Set(lanes);
        await Promise.race([
            Promise.all(lanes.map((lane) => lane.finished.then(() => outstanding.delete(lane)))),
            sleep(deadlineMs),
        ]);

        const forced = outstanding.size;
        this.#lanes.clear();
        this.#reserved.clear();
        this.#publish();
        await this.#deps.pool.closeAll();
        return { forced };
    }

    /** Rejects a spec that cannot live beside the lanes already running. */
    #refuseClashes(spec: Omit<LaneSpec, "id">): void {
        for (const { record } of this.#lanes.values()) {
            if (record.state === "failed" || record.state === "closed") continue;

            if (record.spec.document.fileId === spec.document.fileId) {
                fail("lane-refused", `lane ${record.spec.id} already drives that document`, {
                    lane: record.spec.id,
                    fileId: spec.document.fileId,
                });
            }
            if (
                spec.mode === "builtin" &&
                record.spec.mode === "builtin" &&
                record.spec.account.name === spec.account.name
            ) {
                fail(
                    "lane-refused",
                    `lane ${record.spec.id} is already the builtin lane for ${spec.account.name}, ` +
                        `and one MCP token is one plugin slot`,
                    { lane: record.spec.id, account: spec.account.name }
                );
            }
            if (spec.port !== undefined && record.port?.http === spec.port.http) {
                fail("lane-refused", `lane ${record.spec.id} is already on port ${spec.port.http}`, {
                    lane: record.spec.id,
                    port: spec.port.http,
                });
            }
        }
    }

    /** Starts the lane task and registers the record it publishes through. */
    #start(spec: LaneSpec): void {
        const control = new AbortController();
        const record: LaneRecord = { spec, state: "opening", since: this.#now() };

        const finished = this.#run(spec, this.#deps, (event) => this.#onEvent(spec.id, event), control.signal);

        this.#lanes.set(spec.id, { record, control, finished });
        this.#publish();
    }

    /** Mirrors a lane's transition into the record the TUI renders. */
    #onEvent(id: string, event: LaneEvent): void {
        if (event.state === "opening") {
            this.#set(id, { state: "opening", detail: event.detail });
        } else if (event.state === "connected") {
            this.#set(id, {
                state: "connected",
                clientUrl: event.clientUrl,
                ...(event.port === undefined ? {} : { port: event.port }),
                detail: undefined,
            });
        } else {
            this.#set(id, { state: "failed", error: event.reason, log: event.log, detail: undefined });
        }
        this.#publish();
    }

    #set(id: string, patch: Partial<LaneRecord> & { state: LaneState }): void {
        const lane = this.#lanes.get(id);
        if (lane === undefined) return;

        const since = lane.record.state === patch.state ? lane.record.since : this.#now();
        lane.record = { ...lane.record, ...patch, since };
    }

    #publish(): void {
        const records = this.list();
        for (const fn of this.#subscribers) fn(records);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
