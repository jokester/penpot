#!/usr/bin/env bash
# Start the headless MCP host against the local Penpot instance.
#   ~/penpot-local/host-start.sh            # foreground, Ctrl-C to stop
#   ~/penpot-local/host-start.sh --bg       # background, logs to host.log
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The headless host lives in this repo; agent/ sits four levels below it.
SRC="${PENPOT_SRC:-$(cd "$HERE/../../.." && pwd)}"

set -a; source "$HERE/agent.env"; set +a
cd "$SRC/mcp/packages/host"

# Chromium locks the profile directory, so only one host can hold it at a time.
# SingletonLock is a symlink to "<host>-<pid>"; a stale one is left behind by a
# hard kill, so the pid is checked rather than the file's mere existence.
lock="${PENPOT_PROFILE_DIR:-$HOME/.cache/penpot-headless/profile-home-cluster}/SingletonLock"
if [[ -L "$lock" ]]; then
    pid="$(readlink "$lock")"; pid="${pid##*-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "A browser (pid $pid) already holds the profile. Stop it: $HERE/host-stop.sh" >&2
        exit 1
    fi
    echo "removing stale profile lock"
    rm -f "$lock"
fi

if [[ "${1:-}" == "--bg" ]]; then
    nohup node host.js > "$HERE/host.log" 2>&1 &
    echo $! > "$HERE/host.pid"
    echo "host started (pid $(cat "$HERE/host.pid")); log: $HERE/host.log"
    until grep -qE "plugin connected|did NOT connect" "$HERE/host.log" 2>/dev/null; do sleep 1; done
    grep -oE "plugin connected to [^?]*|did NOT connect.*" "$HERE/host.log" | head -1
else
    exec node host.js
fi
