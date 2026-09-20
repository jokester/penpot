// The new-lane form, as a value and a pure transition function.
//
// The keys are handled here rather than in the input loop so the form can be
// tested without a terminal, which is the same reason `render` is a pure
// function. `run.ts` reads keys and calls `applyKey`; it decides nothing.

import type { Settings } from "../core/config.ts";
import type { LaneSpec } from "../supervisor/lane.ts";
import type { FormState } from "./render.ts";

/** The fields, in the order the cursor walks them. */
const FIELDS = ["account", "document", "team", "browser"] as const;

export type Field = (typeof FIELDS)[number];

/** What the operator has filled in so far. */
export interface FormModel {
    readonly accounts: readonly string[];
    readonly accountIndex: number;
    readonly fileId: string;
    readonly teamId: string;
    readonly headed: boolean;
    readonly cursor: number;
}

/** What a key did, beyond changing the model. */
export interface FormResult {
    readonly model: FormModel;
    readonly submit?: true;
    readonly cancel?: true;
}

/**
 * Builds the form, prefilled from what can be detected.
 *
 * Accounts come from the files on disk, and the ids from the document the
 * account was provisioned with. Typing a uuid by hand is the thing the old
 * tooling made everyone do, and it is where blank ids came from.
 */
export function newForm(settings: Settings): FormModel {
    const accounts = [...settings.accounts.keys()];
    const first = accounts[0] === undefined ? undefined : settings.accounts.get(accounts[0]);
    const document = first?.defaultDocument;

    return {
        accounts,
        accountIndex: 0,
        fileId: document?.fileId ?? "",
        teamId: document?.teamId ?? "",
        headed: false,
        cursor: 0,
    };
}

/** The field the cursor is on. */
export function focused(model: FormModel): Field {
    return FIELDS[Math.min(model.cursor, FIELDS.length - 1)] as Field;
}

/**
 * Applies one key.
 *
 * Pure, so every key can be tested, and so the input loop holds no rules about
 * what a key means for a particular field.
 */
export function applyKey(model: FormModel, key: { name?: string; sequence?: string; shift?: boolean }): FormResult {
    const name = key.name ?? "";
    const field = focused(model);

    switch (name) {
        case "escape":
            return { model, cancel: true };
        case "return":
        case "enter":
            return { model, submit: true };
        case "tab":
            return { model: move(model, key.shift === true ? -1 : 1) };
        case "up":
            return { model: move(model, -1) };
        case "down":
            return { model: move(model, 1) };
        case "left":
            return { model: adjust(model, field, -1) };
        case "right":
            return { model: adjust(model, field, 1) };
        case "space":
            return field === "browser" ? { model: { ...model, headed: !model.headed } } : { model };
        case "backspace":
            return { model: edit(model, field, (value) => value.slice(0, -1)) };
        default:
            break;
    }

    // A printable character goes into the focused text field. uuids are hex and
    // dashes, so anything else is a slip rather than input.
    const char = key.sequence ?? "";
    if (char.length === 1 && /[0-9a-fA-F-]/.test(char)) {
        return { model: edit(model, field, (value) => value + char.toLowerCase()) };
    }
    return { model };
}

/** Renders the model for the screen, with the reason it cannot be submitted. */
export function toFormState(model: FormModel): FormState {
    const account = model.accounts[model.accountIndex] ?? "none configured";
    const problem = whyNot(model);

    const fields = [
        { label: "account", value: account, ...(model.accounts.length > 1 ? { hint: "← →" } : {}) },
        { label: "document", value: model.fileId || "(file id)" },
        { label: "team", value: model.teamId || "(team id)" },
        { label: "browser", value: model.headed ? "headed" : "headless", hint: "space toggles" },
    ];

    return {
        title: "new lane",
        fields,
        cursor: model.cursor,
        command: commandFor(model),
        ...(problem === null ? {} : { error: problem }),
    };
}

/** Why the form cannot be submitted yet, or null when it can. */
export function whyNot(model: FormModel): string | null {
    if (model.accounts.length === 0) return "no accounts configured; see --help for where they live";
    if (model.fileId === "") return "a file id is needed";
    if (model.teamId === "") return "a team id is needed, or the workspace renders nothing";
    return null;
}

/** The non-interactive command this form is equivalent to. */
export function commandFor(model: FormModel): string {
    const account = model.accounts[model.accountIndex] ?? "NAME";
    const parts = [
        "mcp-headless --no-tui",
        `--account ${account}`,
        `--file-id ${model.fileId || "UUID"}`,
        `--team-id ${model.teamId || "UUID"}`,
    ];
    if (model.headed) parts.push("--headed");
    return parts.join(" ");
}

/** Turns a complete form into a lane spec, or throws saying what is missing. */
export function toSpec(model: FormModel, settings: Settings, flavour: string): Omit<LaneSpec, "id"> {
    const problem = whyNot(model);
    if (problem !== null) throw new Error(problem);

    const name = model.accounts[model.accountIndex] as string;
    const account = settings.accounts.get(name);
    if (account === undefined) throw new Error(`no account named ${name}`);

    return {
        account,
        document: { fileId: model.fileId, teamId: model.teamId },
        mode: "exec",
        headed: model.headed,
        flavour,
    };
}

function move(model: FormModel, by: number): FormModel {
    const cursor = (model.cursor + by + FIELDS.length) % FIELDS.length;
    return { ...model, cursor };
}

/** Left and right cycle a choice; they do nothing to a text field. */
function adjust(model: FormModel, field: Field, by: number): FormModel {
    if (field === "account" && model.accounts.length > 0) {
        const accountIndex = (model.accountIndex + by + model.accounts.length) % model.accounts.length;
        return { ...model, accountIndex };
    }
    if (field === "browser") return { ...model, headed: !model.headed };
    return model;
}

function edit(model: FormModel, field: Field, change: (value: string) => string): FormModel {
    if (field === "document") return { ...model, fileId: change(model.fileId) };
    if (field === "team") return { ...model, teamId: change(model.teamId) };
    return model;
}
