#!/usr/bin/env bash
# Stop the headless MCP host and release the browser profile lock.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$HERE/worker.pid" ]]; then
    pid="$(cat "$HERE/worker.pid")"
    if kill "$pid" 2>/dev/null; then
        echo "stopped worker (pid $pid)"
        # Give the browser a moment to flush the cookie jar and drop the lock.
        for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    fi
    rm -f "$HERE/worker.pid"
else
    echo "no worker.pid; nothing to stop"
fi
