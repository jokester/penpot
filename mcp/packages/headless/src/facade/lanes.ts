// Lanes, as the lease registry needs to see them.
//
// The bridge between the façade and the supervisor: the façade asks for a
// document, the supervisor opens a lane, and this waits for it to be connected
// before handing it back. Waiting here is what makes `connect_doc` blocking,
// which is deliberate -- an agent that gets a fast success and then a slow
// first call reads the second as a hang.

import type { Account } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import type { DocumentRef } from "../core/target.ts";
import type { LaneSupervisor } from "../supervisor/supervisor.ts";
import type { Backend } from "./facade.ts";
import type { LaneHandle, LaneSource } from "./leases.ts";

/**
 * Clears the lane's scratchpad.
 *
 * `storage` is one object per tab and the agent is told to use it
 * "extensively... across tool calls", so a lane handed to the next holder
 * without this is a channel between two clients.
 */
const WIPE_CODE = "for (const key of Object.keys(storage)) delete storage[key]; return Object.keys(storage).length;";

export interface SupervisorLaneOptions {
    /**
     * The worker pool, in preference order.
     *
     * One lane takes one worker and holds it until the lane closes, so this is
     * a ceiling on concurrent documents alongside the port range. Separate
     * identities are the point: two agents editing adjacent documents as the
     * same Penpot user see each other's presence and selections, which reads
     * as the application misbehaving.
     */
    readonly accounts: readonly Account[];
    readonly flavour: string;
    /**
     * Show the browser for the lanes the façade opens.
     *
     * The only way to watch those: nothing names them on a command line, so
     * --headed cannot reach them and the setting has to come from the file.
     */
    readonly headed?: boolean;
    /** The X display headed lanes go on. Required when `headed`. */
    readonly display?: string;
    /** How long to wait for a lane to reach connected before giving up. */
    readonly openTimeoutMs?: number;
}

/** Builds a `LaneSource` over the supervisor the launcher already runs. */
export function supervisorLanes(
    supervisor: LaneSupervisor,
    backend: Backend,
    options: SupervisorLaneOptions
): LaneSource {
    const openTimeoutMs = options.openTimeoutMs ?? 180_000;
    /** Which worker each open lane holds, so it is free again when it closes. */
    const held = new Map<string, string>();

    /** The first worker nobody is using, preferring the eligible ones. */
    function take(eligible: readonly string[]): Account {
        const busy = new Set(held.values());
        const allowed =
            eligible.length === 0
                ? options.accounts
                : options.accounts.filter((account) => eligible.includes(account.name));

        if (allowed.length === 0) {
            fail("lane-refused", `no configured worker can see that document; tried ${eligible.join(", ")}`, {});
        }

        const free = allowed.find((account) => !busy.has(account.name));
        if (free === undefined) {
            // Distinct from the registry's own capacity refusal, and worth its
            // own words: the lanes are free and the workers are not, which is
            // fixed by provisioning another worker rather than by waiting.
            fail(
                "lane-refused",
                `every worker is already driving a document (${allowed.length} configured); ` +
                    `provision another to raise the ceiling`,
                { workers: allowed.length }
            );
        }
        return free;
    }

    return {
        async open(document: DocumentRef, eligible: readonly string[], signal: AbortSignal): Promise<LaneHandle> {
            const account = take(eligible);
            const id = await supervisor.open({
                account,
                document,
                mode: "exec",
                headed: options.headed ?? false,
                flavour: options.flavour,
                ...(options.headed === true && options.display !== undefined ? { display: options.display } : {}),
            });
            held.set(id, account.name);

            const clientUrl = await settled(supervisor, id, openTimeoutMs, signal).catch(async (err: unknown) => {
                // A lane that never connected is not left behind for the idle
                // sweep to find; it is ended here, where the failure is known.
                held.delete(id);
                await supervisor.close(id).catch(() => undefined);
                throw err;
            });

            return { id, clientUrl };
        },

        async close(id: string): Promise<void> {
            held.delete(id);
            await supervisor.close(id).catch(() => undefined);
        },

        async wipe(lane: LaneHandle, signal: AbortSignal): Promise<void> {
            await backend.call(lane.clientUrl, "execute_code", { code: WIPE_CODE }, signal);
        },
    };
}

/**
 * Resolves with the lane's client URL once it is connected, or throws.
 *
 * Subscribes rather than polls, so the wait ends the moment the transition
 * happens rather than at the next tick of something.
 */
function settled(supervisor: LaneSupervisor, id: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const finish = (fn: () => void) => {
            clearTimeout(timer);
            unsubscribe();
            signal.removeEventListener("abort", onAbort);
            fn();
        };

        const onAbort = () => finish(() => reject(new Error("cancelled while opening the lane")));
        const timer = setTimeout(
            () => finish(() => reject(new Error(`the lane did not connect within ${Math.round(timeoutMs / 1000)}s`))),
            timeoutMs
        );

        const unsubscribe = supervisor.subscribe((records) => {
            const record = records.find((candidate) => candidate.spec.id === id);
            if (record === undefined) return;

            if (record.state === "connected" && record.clientUrl !== undefined) {
                const url = record.clientUrl;
                finish(() => resolve(url));
            } else if (record.state === "failed") {
                const reason = record.error ?? "the lane failed";
                finish(() => reject(new Error(reason)));
            }
        });

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * How many lanes can run at once: whichever of ports and workers runs out first.
 *
 * Both are real ceilings and they fail differently, so the smaller one is the
 * capacity and the two refusals stay distinct -- "every lane is busy" is
 * waited out, "every worker is busy" is fixed by provisioning another.
 */
export function laneCapacity(range: { lo: number; hi: number }, workers = Number.POSITIVE_INFINITY): number {
    const pairs = Math.floor((range.hi - range.lo + 1) / 2);
    if (pairs < 1) fail("not-configured", `the published range ${range.lo}-${range.hi} has room for no lanes`, {});
    if (workers < 1) fail("not-configured", `no worker accounts are configured, so no lane can be opened`, {});
    return Math.min(pairs, workers);
}
