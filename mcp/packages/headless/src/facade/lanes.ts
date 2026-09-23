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
    readonly account: Account;
    readonly flavour: string;
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

    return {
        async open(document: DocumentRef, signal: AbortSignal): Promise<LaneHandle> {
            const id = await supervisor.open({
                account: options.account,
                document,
                mode: "exec",
                headed: false,
                flavour: options.flavour,
            });

            const clientUrl = await settled(supervisor, id, openTimeoutMs, signal).catch(async (err: unknown) => {
                // A lane that never connected is not left behind for the idle
                // sweep to find; it is ended here, where the failure is known.
                await supervisor.close(id).catch(() => undefined);
                throw err;
            });

            return { id, clientUrl };
        },

        async close(id: string): Promise<void> {
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

/** How many lanes the deployment's published range allows. */
export function laneCapacity(range: { lo: number; hi: number }): number {
    const pairs = Math.floor((range.hi - range.lo + 1) / 2);
    if (pairs < 1) fail("not-configured", `the published range ${range.lo}-${range.hi} has room for no lanes`, {});
    return pairs;
}
