#!/usr/bin/env node
// The only place this program exits.
//
// main() returns a code; the process ends here and nowhere else. The tooling
// this replaces called exit from inside a branch, which skipped its own cleanup
// and orphaned a server in the container.

import { main } from "../src/main.ts";

process.exitCode = await main(process.argv.slice(2), process.env, {
    out: process.stdout,
    err: process.stderr,
    input: process.stdin,
});
