#!/usr/bin/env python3
"""Interactive launcher for an MCP worker -- a front end for ./run-mcp-worker.

Shows a small curses form with the things that differ per run (which account,
which document, which server mode and port, headed or not), then exec()s the
shell runner.  One worker drives one document: Penpot's plugin API has no
openFile, so the page can only touch the file it has open.

Documents are listed from the running Penpot instance when it can be reached;
otherwise the field takes a file id or a workspace URL by hand.

Stdlib only.  External programs used: ./run-mcp-worker (and docker, via it).

  -y, --last     skip the form, reuse the last saved answers
  -n, --dry-run  print the command instead of running it
"""

import curses
import json
import os
import re
import shlex
import socket
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "run-mcp-worker"
WORKER_DIR = HERE / "worker"
STATE_FILE = (
    Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    / "penpot-mcp-worker.json"
)
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}")

DEFAULTS = {
    "env": "",
    "document": "",
    "mode": "exec",
    "port": "",
    "headed": "no",
    "display": os.environ.get("DISPLAY", ":3"),
}

FIELDS = [
    ("env", "Account (env)", "choice"),
    ("document", "Document", "choice"),
    ("mode", "MCP server", "choice"),
    ("port", "Port", "text"),
    ("headed", "Headed", "choice"),
    ("display", "Display", "text"),
]

LABEL_WIDTH = max(len(label) for _, label, _ in FIELDS) + 2

MODE_HELP = {
    "exec": "exec -- inside the stock penpot-mcp container; never version-skewed",
    "builtin": "builtin -- the instance's shared server; one document only",
    "local": "local -- our own build; for hacking on the server",
}

ESC_SEQUENCES = {
    "[A": curses.KEY_UP, "OA": curses.KEY_UP,
    "[B": curses.KEY_DOWN, "OB": curses.KEY_DOWN,
    "[C": curses.KEY_RIGHT, "OC": curses.KEY_RIGHT,
    "[D": curses.KEY_LEFT, "OD": curses.KEY_LEFT,
    "[Z": curses.KEY_BTAB, "[3~": curses.KEY_DC,
}
IGNORED_KEY = object()

DOCUMENTS = []          # [(label, file-id)], filled in before the form opens
DOC_ERROR = ""          # why the list is empty, if it is


# --------------------------------------------------------------------------- #
# state


def env_choices():
    found = sorted(str(p.name) for p in WORKER_DIR.glob("*.env") if p.is_file())
    return found or ["worker.env"]


def read_env(name):
    """Parse a worker env file into a dict. Not a shell, just KEY="value" lines."""
    values = {}
    path = WORKER_DIR / name
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, raw = line.partition("=")
            values[key.strip()] = raw.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def load_state():
    state = dict(DEFAULTS)
    try:
        saved = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    if isinstance(saved, dict):
        for key in DEFAULTS:
            if isinstance(saved.get(key), str):
                state[key] = saved[key]
    if state["env"] not in env_choices():
        state["env"] = env_choices()[0]
    return state


def save_state(state):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({k: state[k] for k in DEFAULTS}, indent=2) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# talking to Penpot


