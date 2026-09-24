import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_COLUMNS } from "../core/columns.ts";
import type { Account, Settings } from "../core/config.ts";
import type { AccountCatalogue, DocumentChoice } from "../penpot/catalogue.ts";
import {
    accountName,
    applyKey,
    chosenDocument,
    commandFor,
    fields,
    focused,
    newForm,
    toFormState,
    toSpec,
    whyNot,
    withDocuments,
    type FormModel,
} from "./form.ts";

const FILE = "0a1b2c3d-4444-4555-8666-777788889999";
const TEAM = "fdbdf01d-1111-4222-8333-444455556666";

const account = (name: string, withDocument: boolean): Account => ({
    name,
    origin: "http://localhost:9001",
    profileDir: `/tmp/profile-${name}`,
    ...(withDocument ? { defaultDocument: { fileId: FILE, teamId: TEAM } } : {}),
});

function settings(...accounts: Account[]): Settings {
    return {
        accounts: new Map(accounts.map((a) => [a.name, a])),
        tui: { columns: DEFAULT_COLUMNS, statusBar: true },
        workers: [],
        browser: { type: "local" as const, headed: false },
    };
}

const ONE = settings(account("mcp-worker", true));
const TWO = settings(account("mcp-worker", true), account("second", false));
const BARE = settings(account("bare", false));

const choice = (fileId: string, fileName: string, teamName = "ihate-workspace"): DocumentChoice => ({
    fileId,
    teamId: TEAM,
    fileName,
    teamName,
    modifiedAt: "2026-09-20T00:00:00Z",
});

const LISTED: AccountCatalogue = {
    documents: [choice("f-diagrams", "diagrams"), choice(FILE, "worker-scratch", "Default"), choice("f-v", "viewer")],
    problem: null,
};

/** The keys a person would press, in order. */
function press(model: FormModel, ...keys: (string | { name?: string; sequence?: string })[]) {
    let current = model;
    let last = applyKey(current, {});

    for (const key of keys) {
        last = applyKey(current, typeof key === "string" ? { name: key } : key);
        current = last.model;
    }
    return { model: current, result: last };
}

/** Types a string one character at a time. */
function type(model: FormModel, text: string): FormModel {
    let current = model;
    for (const char of text) current = applyKey(current, { sequence: char }).model;
    return current;
}

const labels = (model: FormModel) => fields(model).map((f) => f.key);

test("the form is prefilled from the account file before Penpot is asked", () => {
    const model = newForm(ONE);

    assert.equal(accountName(model), "mcp-worker");
    assert.equal(model.fileId, FILE);
    assert.equal(model.teamId, TEAM);
    assert.equal(model.loading, true, "the documents are still coming");
});

test("without a document list the ids are typed, as they always were", () => {
    assert.deepEqual(labels(newForm(ONE)), ["account", "fileId", "teamId", "browser", "start"]);
});

test("with a document list there is one row to choose from", () => {
    const model = withDocuments(newForm(ONE), LISTED);

    assert.deepEqual(labels(model), ["account", "document", "browser", "start"]);
    assert.equal(fields(model)[1]?.value, "Default / worker-scratch", "the prefilled id should be matched by name");
});

test("a list arriving late keeps what was already chosen", () => {
    const chosen = { ...withDocuments(newForm(ONE), LISTED), documentIndex: 0 };
    const reordered = { documents: [choice("f-v", "viewer"), choice("f-diagrams", "diagrams")], problem: null };

    assert.equal(fields(withDocuments(chosen, reordered))[1]?.value, "ihate-workspace / diagrams");
});

test("a list that cannot be fetched leaves the ids typeable", () => {
    const model = withDocuments(newForm(ONE), { documents: [], problem: "get-teams failed: HTTP 401" });

    assert.deepEqual(labels(model), ["account", "fileId", "teamId", "browser", "start"]);
    assert.equal(model.loading, false);
    // The prefilled ids are still good, so the form is still submittable.
    assert.equal(whyNot(model), null);
});

