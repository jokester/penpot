// The host's own process table, read from /proc.
//
// Small enough not to warrant a dependency, and reading /proc directly avoids
// the trap that cost this project four dead shells: a pattern passed to pkill
// matches the command line containing it, so the tool that runs the pattern
// kills itself. Matching here is done in memory against a pid we then kill by
// number, which cannot do that.

import { readdir, readFile } from "node:fs/promises";

import type { HostProcesses } from "./leftovers.ts";

/** The real host process table. */
export const hostProcesses: HostProcesses = {
    async list() {
        const out: { pid: number; command: string }[] = [];

        for (const entry of await readdir("/proc").catch(() => [])) {
            const pid = Number(entry);
            if (!Number.isInteger(pid)) continue;

            // A process can exit between the readdir and the read; that is
            // normal, not an error worth reporting.
            const raw = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
            if (raw === null || raw === "") continue;

            out.push({ pid, command: raw.replaceAll("\0", " ").trim() });
        }
        return out;
    },

    async kill(pid) {
        process.kill(pid, "SIGTERM");
    },
};
