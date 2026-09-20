// The new-lane form, as a value and a pure transition function.
//
// Keys are handled here rather than in the input loop so every one of them can
// be tested without a terminal, which is the same reason `render` is a pure
// function. `run.ts` reads keys and calls `applyKey`; it decides nothing.
//
// Two rules shape the key map. `enter` opens a list, because that is the only
// key anyone expects to; and starting a lane is a row of its own rather than
// something `enter` does from wherever the cursor happens to be. An earlier
// version spent `enter` on starting, which left nothing to expand a list with
// and made it possible to start a lane while looking at a different field.

import type { Settings } from "../core/config.ts";
import type { DocumentRef } from "../core/target.ts";
import { describeChoice, documentRefOf, type AccountCatalogue, type DocumentChoice } from "../penpot/catalogue.ts";
import type { LaneSpec } from "../supervisor/lane.ts";
import type { FormState } from "./render.ts";

/** What a row does when the cursor is on it. */
export type FieldKind = "choice" | "text" | "action";

/** The rows a form can have. Which appear depends on what is known. */
export type FieldKey = "account" | "document" | "fileId" | "teamId" | "browser" | "display" | "start";

/** One row, as the renderer and the key map both see it. */
export interface FieldView {
    readonly key: FieldKey;
    readonly label: string;
    readonly value: string;
    readonly kind: FieldKind;
    readonly hint?: string;
    /** The choices, when this row is a list worth expanding. */
    readonly options?: readonly string[];
    /** Which choice is current. */
    readonly index?: number;
}

/** What the operator has filled in so far. */
export interface FormModel {
    readonly accounts: readonly string[];
    readonly accountIndex: number;
    /** Documents for the chosen account, empty when they are not known. */
    readonly documents: readonly DocumentChoice[];
    /** Which document is chosen, or -1 when the ids are being typed. */
    readonly documentIndex: number;
    readonly fileId: string;
    readonly teamId: string;
    readonly headed: boolean;
    readonly display: string;
    readonly cursor: number;
    /** Whether the focused list is open. */
    readonly expanded: boolean;
    /** Which option the open list is highlighting. */
    readonly optionIndex: number;
    /** Whether the documents are still being fetched. */
    readonly loading: boolean;
    /** Why the documents are unavailable, when they are. */
    readonly problem: string | null;
}

/** What a key did, beyond changing the model. */
export interface FormResult {
    readonly model: FormModel;
    readonly submit?: true;
    readonly cancel?: true;
    /** The account changed, so its documents need fetching. */
    readonly reload?: true;
}

/**
 * Builds the form, prefilled from what can be detected without asking Penpot.
 *
 * The documents arrive later, through `withDocuments`, because fetching them
 * needs the network and the form has to be on screen before that returns.
 */
export function newForm(settings: Settings, env: NodeJS.ProcessEnv = {}): FormModel {
    const accounts = [...settings.accounts.keys()];
    const first = accounts[0] === undefined ? undefined : settings.accounts.get(accounts[0]);
    const document = first?.defaultDocument;

    return {
        accounts,
        accountIndex: 0,
        documents: [],
        documentIndex: -1,
        fileId: document?.fileId ?? "",
        teamId: document?.teamId ?? "",
        headed: false,
        display: env.DISPLAY ?? "",
        cursor: 0,
        expanded: false,
        optionIndex: 0,
        loading: accounts.length > 0,
        problem: null,
    };
}

/**
 * Folds a fetched document list into the form.
 *
 * Keeps whatever was already chosen if it is still in the list, so a list
 * arriving late does not move the choice out from under someone.
 */
export function withDocuments(model: FormModel, result: AccountCatalogue): FormModel {
    const documents = result.documents;
    const chosen = model.documentIndex >= 0 ? model.documents[model.documentIndex] : undefined;

    const keptIndex = chosen === undefined ? -1 : documents.findIndex((d) => d.fileId === chosen.fileId);
    const prefilled = model.fileId === "" ? -1 : documents.findIndex((d) => d.fileId === model.fileId);
    const documentIndex = keptIndex >= 0 ? keptIndex : prefilled;

    return { ...model, documents, documentIndex, loading: false, problem: result.problem };
}

