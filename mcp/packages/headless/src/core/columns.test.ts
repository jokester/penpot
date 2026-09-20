import test from "node:test";
import assert from "node:assert/strict";

import { COLUMNS, COLUMN_NAMES, DEFAULT_COLUMNS, isColumn, parseColumns } from "./columns.ts";
import { isLauncherError } from "./errors.ts";

test("a comma-separated list parses, in the order given", () => {
    assert.deepEqual(parseColumns("port,state,client"), ["port", "state", "client"]);
    assert.deepEqual(parseColumns("client,port"), ["client", "port"], "order is the operator's, not ours");
});

test("an array parses too, because one comes from JSON", () => {
    assert.deepEqual(parseColumns(["team", "document"]), ["team", "document"]);
});

test("spaces around a name are forgiven", () => {
    assert.deepEqual(parseColumns(" port , state "), ["port", "state"]);
});

test("a repeated column appears once", () => {
    assert.deepEqual(parseColumns("port,port,state"), ["port", "state"]);
});

test("an unknown column is refused, and the message lists the real ones", () => {
    // A silently dropped column is a column someone spends a while looking for.
    assert.throws(
        () => parseColumns("port,pid"),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.equal(err.detail.column, "pid");
            for (const name of COLUMN_NAMES) assert.ok(err.message.includes(name), `${name} missing from the message`);
            return true;
        }
    );
});

test("an empty list is refused rather than rendering a blank table", () => {
    assert.throws(
        () => parseColumns(""),
        (err: unknown) => isLauncherError(err)
    );
    assert.throws(
        () => parseColumns([]),
        (err: unknown) => isLauncherError(err)
    );
    assert.throws(
        () => parseColumns(" , , "),
        (err: unknown) => isLauncherError(err)
    );
});

test("a column that is not a string is refused", () => {
    assert.throws(
        () => parseColumns([1, 2]),
        (err: unknown) => isLauncherError(err)
    );
});

test("the default is what the list showed before it was configurable", () => {
    assert.deepEqual(DEFAULT_COLUMNS, ["port", "state", "document", "account", "browser", "uptime"]);
});

test("every column has a title and room to show something", () => {
    for (const name of COLUMN_NAMES) {
        const spec = COLUMNS[name];
        assert.ok(spec.title.length > 0, name);
        assert.ok(spec.width >= spec.title.length, `${name} is narrower than its own title`);
    }
});

test("isColumn does not confuse a name with an inherited property", () => {
    assert.ok(isColumn("port"));
    assert.ok(!isColumn("toString"));
    assert.ok(!isColumn("constructor"));
});
