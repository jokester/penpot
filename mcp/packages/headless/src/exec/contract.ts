// One suite every ExecBackend must pass.
//
// The point is the Kubernetes move. A backend that satisfies this -- start a
// process, see its port listening, expose it, kill it, see the port released --
// can be swapped under the supervisor without touching a lane, and that claim
// is worth a test rather than a paragraph.

import test from "node:test";
import assert from "node:assert/strict";

import type { ExecBackend } from "./backend.ts";

/** What a backend needs to supply for the shared suite to drive it. */
export interface ContractHarness {
    readonly backend: ExecBackend;
    /** A command and environment that makes `port` listen inside the container. */
    serverFor(port: number): { argv: string[]; env: Record<string, string> };
    /** A local port the backend currently considers free. */
    freePort(): Promise<number>;
    /**
     * The in-container port behind a local one.
     *
     * The suite needs both spaces: it asks the backend to expose a local port
     * and then asks the container what is listening, and those are the same
     * number only when the deployment publishes one-to-one. Identity is the
     * right answer for a harness with no mapping.
     */
    upstreamOf(local: number): number;
    /** A port nothing will ever answer on, for the unreachable case. */
    deadPort(): number;
    /**
     * Tears down whatever the suite started.
     *
     * Takes the pids rather than tracking them itself, so a test that fails
     * halfway still leaves the container clean -- which matters when the
     * container is the operator's real one.
     */
    cleanup(startedPids: readonly number[]): Promise<void>;
}

/** Waits until `check` holds, or fails the test saying what never happened. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) assert.fail(`${what} did not happen within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** Registers the shared lifecycle suite for one backend. */
export function execBackendContract(name: string, make: () => Promise<ContractHarness>): void {
    test(`${name}: a started process listens, exposes, and releases its port`, async () => {
        const h = await make();
        const { backend } = h;
        const control = new AbortController();
        const started: number[] = [];

        try {
            const port = await h.freePort();
            const inContainer = h.upstreamOf(port);
            assert.ok(!(await backend.listening()).includes(inContainer), "the chosen port should start free");

            const { argv, env } = h.serverFor(port);
            const proc = await backend.start(argv, env, control.signal);
            started.push(proc.pid);

            assert.ok(Number.isInteger(proc.pid) && proc.pid > 0, `expected an in-container pid, got ${proc.pid}`);

            await until("the port to start listening", async () => (await backend.listening()).includes(inContainer));

            const exposure = await backend.expose(port, control.signal);
            assert.ok(exposure.url.includes(String(port)), `expected ${exposure.url} to name port ${port}`);

            await exposure.close();
            await exposure.close(); // closing twice is not an error

            await backend.kill(proc.pid);
            await until("the port to be released", async () => !(await backend.listening()).includes(inContainer));
        } finally {
            control.abort();
            await h.cleanup(started);
        }
    });

    test(`${name}: exposing a port nothing serves is refused`, async () => {
        // The case that caught a real bug: under compose, Docker's proxy
        // accepts a TCP connection on every published port whether or not
        // anything is behind it, so a connect-based check called an empty port
        // reachable. Only an exchange distinguishes.
        const h = await make();
        try {
            await assert.rejects(() => h.backend.expose(h.deadPort(), AbortSignal.timeout(20_000)));
        } finally {
            await h.cleanup([]);
        }
    });
}
