import assert from "node:assert/strict";
import test from "node:test";
import { ImageContent, TextContent } from "./ToolResponse";

test("textData passes a plain string through unchanged", () => {
    assert.equal(TextContent.textData("<svg/>"), "<svg/>");
});

test("textData decodes the base64 envelope the plugin sends for a Uint8Array result", () => {
    // What ExecuteCodeTaskHandler.encodeBytesAsBase64Envelope produces for a
    // Uint8Array result -- which `shape.export()` always returns, SVG included.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const envelope = { __type: "base64", data: Buffer.from(svg, "utf-8").toString("base64") };

    assert.equal(TextContent.textData(envelope), svg);
});

test("textData falls back to the legacy numeric-keyed object for a plain JSON-ified string", () => {
    // What `JSON.stringify` produces for a string sent as a plain object, before
    // the base64 envelope existed.
    const legacy = { 0: 72, 1: 105 }; // "Hi"
    assert.equal(TextContent.textData(legacy), "Hi");
});

test("textData used to turn the base64 envelope into two NUL bytes -- regression guard", () => {
    // Object.values({__type: "base64", data: "..."}) is ["base64", "..."], and
    // String.fromCharCode ToUint16-converts each non-numeric string to 0. This
    // guards against reintroducing that path for the envelope shape.
    const envelope = { __type: "base64", data: "aGVsbG8=" }; // "hello"
    const result = TextContent.textData(envelope);
    assert.notEqual(result, "\0\0");
    assert.equal(result, "hello");
});

test("byteData still decodes the same envelope, unchanged by the textData fix", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const envelope = { __type: "base64", data: Buffer.from(bytes).toString("base64") };
    assert.deepEqual(ImageContent.byteData(envelope), bytes);
});
