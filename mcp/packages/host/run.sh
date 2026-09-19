#!/usr/bin/env bash
#
# Run the MCP server and the browser host together, in the foreground.
#
# Intended for watching the thing work -- point it at a VNC desktop with
# --headed and you can see the Penpot tab the agent is driving. Ctrl-C stops
# both processes.
#
#   ./run.sh --env-file ../../../deploy/home-cluster/agent/agent.env --headed
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE=local                # local | builtin
HEADLESS=true
HOST=localhost            # what the MCP server binds
PORT=4401                 # MCP streamable HTTP
WS_PORT=4402              # plugin WebSocket
WS_URI=""                 # what the browser dials; derived when empty
MULTI_USER=false
REPL=false
ENV_FILE=""

usage() {
    cat <<'USAGE'
Usage: run.sh [options]

  --env-file PATH    Shell env file to source first (agent.env and friends).
                     Flags below override whatever it sets.

  --host HOST        Address the MCP server binds        (default localhost)
  --port N           MCP streamable HTTP port            (default 4401)
  --ws-port N        Plugin WebSocket port               (default 4402)
  --ws-uri URI       What the BROWSER dials; default ws://localhost:<ws-port>.
                     Set this when the browser and the server disagree on the
                     hostname, e.g. when binding 0.0.0.0.

  --headed           Show the browser. Needs a DISPLAY you are authorised on;
                     run it from inside the VNC session, or export the same
                     DISPLAY and XAUTHORITY that session uses. "Authorization
                     required, but no authorization protocol specified" means
                     the cookie does not match, not that the flag is wrong.
  --headless         Hide it (default).

  --mcp local        Start our own MCP server and point the plugin at it
                     (default). This is the only mode where --host/--port mean
                     anything.
  --mcp builtin      Start no server; the plugin uses the one the Penpot
                     instance already serves at <origin>/mcp/ws.

  --multi-user       Pass --multi-user to the server, as the packaged image
                     does. Required if your client sends ?userToken=.
  --repl             Also start the server's REPL console (off by default).

Required in the environment or the env file:
  PENPOT_ORIGIN, PENPOT_FILE_URL, and a logged-in PENPOT_PROFILE_DIR
  (or PENPOT_EMAIL / PENPOT_PASSWORD so it can log in).
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --host)     HOST="$2"; shift 2 ;;
        --port)     PORT="$2"; shift 2 ;;
        --ws-port)  WS_PORT="$2"; shift 2 ;;
        --ws-uri)   WS_URI="$2"; shift 2 ;;
        --headed)   HEADLESS=false; shift ;;
        --headless) HEADLESS=true; shift ;;
        --mcp)      MODE="$2"; shift 2 ;;
        --multi-user) MULTI_USER=true; shift ;;
        --repl)     REPL=true; shift ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || { echo "no such env file: $ENV_FILE" >&2; exit 2; }
    set -a; source "$ENV_FILE"; set +a
fi

[[ "$MODE" == local || "$MODE" == builtin ]] || { echo "--mcp must be local or builtin" >&2; exit 2; }
: "${PENPOT_ORIGIN:?set PENPOT_ORIGIN (or pass --env-file)}"
: "${PENPOT_FILE_URL:?set PENPOT_FILE_URL (or pass --env-file)}"

if [[ "$HEADLESS" == false ]]; then
    if [[ -z "${DISPLAY:-}" ]]; then
        echo "--headed needs DISPLAY. Inside VNC, export DISPLAY=:1 (or whatever" >&2
        echo "the VNC server uses) before running this." >&2
        exit 2
    fi
    # Authorisation is the usual failure, and Playwright reports it only as
    # "Target page, context or browser has been closed" with empty browser
    # logs, which sends people looking in the wrong place.
    if command -v xdpyinfo >/dev/null 2>&1; then
        xdpyinfo >/dev/null 2>&1 || {
            echo "cannot open DISPLAY=$DISPLAY. Set XAUTHORITY to the file that" >&2
            echo "session uses, or run this from inside the VNC desktop." >&2
            exit 2
        }
    fi
fi

SERVER_PID=""
cleanup() {
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ "$MODE" == local ]]; then
    DIST="$HERE/../server/dist/index.js"
    [[ -f "$DIST" ]] || { echo "no server build at $DIST -- run 'pnpm run build' in mcp/" >&2; exit 1; }

    # The plugin ships inside the Penpot FRONTEND, and it must match the server
    # we are about to start. A newer server expects a heartbeat an older plugin
    # never sends, and the failure claims the browser tab is suspended.
    plugin_js="$(curl -fsS --max-time 5 "${PENPOT_ORIGIN}/plugins/mcp/index.js" 2>/dev/null || true)"
    if [[ -n "$plugin_js" ]] && ! grep -q heartbeat <<<"$plugin_js" \
       && grep -q heartbeat "$DIST"; then
        echo "WARNING: the plugin served by $PENPOT_ORIGIN sends no heartbeat," >&2
        echo "  but this server build expects one. Every tool call will fail with" >&2
        echo "  'the Penpot plugin tab appears to be suspended'. Either mount the" >&2
        echo "  matching build of mcp/packages/plugin/dist over the frontend's" >&2
        echo "  /var/www/app/plugins/mcp, or use --mcp builtin." >&2
    fi

    args=()
    [[ "$MULTI_USER" == true ]] && args+=(--multi-user)

    echo "[run] MCP server  http://$HOST:$PORT/mcp   ws://$HOST:$WS_PORT"
    # ConfigurationLoader resolves data/ against process.cwd(), so the server
    # has to start from the directory holding index.js -- exactly as the
    # packaged image does.
    (
        cd "$(dirname "$DIST")"
        PENPOT_MCP_SERVER_HOST="$HOST" \
        PENPOT_MCP_SERVER_PORT="$PORT" \
        PENPOT_MCP_WEBSOCKET_PORT="$WS_PORT" \
        PENPOT_MCP_REPL_ENABLE="$REPL" \
        exec node index.js "${args[@]}"
    ) &
    SERVER_PID=$!

    # The browser must reach the socket by a name it can resolve; 0.0.0.0 is a
    # bind address, not a destination.
    if [[ -z "$WS_URI" ]]; then WS_URI="ws://localhost:$WS_PORT"; fi
    export PENPOT_MCP_MODE=inject PENPOT_MCP_WS_URI="$WS_URI" PENPOT_MCP_WEBSOCKET_PORT="$WS_PORT"

    # Give it a moment to bind before the page tries to dial it.
    for _ in $(seq 1 30); do
        kill -0 "$SERVER_PID" 2>/dev/null || { echo "[run] server exited early" >&2; exit 1; }
        curl -fsS -o /dev/null --max-time 1 "http://localhost:$PORT/mcp" 2>/dev/null && break
        sleep 0.5
    done
else
    export PENPOT_MCP_MODE=builtin
    echo "[run] using the instance's own MCP server at $PENPOT_ORIGIN/mcp/ws"
fi

export PENPOT_HOST_HEADLESS="$HEADLESS"
echo "[run] browser      headless=$HEADLESS display=${DISPLAY:-none}"
echo "[run] file         ${PENPOT_FILE_URL:0:96}"

# Log in when there is no stored session and we were given credentials.
if [[ -n "${PENPOT_EMAIL:-}" && -n "${PENPOT_PASSWORD:-}" ]]; then
    node "$HERE/spikes/login.js" >/dev/null 2>&1 || true
fi

cd "$HERE"
node host.js
