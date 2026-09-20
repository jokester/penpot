import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_COLUMNS } from "../core/columns.ts";
import type { Account, Settings } from "../core/config.ts";
import { applyKey, commandFor, focused, newForm, toFormState, toSpec, whyNot } from "./form.ts";

const FILE = "0a1b2c3d-4444-4555-8666-777788889999";
const TEAM = "fdbdf01d-1111-4222-8333-444455556666";

const account = (name: string, withDocument: boolean): Account => ({
    name,
    origin: "http://localhost:9001",
    profileDir: `/tmp/profile-${name}`,
    ...(withDocument ? { defaultDocument: { fileId: FILE, teamId: TEAM } } : {}),
});

function settings(...accounts: Account[]): Settings {
    return { accounts: new Map(accounts.map((a) => [a.name, a])), tui: { columns: DEFAULT_COLUMNS, statusBar: true } };
}

const ONE = settings(account("mcp-worker", true));
const TWO = settings(account("mcp-worker", true), account("second", false));

/** Types a string, one key at a time, the way the loop would. */
function type(model: ReturnType<typeof newForm>, text: string) {
    let current = model;
    for (const char of text) current = applyKey(current, { sequence: char }).model;
    return current;
}

test("the form is prefilled from the account's own document", () => {
    // Typing a uuid by hand is what the old tooling required, and it is where
    // blank ids came from.
    const model = newForm(ONE);

    assert.equal(model.accounts[model.accountIndex], "mcp-worker");
    assert.equal(model.fileId, FILE);
    assert.equal(model.teamId, TEAM);
    assert.equal(whyNot(model), null);
});

test("an account with no document leaves the ids to be typed", () => {
    const model = newForm(settings(account("fresh", false)));

    assert.equal(model.fileId, "");
    assert.equal(whyNot(model), "a file id is needed");
});

test("no accounts at all is said plainly rather than shown as an empty picker", () => {
    assert.equal(whyNot(newForm(settings())), "no accounts configured; see --help for where they live");
});

test("the cursor walks the fields and wraps", () => {
    let model = newForm(ONE);
    assert.equal(focused(model), "account");

    model = applyKey(model, { name: "down" }).model;
    assert.equal(focused(model), "document");

    model = applyKey(model, { name: "tab" }).model;
    assert.equal(focused(model), "team");

    model = applyKey(model, { name: "down" }).model;
    assert.equal(focused(model), "browser");

    model = applyKey(model, { name: "down" }).model;
    assert.equal(focused(model), "account", "the cursor should wrap");

    model = applyKey(model, { name: "up" }).model;
    assert.equal(focused(model), "browser");
});

test("left and right cycle the account", () => {
    let model = newForm(TWO);
    assert.equal(model.accounts[model.accountIndex], "mcp-worker");

    model = applyKey(model, { name: "right" }).model;
    assert.equal(model.accounts[model.accountIndex], "second");

    model = applyKey(model, { name: "right" }).model;
    assert.equal(model.accounts[model.accountIndex], "mcp-worker", "it should wrap");
});

test("typing goes into the focused id field, and only hex", () => {
    let model = { ...newForm(ONE), fileId: "", teamId: "", cursor: 1 };
    model = type(model, "0a1b");

    assert.equal(model.fileId, "0a1b");
    assert.equal(model.teamId, "");

    // A stray letter is a slip, not input: ids are hex and dashes.
    model = type(model, "zq!");
    assert.equal(model.fileId, "0a1b");

    model = applyKey(model, { name: "backspace" }).model;
    assert.equal(model.fileId, "0a1");
});

test("typing while the account field is focused changes nothing", () => {
    const model = type(newForm(ONE), "abc");

    assert.equal(model.fileId, FILE, "the prefilled id should not be appended to");
});

test("space toggles the browser, wherever the cursor is not", () => {
    const browser = { ...newForm(ONE), cursor: 3 };

    assert.equal(applyKey(browser, { name: "space" }).model.headed, true);
    assert.equal(applyKey(newForm(ONE), { name: "space" }).model.headed, false);
});

test("enter submits and escape cancels", () => {
    assert.equal(applyKey(newForm(ONE), { name: "return" }).submit, true);
    assert.equal(applyKey(newForm(ONE), { name: "escape" }).cancel, true);
    assert.equal(applyKey(newForm(ONE), { name: "down" }).submit, undefined);
});

test("the form renders the command it is equivalent to", () => {
    const state = toFormState(newForm(ONE));

    assert.equal(state.command, `mcp-headless --no-tui --account mcp-worker --file-id ${FILE} --team-id ${TEAM}`);
    assert.equal(state.error, undefined);
    assert.equal(state.fields.length, 4);
});

test("an incomplete form says why it cannot be submitted", () => {
    const state = toFormState({ ...newForm(ONE), teamId: "" });

    assert.ok(state.error?.includes("team id"), state.error ?? "no error was reported");
    assert.ok(commandFor({ ...newForm(ONE), teamId: "" }).includes("--team-id UUID"));
});

test("--headed appears in the command once the browser is toggled", () => {
    assert.ok(commandFor({ ...newForm(ONE), headed: true }).endsWith("--headed"));
});

test("a complete form becomes a lane spec", () => {
    const spec = toSpec(newForm(ONE), ONE, "default");

    assert.equal(spec.account.name, "mcp-worker");
    assert.deepEqual(spec.document, { fileId: FILE, teamId: TEAM });
    assert.equal(spec.mode, "exec");
    assert.equal(spec.headed, false);
    assert.equal(spec.flavour, "default");
});

test("an incomplete form refuses to become one", () => {
    assert.throws(() => toSpec({ ...newForm(ONE), fileId: "" }, ONE, "default"), /file id is needed/);
});
