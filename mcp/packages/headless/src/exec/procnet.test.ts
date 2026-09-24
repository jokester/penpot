import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isLauncherError } from "../core/errors.ts";
import { parseListeningPorts } from "./procnet.ts";

/** Captured from the running penpot-mcp container on 2026-09-20. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const TCP = fixture("proc-net-tcp.txt");
const TCP6 = fixture("proc-net-tcp6.txt");

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** One row in the shape /proc writes, with only the columns this parser reads. */
function row(index: number, local: string, state: string): string {
    return `  ${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1001 0 1 1 0 100 0 0 10 0`;
}

test("the captured container yields both halves of a server", () => {
    // 4401 is in tcp only and 4402 in tcp6 only, which is the whole reason
    // this reads both files. 36945 is Docker's embedded DNS on 127.0.0.11.
    assert.deepEqual(parseListeningPorts(TCP, TCP6), [4401, 4402, 36945]);
});

test("reading one file alone would miss the WebSocket port", () => {
    // Stated as a test because it is the bug: the allocator saw 4402 as free.
    assert.ok(!parseListeningPorts(TCP, "").includes(4402));
    assert.ok(parseListeningPorts(TCP, TCP6).includes(4402));
});

test("sockets that are not listening are ignored", () => {
    const established = [HEADER, row(0, "00000000:1131", "01"), row(1, "0100007F:1132", "06")].join("\n");

    assert.deepEqual(parseListeningPorts(established, ""), []);
});

test("a port listening on both stacks appears once", () => {
    const four = [HEADER, row(0, "00000000:11F9", "0A")].join("\n");
    const six = [HEADER, row(0, "00000000000000000000000000000000:11F9", "0A")].join("\n");

    assert.deepEqual(parseListeningPorts(four, six), [4601]);
});

test("a full range of lanes comes back in order", () => {
    const four = [HEADER, row(0, "00000000:11F9", "0A"), row(1, "00000000:11FB", "0A")].join("\n");
    const six = [HEADER, row(0, "00000000:11FA", "0A"), row(1, "00000000:11FC", "0A")].join("\n");

    assert.deepEqual(parseListeningPorts(four, six), [4601, 4602, 4603, 4604]);
});

test("an empty file is empty, not an error", () => {
    assert.deepEqual(parseListeningPorts("", ""), []);
    assert.deepEqual(parseListeningPorts(HEADER, `${HEADER}\n`), []);
});

test("a truncated probe throws rather than reporting a short list", () => {
    // A half-written answer that parses to fewer ports is worse than no
    // answer: the allocator would hand out a port that is already serving.
    const truncated = `${HEADER}\n   0: 00000000:1131`;

    assert.throws(
        () => parseListeningPorts(truncated, ""),
        (err: unknown) => {
            assert.ok(isLauncherError(err));
            assert.equal(err.code, "probe-failed");
            assert.equal(err.detail.file, "/proc/net/tcp");
            return true;
        }
    );
});

test("an unreadable address throws and names the file", () => {
    const junk = [HEADER, row(0, "no-colons-here", "0A")].join("\n");

    assert.throws(
        () => parseListeningPorts("", junk),
        (err: unknown) => isLauncherError(err) && err.code === "probe-failed" && err.detail.file === "/proc/net/tcp6"
    );
});

test("a port at the top of the range parses", () => {
    assert.deepEqual(parseListeningPorts([HEADER, row(0, "00000000:FFFF", "0A")].join("\n"), ""), [65535]);
});