test("with no ids and no list, the reason names the fetch that failed", () => {
    const model = withDocuments(newForm(BARE), { documents: [], problem: "offline" });

    assert.ok(whyNot(model)?.includes("offline"), whyNot(model) ?? "");
    assert.ok(whyNot(model)?.includes("type the ids"), whyNot(model) ?? "");
});

test("the cursor walks the visible rows and wraps", () => {
    const model = withDocuments(newForm(ONE), LISTED);

    assert.equal(focused(model).key, "account");
    assert.equal(focused(press(model, "down").model).key, "document");
    assert.equal(focused(press(model, "down", "down").model).key, "browser");
    assert.equal(focused(press(model, "down", "down", "down").model).key, "start");
    assert.equal(focused(press(model, "down", "down", "down", "down").model).key, "account", "it should wrap");
    assert.equal(focused(press(model, "up").model).key, "start");
});

test("enter opens the list on a choice, and up and down move inside it", () => {
    // The key everyone expects to open a list, which is why it is no longer
    // spent on starting the lane.
    const model = withDocuments(newForm(ONE), LISTED);
    const opened = press(model, "down", "return").model;

    assert.equal(opened.expanded, true);
    assert.equal(opened.optionIndex, 1, "it opens on what is already chosen");

    assert.equal(press(opened, "down").model.optionIndex, 2);
    assert.equal(press(opened, "up").model.optionIndex, 0);
    assert.equal(press(opened, "up", "up").model.optionIndex, 2, "it wraps");
});

test("enter picks the highlighted option and closes the list", () => {
    const model = withDocuments(newForm(ONE), LISTED);
    const picked = press(model, "down", "return", "down", "return").model;

    assert.equal(picked.expanded, false);
    assert.equal(picked.documentIndex, 2);
    assert.equal(fields(picked)[1]?.value, "ihate-workspace / viewer");
});

test("escape closes the list without picking, and does not cancel the form", () => {
    const model = withDocuments(newForm(ONE), LISTED);
    const backedOut = press(model, "down", "return", "down", "escape");

    assert.equal(backedOut.model.expanded, false);
    assert.equal(backedOut.model.documentIndex, 1, "the selection is unchanged");
    assert.equal(backedOut.result.cancel, undefined, "escape closed the list, not the form");
});

test("escape cancels the form when no list is open", () => {
    assert.equal(applyKey(newForm(ONE), { name: "escape" }).cancel, true);
});

test("a lane starts only from its own row", () => {
    // Enter used to start a lane from wherever the cursor was, which made it
    // possible to start one while looking at something else.
    const model = withDocuments(newForm(ONE), LISTED);

    assert.equal(press(model, "return").result.submit, undefined, "enter on the account row opens its list");
    assert.equal(press(model, "down", "return").result.submit, undefined, "and on the document row");

    const onStart = press(model, "up");
    assert.equal(focused(onStart.model).key, "start");
    assert.equal(applyKey(onStart.model, { name: "return" }).submit, true);
});

test("enter on a typed row moves to the next one", () => {
    const moved = press(newForm(ONE), "down", "return");

    assert.equal(focused(moved.model).key, "teamId");
    assert.equal(moved.result.submit, undefined);
});

test("left and right step a list without opening it", () => {
    const stepped = press(withDocuments(newForm(TWO), LISTED), "right");

    assert.equal(stepped.model.expanded, false);
    assert.equal(accountName(stepped.model), "second");
});

test("changing the account drops its documents and asks for the new ones", () => {
    // A different account has different documents, so what was chosen no
    // longer means anything.
    const changed = press(withDocuments(newForm(TWO), LISTED), "right");

    assert.equal(changed.result.reload, true);
    assert.deepEqual(changed.model.documents, []);
    assert.equal(changed.model.documentIndex, -1);
    assert.equal(changed.model.loading, true);
});

test("choosing the account already chosen asks for nothing", () => {
    const same = press(withDocuments(newForm(ONE), LISTED), "return", "return");

    assert.equal(same.result.reload, undefined);
    assert.equal(same.model.documents.length, 3, "the list it already had is kept");
});

