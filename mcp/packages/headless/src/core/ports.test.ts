import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError, type ErrorCode } from "./errors.ts";
import { allocate, assertUsable, describeRange, free, type PortRange } from "./ports.ts";

/** The range deploy/home-cluster publishes today. */
const RANGE: PortRange = { lo: 4601, hi: 4608 };

function refuses(fn: () => unknown, code: ErrorCode, detail?: Record<string, string | number>): void {
    assert.throws(fn, (err: unknown) => {
        assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
        assert.equal(err.code, code);
        for (const [key, value] of Object.entries(detail ?? {})) assert.equal(err.detail[key], value);
        return true;
    });
}

test("an empty range hands out its lowest pair", () => {
    assert.deepEqual(allocate(RANGE, []), { http: 4601, ws: 4602 });
});

test("a busy pair is skipped whole", () => {
    assert.deepEqual(allocate(RANGE, [4601, 4602]), { http: 4603, ws: 4604 });
});

test("a pair is skipped when only its WebSocket half is busy", () => {
    // The bug this protects: the HTTP port binds IPv4 and the WebSocket binds
    // IPv6, so a probe that read only /proc/net/tcp reported every WebSocket
    // port as free. The allocator then handed out 4601 while 4602 was already
    // serving, and the second server half-worked (invariant 4).
    assert.deepEqual(allocate(RANGE, [4602]), { http: 4603, ws: 4604 });
});

test("allocation walks the whole range before giving up", () => {
    assert.deepEqual(allocate(RANGE, [4601, 4602, 4603, 4604, 4605, 4606]), { http: 4607, ws: 4608 });
});

test("an exhausted range is refused, and the message says what is left", () => {
    refuses(() => allocate(RANGE, [4601, 4602, 4603, 4604, 4605, 4606, 4607]), "range-exhausted", {
        range: "4601-4608",
        free: "4608",
    });
    refuses(() => allocate({ lo: 4601, hi: 4602 }, [4601]), "range-exhausted", { free: "4602" });
});

test("an odd-sized range leaves its last port unusable", () => {
    // 4607 has no partner inside 4601-4607, so the range holds three pairs.
    assert.deepEqual(allocate({ lo: 4601, hi: 4607 }, [4601, 4603]), { http: 4605, ws: 4606 });
    refuses(() => allocate({ lo: 4601, hi: 4607 }, [4601, 4603, 4605]), "range-exhausted", {
        free: "4602 4604 4606 4607",
    });
});

test("a range too small for any pair is refused rather than looping", () => {
    refuses(() => allocate({ lo: 4601, hi: 4601 }, []), "range-exhausted");
});

test("a nonsensical range names the configuration", () => {
    refuses(() => allocate({ lo: 4608, hi: 4601 }, []), "not-configured");
    refuses(() => allocate({ lo: 0, hi: 4608 }, []), "not-configured");
    refuses(() => allocate({ lo: 4601, hi: 70000 }, []), "not-configured");
    refuses(() => free({ lo: 4601.5, hi: 4608 }, []), "not-configured");
});

test("free lists what is left, ascending", () => {
    assert.deepEqual(free(RANGE, [4603, 4601, 4604]), [4602, 4605, 4606, 4607, 4608]);
    assert.deepEqual(free({ lo: 4601, hi: 4602 }, [4601, 4602]), []);
});

test("a chosen pair inside the range and free is accepted", () => {
    assert.equal(assertUsable({ http: 4605, ws: 4606 }, RANGE, [4601, 4602]), undefined);
});

test("a chosen port outside the published range is refused", () => {
    // The failure this names: --port 4701 started a server that worked
    // perfectly and that nothing on this host could reach (invariant 3).
    refuses(() => assertUsable({ http: 4701, ws: 4702 }, RANGE, []), "port-out-of-range", {
        role: "HTTP",
        port: 4701,
        range: "4601-4608",
    });
    refuses(() => assertUsable({ http: 4608, ws: 4609 }, RANGE, []), "port-out-of-range", { role: "WebSocket" });
});

test("a chosen port already serving is refused, and the message lists the free ones", () => {
    refuses(() => assertUsable({ http: 4601, ws: 4602 }, RANGE, [4601, 4602, 4603]), "port-busy", {
        role: "HTTP",
        port: 4601,
        free: "4604 4605 4606 4607 4608",
    });
    refuses(() => assertUsable({ http: 4603, ws: 4604 }, RANGE, [4604]), "port-busy", {
        role: "WebSocket",
        port: 4604,
    });
});

test("one port cannot serve as both halves", () => {
    refuses(() => assertUsable({ http: 4601, ws: 4601 }, RANGE, []), "not-configured", { port: 4601 });
});

test("a chosen pair need not be adjacent, only reachable and free", () => {
    // allocate always pairs n with n+1, but an operator who published an odd
    // arrangement is not second-guessed; reachability is the actual rule.
    assert.equal(assertUsable({ http: 4601, ws: 4608 }, RANGE, []), undefined);
});

test("describeRange is what the messages and the TUI both print", () => {
    assert.equal(describeRange(RANGE), "4601-4608");
});