def rpc(origin, command, payload, cookie=None):
    """One RPC call. Returns (parsed body, Set-Cookie header)."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    request = urllib.request.Request(
        f"{origin}/api/rpc/command/{command}", data=json.dumps(payload).encode(), headers=headers
    )
    with urllib.request.urlopen(request, timeout=6) as response:
        return json.loads(response.read().decode()), response.headers.get("Set-Cookie", "")


def fetch_documents(env):
    """Return [(label, file-id)] for the account in `env`, or [] with a reason."""
    origin = env.get("PENPOT_ORIGIN")
    email = env.get("PENPOT_EMAIL")
    password = env.get("PENPOT_PASSWORD")
    if not (origin and email and password):
        return [], "env file has no PENPOT_ORIGIN/EMAIL/PASSWORD"
    try:
        profile, set_cookie = rpc(origin, "login-with-password", {"email": email, "password": password})
        # The session cookie is Secure, and a hardened instance is reached over
        # plain http on localhost. Browsers treat loopback as trustworthy and
        # send it anyway; http.cookiejar does not, so pass it by hand.
        match = re.search(r"(auth-token=[^;]+)", set_cookie)
        if not match:
            return [], "login returned no auth-token cookie"
        cookie = match.group(1)

        # Every team the worker belongs to, not just its own: a worker invited
        # into someone else's team drives documents that live there, and the
        # workspace URL needs that team's id as well as the file's.
        teams, _ = rpc(origin, "get-teams", {}, cookie)
        if not teams:
            teams = [{"id": profile.get("defaultTeamId"), "name": "default"}]
        found = []
        for team in teams:
            team_id = str(team.get("id"))
            label_team = team.get("name") or team_id[:8]
            try:
                files, _ = rpc(origin, "get-team-recent-files", {"teamId": team_id}, cookie)
            except (urllib.error.URLError, OSError, ValueError):
                continue
            for f in files or []:
                if f.get("id"):
                    found.append(
                        (f"{f.get('name', '(unnamed)')}  [{label_team}]", str(f["id"]), team_id)
                    )
        # Teams are commonly all called "Default", so add a short id when the
        # name alone would not say which team a document lives in. The TAIL of
        # the id, not the head: Penpot's uuids are time-ordered, so teams made
        # moments apart share a prefix and only differ at the end.
        if len({t.get("name") for t in teams}) < len(teams):
            found = [
                (label.rstrip("]") + f" \u2026{team_id[-8:]}]", file_id, team_id)
                for label, file_id, team_id in found
            ]
        return sorted(found), "" if found else "no files in any team this account belongs to"
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        return [], f"could not list documents: {str(exc)[:60]}"


def document_choices(state):
    labels = [entry[0] for entry in DOCUMENTS]
    current = state["document"]
    if current and current not in labels:
        labels.append(current)
    return labels or [current or ""]


def document_ids(state):
    """(file-id, team-id) for the current Document answer; team may be None."""
    for label, file_id, team_id in DOCUMENTS:
        if label == state["document"]:
            return file_id, team_id
    match = UUID_RE.search(state["document"])
    return (match.group(0) if match else None), None


def document_id(state):
    return document_ids(state)[0]


# --------------------------------------------------------------------------- #
# validation and command


def compose_running():
    return os.system(f"cd {shlex.quote(str(HERE))} && docker compose ps -q penpot-mcp >/dev/null 2>&1") == 0


def problems(state):
    errors, warnings = [], []

    env = read_env(state["env"])
    if not env.get("PENPOT_ORIGIN"):
        errors.append(f"{state['env']} has no PENPOT_ORIGIN -- copy worker.env.example")

    if not document_id(state):
        if DOC_ERROR:
            errors.append(f"Document: type a file id or workspace URL ({DOC_ERROR})")
        else:
            errors.append("Document: pick one, or type a file id / workspace URL")

    port = state["port"].strip()
    if port and not (port.isdigit() and 1 <= int(port) <= 65535):
        errors.append("Port must be empty (auto) or 1-65535")
    if port and state["mode"] == "builtin":
        warnings.append("builtin starts no server, so Port is ignored")

    if state["mode"] == "builtin":
        warnings.append("builtin shares one server; a second document needs exec")

    if state["headed"] == "yes" and not state["display"].strip():
        errors.append("Headed needs a Display, e.g. :3")

    return errors, warnings


def build_command(state):
    argv = [str(RUNNER), "--env-file", str(WORKER_DIR / state["env"]), "--mcp", state["mode"]]
    file_id, team_id = document_ids(state)
    if file_id:
        argv += ["--file-id", file_id]
    if team_id:
        argv += ["--team-id", team_id]
    if state["port"].strip() and state["mode"] != "builtin":
        argv += ["--port", state["port"].strip()]
    argv.append("--headed" if state["headed"] == "yes" else "--headless")
    return argv


# --------------------------------------------------------------------------- #
# tui


def choices_for(key, state):
    if key == "env":
        return env_choices()
    if key == "document":
        return document_choices(state)
    if key == "mode":
        return ["exec", "builtin", "local"]
    if key == "headed":
        return ["no", "yes"]
    return []


def render_value(key, state):
    value = state[key]
    if key == "port":
        if state["mode"] == "builtin":
            return "n/a"
        return value if value.strip() else "auto (first free pair)"
    if key == "mode":
        return MODE_HELP[value]
    if key == "display":
        return value if state["headed"] == "yes" else f"{value} (unused while headless)"
    if key == "document":
        return value or "(none found -- type a file id)"
    return value


def dimmed(key, state):
    if key == "display":
        return state["headed"] != "yes"
    if key == "port":
        return state["mode"] == "builtin"
    return False


class Form:
    def __init__(self, state):
        self.state = state
        self.index = 0
        self.status = ""

    def put(self, win, y, x, text, attr=0):
        height, width = win.getmaxyx()
        if not (0 <= y < height) or x >= width:
            return
        try:
            win.addnstr(y, x, text, max(0, width - x - 1), attr)
        except curses.error:
            pass

    def draw(self, win):
        win.erase()
        height, width = win.getmaxyx()
        self.put(win, 0, 1, "run-mcp-worker -- one Penpot document, one browser", curses.A_BOLD)

        cursor = None
        row = 2
        for i, (key, label, kind) in enumerate(FIELDS):
            active = i == self.index
            attr = curses.A_REVERSE if active else 0
            if dimmed(key, self.state):
                attr |= curses.A_DIM
            self.put(win, row, 2, label.ljust(LABEL_WIDTH), attr)
            self.put(
                win, row, 2 + LABEL_WIDTH + 1, render_value(key, self.state),
                curses.A_DIM if dimmed(key, self.state) else 0,
            )
            if active and kind == "text":
                cursor = (row, min(2 + LABEL_WIDTH + 1 + len(self.state[key]), width - 1))
            row += 1

        row += 1
        self.put(win, row, 1, "Command", curses.A_BOLD)
        row += 1
        for line in textwrap.wrap(shlex.join(build_command(self.state)), max(20, width - 6)) or [""]:
            self.put(win, row, 3, line, curses.A_DIM)
            row += 1

        errors, warnings = problems(self.state)
        note = self.status or (errors[0] if errors else "; ".join(warnings))
        if note:
            self.put(win, height - 3, 1, note[: max(0, width - 2)], curses.A_BOLD)
        self.put(
            win, height - 2, 1,
            "up/down move  left/right or space change  type to edit  Enter start  Esc quit",
            curses.A_DIM,
        )

        if cursor:
            curses.curs_set(1)
            try:
                win.move(*cursor)
            except curses.error:
                pass
        else:
            curses.curs_set(0)
        win.refresh()

    def cycle(self, key, step):
        options = choices_for(key, self.state)
        if not options:
            return
        try:
            position = options.index(self.state[key])
        except ValueError:
            position = 0
        self.state[key] = options[(position + step) % len(options)]
        if key == "env":
            refresh_documents(self.state)

    def handle(self, char):
        key, _, kind = FIELDS[self.index]
        self.status = ""

        if char in (curses.KEY_DOWN, "\t"):
            self.index = (self.index + 1) % len(FIELDS)
        elif char in (curses.KEY_UP, curses.KEY_BTAB):
            self.index = (self.index - 1) % len(FIELDS)
        elif char in ("\n", "\r", curses.KEY_ENTER):
            errors, _ = problems(self.state)
            if errors:
                self.status = errors[0]
                return None
            return True
        elif char in ("\x1b", "\x03"):
            return False
        elif kind == "choice":
            if char in (curses.KEY_RIGHT, " "):
                self.cycle(key, 1)
            elif char == curses.KEY_LEFT:
                self.cycle(key, -1)
            elif key == "document" and isinstance(char, str) and char.isprintable():
                # Documents can also be typed, for a file not in the list.
                known = {entry[0] for entry in DOCUMENTS}
                self.state[key] = char if self.state[key] in known else self.state[key] + char
            elif key == "document" and char in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                self.state[key] = self.state[key][:-1]
        elif char in (curses.KEY_BACKSPACE, "\x7f", "\b"):
            self.state[key] = self.state[key][:-1]
        elif char == "\x15":
            self.state[key] = ""
        elif isinstance(char, str) and char.isprintable():
            self.state[key] += char
        return None

    def read_key(self, win):
        char = win.get_wch()
        if char != "\x1b":
            return char
        win.timeout(30)
        try:
            sequence = ""
            while len(sequence) < 6:
                try:
                    part = win.get_wch()
                except curses.error:
                    break
                if not isinstance(part, str):
                    break
                sequence += part
                if part.isalpha() or part == "~":
                    break
        finally:
            win.timeout(-1)
        if not sequence:
            return "\x1b"
        return ESC_SEQUENCES.get(sequence, IGNORED_KEY)

    def run(self, win):
        win.keypad(True)
        while True:
            self.draw(win)
            try:
                char = self.read_key(win)
            except curses.error:
                continue
            except KeyboardInterrupt:
                return False
            if char is IGNORED_KEY or char == curses.KEY_RESIZE:
                continue
            outcome = self.handle(char)
            if outcome is not None:
                return outcome


def refresh_documents(state):
    global DOCUMENTS, DOC_ERROR
    DOCUMENTS, DOC_ERROR = fetch_documents(read_env(state["env"]))
    labels = [entry[0] for entry in DOCUMENTS]
    if labels and state["document"] not in labels and not UUID_RE.search(state["document"]):
        state["document"] = labels[0]


def ask(state):
    if hasattr(curses, "set_escdelay"):
        curses.set_escdelay(25)
    form = Form(state)
    return curses.wrapper(form.run), form.state


# --------------------------------------------------------------------------- #
# main


def main(args):
    if "-h" in args or "--help" in args:
        print(__doc__.strip())
        return 0
    dry_run = bool({"-n", "--dry-run"} & set(args))
    skip_tui = bool({"-y", "--last", "--no-tui"} & set(args))
    unknown = [a for a in args if a not in {"-n", "--dry-run", "-y", "--last", "--no-tui"}]
    if unknown:
        print("unknown argument: %s" % unknown[0], file=sys.stderr)
        return 2

    if not RUNNER.is_file():
        print("cannot find %s" % RUNNER, file=sys.stderr)
        return 1

    state = load_state()
    refresh_documents(state)

    if skip_tui:
        errors, _ = problems(state)
        if errors:
            print(errors[0], file=sys.stderr)
            return 1
    else:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            print("not a terminal; use --last to run with the saved options", file=sys.stderr)
            return 1
        ok, state = ask(state)
        if not ok:
            print("cancelled", file=sys.stderr)
            return 130
        save_state(state)

    argv = build_command(state)
    env = dict(os.environ)
    if state["headed"] == "yes":
        env["DISPLAY"] = state["display"].strip()
    print("+ " + shlex.join(argv), file=sys.stderr)
    if dry_run:
        return 0
    os.execvpe(argv[0], argv, env)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