test("space toggles the browser, and the display row follows it", () => {
    const model = withDocuments(newForm(ONE), LISTED);
    assert.ok(!labels(model).includes("display"));

    const headed = press(model, "down", "down", "space").model;
    assert.equal(headed.headed, true);
    assert.deepEqual(labels(headed), ["account", "document", "browser", "display", "start"]);
});

test("a headed lane will not start without a display", () => {
    const headed = { ...withDocuments(newForm(ONE), LISTED), headed: true, display: "" };

    assert.ok(whyNot(headed)?.includes("needs a display"), whyNot(headed) ?? "");
    assert.equal(whyNot({ ...headed, display: ":3" }), null);
});

test("the display is prefilled from the environment", () => {
    assert.equal(newForm(ONE, { DISPLAY: ":3" }).display, ":3");
    assert.equal(newForm(ONE, {}).display, "");
});

test("typing goes into the focused row, and only what belongs there", () => {
    const blank = { ...newForm(BARE), loading: false };

    const typed = type({ ...blank, cursor: 1 }, "0a1b");
    assert.equal(typed.fileId, "0a1b");
    assert.equal(typed.teamId, "");

    // An id is hex and dashes; a stray letter is a slip, not input.
    assert.equal(type({ ...typed, cursor: 1 }, "zq!").fileId, "0a1b");
    assert.equal(applyKey({ ...typed, cursor: 1 }, { name: "backspace" }).model.fileId, "0a1");
});

test("a display takes characters an id would not", () => {
    const headed = { ...withDocuments(newForm(ONE), LISTED), headed: true, display: "", cursor: 3 };

    assert.equal(focused(headed).key, "display");
    assert.equal(type(headed, ":0.1").display, ":0.1");
    assert.equal(type(headed, "hostX:1").display, "hostX:1", "a display keeps its case");
});

test("the form prints the command it is equivalent to", () => {
    const model = withDocuments(newForm(ONE), LISTED);

    assert.equal(commandFor(model), `mcp-headless --no-tui --account mcp-worker --file-id ${FILE} --team-id ${TEAM}`);
    assert.equal(
        commandFor({ ...model, headed: true, display: ":3" }),
        `mcp-headless --no-tui --account mcp-worker --file-id ${FILE} --team-id ${TEAM} --headed --display :3`
    );
});

test("the open list is handed to the renderer with its highlight", () => {
    const model = withDocuments(newForm(ONE), LISTED);
    const state = toFormState(press(model, "down", "return").model);

    assert.deepEqual(state.expansion?.options, [
        "ihate-workspace / diagrams",
        "Default / worker-scratch",
        "ihate-workspace / viewer",
    ]);
    assert.equal(state.expansion?.index, 1);
    assert.equal(toFormState(model).expansion, undefined, "a closed list is not drawn");
});

test("a chosen document carries its names into the lane", () => {
    // The whole reason the list exists: the row can say a name because the
    // reference remembers one.
    const model = press(withDocuments(newForm(ONE), LISTED), "down", "return", "up", "return").model;
    const spec = toSpec(model, ONE, "default");

    assert.deepEqual(spec.document, {
        fileId: "f-diagrams",
        teamId: TEAM,
        name: "diagrams",
        teamName: "ihate-workspace",
    });
    assert.equal(spec.mode, "exec");
});

test("a typed document carries only its ids", () => {
    const typed = { ...newForm(BARE), loading: false, fileId: FILE, teamId: TEAM };

    assert.deepEqual(chosenDocument(typed), { fileId: FILE, teamId: TEAM });
    assert.equal(toSpec(typed, BARE, "default").document.name, undefined);
});

test("a headed spec carries the display it was given", () => {
    const model = { ...withDocuments(newForm(ONE), LISTED), documentIndex: 0, headed: true, display: ":3" };

    assert.equal(toSpec(model, ONE, "default").display, ":3");
});

test("an incomplete form refuses to become a spec", () => {
    const blank = { ...newForm(BARE), loading: false };

    assert.throws(() => toSpec(blank, BARE, "default"), /document is needed/);
});

test("no accounts at all is said plainly rather than shown as an empty picker", () => {
    assert.equal(whyNot(newForm(settings())), "no accounts configured; see --help for where they live");
});
