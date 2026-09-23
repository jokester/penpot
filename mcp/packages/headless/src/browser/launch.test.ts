import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccountRef } from "../core/target.ts";
import { samePorts, wire } from "../core/topology.ts";
import { flavourOf, playwrightLaunch } from "./launch.ts";
import { LeasingPool, type LeaseInit } from "./pool.ts";

/** These start a real browser, so they are opt in. */
const E2E = process.env.MCP_HEADLESS_E2E === "1";

function scratchAccount(): AccountRef {
    return {
        name: "launch-test",
        origin: "http://localhost:9001",
        profileDir: mkdtempSync(join(tmpdir(), "mcp-headless-profile-")),
    };
}

const initFor = (account: AccountRef, port: number): LeaseInit => ({
    account,
    wiring: wire("exec", account, samePorts({ http: port, ws: port + 1 })),
    url: "about:blank",
});

if (!E2E) {
    test("browser launch tests are skipped without MCP_HEADLESS_E2E=1", { skip: true }, () => undefined);
} else {
    test("three tabs in one browser boot with three different injected sockets", async () => {
        // The measurement the whole pool rests on. If addInitScript were scoped
        // to the context rather than the page, lanes could not share a browser
        // at all and each would need its own 527 MB.
        const { chromium } = await import("playwright");
        const account = scratchAccount();
        const context = await chromium.launchPersistentContext(account.profileDir, { headless: true });

        try {
            const read: unknown[] = [];
            for (const uri of ["ws://localhost:4602", "ws://localhost:4604", "ws://localhost:4606"]) {
                const page = await context.newPage();
                await page.addInitScript((value: string) => {
                    (globalThis as unknown as { penpotMcpServerURI: string }).penpotMcpServerURI = value;
                }, uri);
                await page.goto("about:blank");
                read.push(
                    await page.evaluate(() => (globalThis as { penpotMcpServerURI?: string }).penpotMcpServerURI)
                );
            }

            assert.deepEqual(read, ["ws://localhost:4602", "ws://localhost:4604", "ws://localhost:4606"]);
            assert.equal(context.pages().length >= 3, true);
        } finally {
            await context.close();
            rmSync(account.profileDir, { recursive: true, force: true });
        }
    });

    test("the pool opens real tabs and leaves no browser behind", async () => {
        const account = scratchAccount();
        const pool = new LeasingPool(playwrightLaunch({}));
        const key = { account: account.name, headed: false, flavour: flavourOf({}) };

        try {
            const a = await pool.lease(key, initFor(account, 4601), AbortSignal.timeout(60_000));
            const b = await pool.lease(key, initFor(account, 4603), AbortSignal.timeout(60_000));

            assert.equal(pool.open, 1, "two lanes on one key should share one browser");

            // Nothing is serving these ports, so the plugin never dials.
            assert.equal(await a.waitForPlugin(200, AbortSignal.timeout(5_000)), null);

            await a.close();
            assert.equal(pool.open, 1, "the browser should outlive its first lease");

            await b.close();
            assert.equal(pool.open, 0);
        } finally {
            await pool.closeAll();
            rmSync(account.profileDir, { recursive: true, force: true });
        }
    });
}
