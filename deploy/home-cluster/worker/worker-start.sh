#!/usr/bin/env bash
# Start the headless MCP host against the local Penpot instance.
#   ~/penpot-local/host-start.sh            # foreground, Ctrl-C to stop
#   ~/penpot-local/host-start.sh --bg       # background, logs to host.log
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The browser host lives in this repo; worker/ sits three levels below its root.
SRC="${PENPOT_SRC:-$(cd "$HERE/../../.." && pwd)}"

set -a; source "$HERE/worker.env"; set +a
cd "$SRC/mcp/packages/host"

# Chromium locks the profile directory, so only one host can hold it at a time.
# SingletonLock is a symlink to "<host>-<pid>"; a stale one is left behind by a
# hard kill, so the pid is checked rather than the file's mere existence.
lock="${PENPOT_PROFILE_DIR:-$HOME/.cache/penpot-headless/profile-mcp-worker}/SingletonLock"
if [[ -L "$lock" ]]; then
    pid="$(readlink "$lock")"; pid="${pid##*-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "A browser (pid $pid) already holds the profile. Stop it: $HERE/worker-stop.sh" >&2
        exit 1
    fi
    echo "removing stale profile lock"
    rm -f "$lock"
fi

if [[ "${1:-}" == "--bg" ]]; then
    nohup node host.js > "$HERE/worker.log" 2>&1 &
    echo $! > "$HERE/worker.pid"
    echo "worker started (pid $(cat "$HERE/worker.pid")); log: $HERE/worker.log"
    until grep -qE "plugin connected|did NOT connect" "$HERE/worker.log" 2>/dev/null; do sleep 1; done
    grep -oE "plugin connected to [^?]*|did NOT connect.*" "$HERE/worker.log" | head -1
else
    exec node host.js
fi
