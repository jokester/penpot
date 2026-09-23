import test from "node:test";
import assert from "node:assert/strict";

import { isLauncherError } from "../core/errors.ts";
import { DEFAULT_ADDRESS, facadeAddress, isLoopback, parseListen } from "./address.ts";

const NO_ENV: NodeJS.ProcessEnv = {};

test("--listen takes a port, a host and port, or just a colon and port", () => {
    assert.deepEqual(parseListen("4400"), { port: 4400 });
    assert.deepEqual(parseListen(":4400"), { port: 4400 });
    assert.deepEqual(parseListen("127.0.0.1:4400"), { host: "127.0.0.1", port: 4400 });
    assert.deepEqual(parseListen("0.0.0.0:9999"), { host: "0.0.0.0", port: 9999 });
    assert.deepEqual(parseListen("  :4400 "), { port: 4400 });
});

test("--listen refuses something that is not an address", () => {
    for (const bad of ["", "   ", "nope", "127.0.0.1:nope", ":0", ":70000"]) {
        assert.throws(
            () => parseListen(bad),
            (err: unknown) => isLauncherError(err),
            `expected ${JSON.stringify(bad)} to be refused`
        );
    }
});

test("the default is loopback, because there is no auth on this endpoint", () => {
    assert.deepEqual(facadeAddress(undefined, NO_ENV), DEFAULT_ADDRESS);
    assert.deepEqual(DEFAULT_ADDRESS, { host: "127.0.0.1", port: 4400 });
});

test("HOST and PORT are honoured, together or apart", () => {
    assert.deepEqual(facadeAddress(undefined, { PORT: "5000" }), { host: "127.0.0.1", port: 5000 });
    assert.deepEqual(facadeAddress(undefined, { HOST: "0.0.0.0" }), { host: "0.0.0.0", port: 4400 });
    assert.deepEqual(facadeAddress(undefined, { HOST: "0.0.0.0", PORT: "5000" }), { host: "0.0.0.0", port: 5000 });
});

test("the flag wins over the environment, field by field", () => {
    const env = { HOST: "0.0.0.0", PORT: "5000" };

    assert.deepEqual(facadeAddress({ port: 4400 }, env), { host: "0.0.0.0", port: 4400 });
    assert.deepEqual(facadeAddress({ host: "127.0.0.1" }, env), { host: "127.0.0.1", port: 5000 });
    assert.deepEqual(facadeAddress({ host: "::1", port: 1234 }, env), { host: "::1", port: 1234 });
});

test("an empty HOST or PORT is ignored rather than obeyed", () => {
    // Exporting an empty variable is a common accident in a shell script.
    assert.deepEqual(facadeAddress(undefined, { HOST: "", PORT: "  " }), DEFAULT_ADDRESS);
});

test("a PORT that is not a port is refused rather than silently defaulted", () => {
    assert.throws(
        () => facadeAddress(undefined, { PORT: "nope" }),
        (err: unknown) => isLauncherError(err)
    );
});

test("loopback is recognised, so a wider bind can be warned about", () => {
    // zsh keeps a HOST parameter set to the hostname and does not export it,
    // but anything that did would move the façade off loopback silently.
    assert.ok(isLoopback("127.0.0.1"));
    assert.ok(isLoopback("::1"));
    assert.ok(isLoopback("localhost"));
    assert.ok(!isLoopback("0.0.0.0"));
    assert.ok(!isLoopback("twlight-sparkle"));
    assert.ok(!isLoopback("192.168.100.200"));
});