/** The rows this form currently has, in the order the cursor walks them. */
export function fields(model: FormModel): readonly FieldView[] {
    const out: FieldView[] = [
        {
            key: "account",
            label: "account",
            kind: "choice",
            value: model.accounts[model.accountIndex] ?? "none configured",
            options: model.accounts,
            index: model.accountIndex,
            ...(model.accounts.length > 1 ? { hint: "enter to choose" } : {}),
        },
    ];

    if (model.documents.length > 0) {
        const chosen = model.documentIndex >= 0 ? model.documents[model.documentIndex] : undefined;
        out.push({
            key: "document",
            label: "document",
            kind: "choice",
            value: chosen === undefined ? "(choose one)" : describeChoice(chosen),
            options: model.documents.map(describeChoice),
            index: Math.max(0, model.documentIndex),
            hint: "enter to choose",
        });
    } else {
        // No list to pick from, so the ids are typed -- which is what the old
        // tooling always required, and still works when Penpot is unreachable.
        out.push({
            key: "fileId",
            label: "file id",
            kind: "text",
            value: model.fileId || "(file id)",
            ...(model.loading ? { hint: "listing documents…" } : {}),
        });
        out.push({ key: "teamId", label: "team id", kind: "text", value: model.teamId || "(team id)" });
    }

    out.push({
        key: "browser",
        label: "browser",
        kind: "choice",
        value: model.headed ? "headed" : "headless",
        options: ["headless", "headed"],
        index: model.headed ? 1 : 0,
        hint: "space toggles",
    });

    if (model.headed) {
        out.push({
            key: "display",
            label: "display",
            kind: "text",
            value: model.display || "(X display, e.g. :3)",
            hint: "the screen the browser opens on",
        });
    }

    out.push({ key: "start", label: "", kind: "action", value: "start this lane", hint: "enter" });
    return out;
}

/** The row the cursor is on. */
export function focused(model: FormModel): FieldView {
    const all = fields(model);
    return all[Math.min(model.cursor, all.length - 1)] as FieldView;
}

/**
 * Applies one key.
 *
 * Pure, so every key can be tested, and so the input loop holds no rules about
 * what a key means for a particular row.
 */
export function applyKey(model: FormModel, key: { name?: string; sequence?: string; shift?: boolean }): FormResult {
    const name = key.name ?? "";
    const field = focused(model);

    if (model.expanded) return inExpansion(model, field, name);

    switch (name) {
        case "escape":
            return { model, cancel: true };
        case "tab":
            return { model: move(model, key.shift === true ? -1 : 1) };
        case "up":
            return { model: move(model, -1) };
        case "down":
            return { model: move(model, 1) };
        case "return":
        case "enter":
            if (field.kind === "action") return { model, submit: true };
            if (field.kind === "choice" && (field.options?.length ?? 0) > 0) {
                return { model: { ...model, expanded: true, optionIndex: field.index ?? 0 } };
            }
            // On a text row, enter is the natural "done with this one".
            return { model: move(model, 1) };
        case "left":
            return cycle(model, field, -1);
        case "right":
            return cycle(model, field, 1);
        case "space":
            return field.key === "browser" ? { model: { ...model, headed: !model.headed } } : { model };
        case "backspace":
            return { model: edit(model, field, (value) => value.slice(0, -1)) };
        default:
            break;
    }

    const char = key.sequence ?? "";
    if (char.length === 1 && typeable(field, char)) {
        return { model: edit(model, field, (value) => value + normalise(field, char)) };
    }
    return { model };
}

/** Keys while a list is open: move within it, pick, or back out. */
function inExpansion(model: FormModel, field: FieldView, name: string): FormResult {
    const count = Math.max(1, field.options?.length ?? 0);

    switch (name) {
        case "escape":
            return { model: { ...model, expanded: false } };
        case "up":
        case "k":
            return { model: { ...model, optionIndex: (model.optionIndex - 1 + count) % count } };
        case "down":
        case "j":
            return { model: { ...model, optionIndex: (model.optionIndex + 1) % count } };
        case "return":
        case "enter":
            return pick(model, field, model.optionIndex);
        default:
            return { model };
    }
}

