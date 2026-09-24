import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseConf } from "./conf.ts";
import { isLauncherError } from "./errors.ts";

const FULL = `
penpot:
  url: http://127.0.0.1:9001

workerUsers:
  - name: worker-a
    email: worker-a@penpot.local
    fullName: worker a
  - email: worker-b@penpot.local

mcpFacade:
  host: 0.0.0.0
  port: 4600

mcpBackend:
  type: kubectl
  hostname: 127.0.0.1
  portRange: 5601-5608
  upstreamPortRange: 4601-4608
  exposure: port-forward
  kubectl:
    namespace: penpot
    selector: app=penpot-mcp

browserBackend:
  type: local
`;

function refuses(text: string, contains: string): void {
    assert.throws(
        () => parseConf(text),
        (err: unknown) => {
            assert.ok(isLauncherError(err), `expected a LauncherError, got ${String(err)}`);
            assert.ok(err.message.includes(contains), err.message);
            return true;
        }
    );
}

test("the whole file reads back as the launcher's own types", async () => {
    const conf = parseConf(FULL);

    assert.equal(conf.penpotUrl, "http://127.0.0.1:9001");
    assert.deepEqual(conf.facade, { host: "0.0.0.0", port: 4600 });
    assert.equal(conf.mcpBackend?.type, "kubectl");
    assert.deepEqual(conf.mcpBackend?.portRange, { lo: 5601, hi: 5608 });
    assert.deepEqual(conf.mcpBackend?.upstreamPortRange, { lo: 4601, hi: 4608 });
    assert.equal(conf.mcpBackend?.exposure, "port-forward");
    assert.equal(conf.mcpBackend?.kubectl?.selector, "app=penpot-mcp");
    assert.equal(conf.browser.type, "local");
});

test("a worker's name defaults to the local part of its email", async () => {
    // The default provisioning used before this file existed, so an account
    // file written then still matches the worker named here.
    const conf = parseConf(FULL);

    assert.deepEqual(
        conf.workerUsers.map((worker) => worker.name),
        ["worker-a", "worker-b"]
    );
    assert.equal(conf.workerUsers[0]?.fullName, "worker a");
    assert.equal(conf.workerUsers[1]?.fullName, undefined);
});

test("the worker order is the file's order", async () => {
    // Load-bearing: the first worker with a token answers the document-free
    // tools, so this is the operator's preference and not a map's iteration.
    const conf = parseConf(`
workerUsers:
  - email: zeta@penpot.local
  - email: alpha@penpot.local
`);

    assert.deepEqual(
        conf.workerUsers.map((worker) => worker.name),
        ["zeta", "alpha"]
    );
});

test("a mistyped key is refused rather than ignored", async () => {
    // The worst failure a hand-written file has: a setting that reads as
    // present, is understood by nobody, and changes nothing.
    refuses("mcpFacde:\n  port: 4600\n", "unknown key mcpFacde");
    refuses("mcpBackend:\n  type: kubectl\n  portRange: 4601-4608\n  namespace: penpot\n", "unknown key namespace");
});

test("the key that used to describe the PREPL is refused by name", async () => {
    // It named a route provisioning does not take: a profile is created by
    // exec'ing manage.py, so nothing here dials 6063.
    refuses("penpotBackend:\n  hostname: localhost\n  port: 6063\n", "unknown key penpotBackend");
});

test("a port range is written lo-hi, and a list says so", async () => {
    refuses("mcpBackend:\n  type: kubectl\n  portRange: [4601, 4608]\n", "not as a list");
    refuses("mcpBackend:\n  type: kubectl\n  portRange: 4601..4608\n", "must look like 4601-4608");
});

test("two workers cannot share one account file", async () => {
    refuses(
        "workerUsers:\n  - {name: w, email: a@x.test}\n  - {name: w, email: b@x.test}\n",
        "they would share an account file"
    );
});

test("kubectl without a namespace is refused where the line is", async () => {
    refuses(
        "mcpBackend:\n  type: kubectl\n  portRange: 4601-4608\n  kubectl:\n    selector: app=penpot-mcp\n",
        "mcpBackend.kubectl.namespace"
    );
});

test("a compose backend needs its own block, not kubectl's", async () => {
    refuses(
        "mcpBackend:\n  type: docker-compose\n  portRange: 4601-4608\n  kubectl:\n    namespace: penpot\n" +
            "    selector: app=penpot-mcp\n",
        "mcpBackend.dockerCompose must be a block"
    );
});

test("exposure defaults to none, which is the deployment worth having", async () => {
    const conf = parseConf(
        "mcpBackend:\n  type: kubectl\n  portRange: 4601-4608\n  kubectl:\n    namespace: penpot\n" +
            "    selector: app=penpot-mcp\n"
    );

    assert.equal(conf.mcpBackend?.exposure, "none");
    assert.equal(conf.mcpBackend?.hostname, "127.0.0.1");
});

test("a container browser is refused as not built, not as unknown", async () => {
    refuses("browserBackend:\n  type: container\n", "documented but not built");
});

test("an empty file is a file with nothing in it, not an error", async () => {
    // A configuration directory that has the file and has not filled it in
    // yet should behave exactly as one that has no file.
    assert.deepEqual(parseConf(""), { workerUsers: [], browser: { type: "local", headed: false } });
});

test("broken YAML names the file and the first thing wrong with it", async () => {
    refuses("workerUsers:\n  - name: a\n   email: b\n", "is not valid YAML");
});

test("the committed template parses, and is the shape the docs describe", async () => {
    // The template is what an operator copies. A template that does not parse
    // is worse than none, and it is exactly the file nothing else tests.
    const path = resolve(import.meta.dirname, "../../conf.template.yaml");
    const conf = parseConf(readFileSync(path, "utf8"), "conf.template.yaml");

    assert.ok(conf.mcpBackend !== undefined, "the template should describe a backend");
    assert.ok(conf.workerUsers.length > 0, "the template should name at least one worker");
});

test("the browser can be asked to show itself", async () => {
    // The only way to watch the lanes the façade opens: nothing names them on
    // a command line, so --headed cannot reach them.
    const conf = parseConf(`
browserBackend:
    type: local
    headed: true
    display: ":3"
    channel: chrome
    args: ["--force-device-scale-factor=1"]
`);

    assert.equal(conf.browser.headed, true);
    assert.equal(conf.browser.display, ":3");
    assert.equal(conf.browser.channel, "chrome");
    assert.deepEqual(conf.browser.args, ["--force-device-scale-factor=1"]);
});

test("a browser block with nothing in it is headless, like no block at all", async () => {
    assert.deepEqual(parseConf("browserBackend:\n    type: local\n").browser, { type: "local", headed: false });
});

test("headed must be a boolean, not the string true", async () => {
    // YAML makes this easy to get wrong: quoting it gives a string, and a
    // truthy string would silently mean the opposite of what "false" reads as.
    refuses('browserBackend:\n    headed: "false"\n', "browserBackend.headed must be true or false");
});

test("browser arguments are a list of strings", async () => {
    refuses("browserBackend:\n    args: --no-sandbox\n", "browserBackend.args must be a list");
    refuses("browserBackend:\n    args: [1, 2]\n", "browserBackend.args[0] must be a non-empty string");
});
