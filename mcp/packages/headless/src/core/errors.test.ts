import test from "node:test";
import assert from "node:assert/strict";

import { fail, isLauncherError, LauncherError, type ErrorCode } from "./errors.ts";

// This file doubles as the toolchain's own test. It imports a sibling module by
// its .ts extension and uses type-only syntax, so a run that passes proves Node
// strips types and resolves the extensions we write -- the two assumptions the
// no-build-step decision rests on (SPEC section 8).

test("a launcher error carries its code and detail", () => {
    const err = new LauncherError("port-busy", "4602 is already serving", { port: 4602 });

    assert.equal(err.code, "port-busy");
    assert.equal(err.detail.port, 4602);
    assert.equal(err.message, "4602 is already serving");
    assert.equal(err.name, "LauncherError");
    assert.ok(err instanceof Error);
});

test("detail defaults to empty rather than undefined", () => {
    assert.deepEqual(new LauncherError("unreachable", "nothing answers").detail, {});
});

test("isLauncherError separates refusals from bugs", () => {
    assert.ok(isLauncherError(new LauncherError("lane-refused", "already driving that file")));
    assert.ok(!isLauncherError(new TypeError("undefined is not a function")));
    assert.ok(!isLauncherError("port-busy"));
    assert.ok(!isLauncherError(null));
});

test("fail throws the error it describes", () => {
    const code: ErrorCode = "mode-not-implemented";

    assert.throws(
        () => fail(code, "builtin lanes are deferred", { mode: "builtin" }),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.equal(err.code, "mode-not-implemented");
            assert.equal(err.detail.mode, "builtin");
            return true;
        }
    );
});