/** Takes the highlighted option and closes the list. */
function pick(model: FormModel, field: FieldView, index: number): FormResult {
    const closed = { ...model, expanded: false };

    if (field.key === "account") {
        // A different account has different documents, so what was chosen no
        // longer means anything.
        const moved = {
            ...closed,
            accountIndex: index,
            documents: [],
            documentIndex: -1,
            loading: true,
            problem: null,
        };
        return index === model.accountIndex ? { model: closed } : { model: moved, reload: true };
    }
    if (field.key === "document") return { model: { ...closed, documentIndex: index } };
    if (field.key === "browser") return { model: { ...closed, headed: index === 1 } };
    return { model: closed };
}

/** Left and right step a list without opening it. */
function cycle(model: FormModel, field: FieldView, by: number): FormResult {
    const count = field.options?.length ?? 0;
    if (field.kind !== "choice" || count === 0) return { model };

    return pick({ ...model, expanded: false }, field, ((field.index ?? 0) + by + count) % count);
}

/** Renders the model for the screen, with the reason it cannot be submitted. */
export function toFormState(model: FormModel): FormState {
    const all = fields(model);
    const cursor = Math.min(model.cursor, all.length - 1);
    const field = all[cursor] as FieldView;
    const problem = whyNot(model);

    return {
        title: "new lane",
        fields: all.map((f) => ({ label: f.label, value: f.value, ...(f.hint === undefined ? {} : { hint: f.hint }) })),
        cursor,
        command: commandFor(model),
        ...(problem === null ? {} : { error: problem }),
        ...(model.expanded && field.options !== undefined
            ? { expansion: { options: field.options, index: model.optionIndex } }
            : {}),
    };
}

/** Why the form cannot be submitted yet, or null when it can. */
export function whyNot(model: FormModel): string | null {
    if (model.accounts.length === 0) return "no accounts configured; see --help for where they live";

    const document = chosenDocument(model);
    if (document === null) {
        return model.problem === null ? "a document is needed" : `${model.problem} — type the ids instead`;
    }
    if (document.teamId === "") return "a team id is needed, or the workspace renders nothing";
    if (model.headed && model.display === "") return "a headed lane needs a display, for example :3";
    return null;
}

/** The document the form is pointing at, however it was chosen. */
export function chosenDocument(model: FormModel): DocumentRef | null {
    if (model.documentIndex >= 0) {
        const choice = model.documents[model.documentIndex];
        if (choice !== undefined) return documentRefOf(choice);
    }
    if (model.fileId === "") return null;
    return { fileId: model.fileId, teamId: model.teamId };
}

/** The non-interactive command this form is equivalent to. */
export function commandFor(model: FormModel): string {
    const account = model.accounts[model.accountIndex] ?? "NAME";
    const document = chosenDocument(model);

    const parts = [
        "mcp-headless --no-tui",
        `--account ${account}`,
        `--file-id ${document?.fileId || "UUID"}`,
        `--team-id ${document?.teamId || "UUID"}`,
    ];
    if (model.headed) {
        parts.push("--headed");
        if (model.display !== "") parts.push(`--display ${model.display}`);
    }
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
        document: chosenDocument(model) as DocumentRef,
        mode: "exec",
        headed: model.headed,
        flavour,
        ...(model.headed ? { display: model.display } : {}),
    };
}

/** The account the form is pointing at, for a fetch. */
export function accountName(model: FormModel): string | undefined {
    return model.accounts[model.accountIndex];
}

function move(model: FormModel, by: number): FormModel {
    const count = fields(model).length;
    return { ...model, cursor: (model.cursor + by + count) % count };
}

/** Whether this row takes typing, and whether this character belongs in it. */
function typeable(field: FieldView, char: string): boolean {
    if (field.key === "fileId" || field.key === "teamId") return /[0-9a-fA-F-]/.test(char);
    // A display is :3, :0.1, or a host name -- not hex.
    if (field.key === "display") return /[0-9A-Za-z.:_-]/.test(char);
    return false;
}

function normalise(field: FieldView, char: string): string {
    return field.key === "display" ? char : char.toLowerCase();
}

function edit(model: FormModel, field: FieldView, change: (value: string) => string): FormModel {
    if (field.key === "fileId") return { ...model, fileId: change(model.fileId) };
    if (field.key === "teamId") return { ...model, teamId: change(model.teamId) };
    if (field.key === "display") return { ...model, display: change(model.display) };
    return model;
}
