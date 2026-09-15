# Headless MCP host — design spikes

Throwaway probes that validate the assumptions behind running the Penpot MCP
server against a **server-owned** headless browser instead of a user's tab.
They are not part of the build and are kept only as executable evidence: each
one can be re-run when Chromium or the deployed Penpot changes.

Everything here runs against **stock** software — unmodified cloud Penpot and,
for `verify.js`, the unmodified MCP server. No patched frontend is involved.

## spike-pna.js — Private Network Access

Answers: can a page served from `https://design.penpot.app` reach
`ws://localhost:4402`, and under which browser configuration?

Result (Chromium 151.0.7922.34, 2026-09-15):

| configuration                                   | ws://localhost | http://localhost |
| ----------------------------------------------- | -------------- | ---------------- |
| baseline                                        | blocked        | blocked          |
| `--disable-features=PrivateNetworkAccessChecks` | blocked        | blocked          |
| `--disable-features=LocalNetworkAccessChecks`   | open           | 200              |
| `grantPermissions(["local-network-access"])`    | open           | 200              |
| `--disable-web-security`                        | open           | 200              |

Baseline fails with `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, so this
has to be handled explicitly. The old `PrivateNetworkAccessChecks` flag no
longer has any effect.

**Use the permission grant, not a flag**: it is scoped to a single origin,
downgrades nothing else, and does not rot when flags are renamed.

    await context.grantPermissions(["local-network-access"],
                                   { origin: "https://design.penpot.app" });

**Verdict: the permission grant works and is the mechanism to use.**

## login.js — one interactive login

Opens a headed browser against a persistent profile so a human can log in once
(password, SSO, 2FA — whatever the account uses). Everything afterwards runs
headless against the stored session.

The profile defaults to `~/.cache/penpot-headless/profile` and holds a live
Penpot session cookie: treat it as a credential and keep it out of the repo.
Sessions last 7 days rolling / 30 days absolute, so expect a re-login roughly
weekly.

## verify.js — session persistence + plugin redirection

Headless, no interaction. Checks two things in one pass:

1. the stored session still authenticates after a headless relaunch;
2. injecting `window.penpotMcpServerURI` before load makes Penpot's **bundled**
   MCP plugin dial our local WebSocket instead of Penpot's hosted server.

(2) is what removes the need to serve or hand-install a plugin at all. The
override is read by `app.config/mcp-ws-uri` and ships in the deployed bundle.

Requires MCP to be enabled in the account's Penpot settings — otherwise the
plugin never starts and no WebSocket is attempted.

    PENPOT_FILE_URL='https://design.penpot.app/#/workspace?file-id=...' node verify.js

**Verdict (2026-09-15, Penpot 2.18.0-RC5): both confirmed.** The stored session
survives a headless relaunch (cookie valid 7 days), and the bundled plugin
dials `ws://localhost:4402` carrying a real `userToken`. No plugin server and
no user interaction are involved.

### How not to check authentication

Three signals lie, and all three cost time to learn:

- the **URL** — the SPA stays on the workspace URL while every request fails;
- a **synthetic fetch** to `/api/rpc/command/*` from page context — answered by
  a Cloudflare challenge even when the app's own traffic is fine;
- **`page.on("response")`** — never sees the app's RPC calls at all.

The trustworthy signal is the plugin WebSocket connecting with a `userToken`,
which the plugin can only have obtained from an authenticated
`get-access-tokens`. The host should use that as its readiness signal too.

## diagnose.js — attribution when verify.js fails

Dumps console output, cookie state, plugin iframes and (Cloudflare permitting)
profile and access-token data, to distinguish "not logged in" from "MCP not
enabled in settings" from "plugin never started".

## spike-pat.js — can a personal access token replace the cookie?

Answers: must the headless browser carry a session cookie, or can it
authenticate with a personal access token instead? A token would be preferable:
revocable, no expiry to manage, no interactive login, no session-bearing
profile on disk.

Uses a **fresh** profile directory so a stored cookie cannot mask a failure,
and sets `Authorization: Token <pat>` on the whole context.

Result (2026-09-15): **rejected, but only just.** With no cookie at all the app
booted, authenticated, fetched access tokens and started the MCP plugin — every
HTTP path works, workers included. Exactly one thing fails:

    wss://design.penpot.app/ws/notifications  ->  socketerror:
      HTTP Authentication failed; no valid credentials available   (x3, reconnect loop)

The failure is structural, not a Playwright quirk. Browsers do not let page JS
set WebSocket handshake headers; Playwright's `setExtraHTTPHeaders` does not
reach the handshake; and a proxy cannot inject them into `wss://` without
terminating TLS. A cookie is the only credential a browser sends on a WS
upgrade.

That socket carries other sessions' edits into the page. Losing it means the
page's view of the file silently stops updating while an agent writes against
it — a worse failure than being unable to connect at all.

**If token-only auth is wanted later**, the upstream ask is small: accept a
token as a query parameter on `/ws/notifications`, which already takes
`?session-id=`. That is a Penpot-side change.

## spike-ws.js — is the cookie session's notifications socket healthy?

The control case for the above. Result: one socket opened, **no auth errors,
never dropped** — healthy, against three failed opens under token auth.

Note that zero inbound frames is expected on an idle file; the server pushes
only when something happens elsewhere, so health means "stayed open without
erroring", not "received traffic". Positively proving delivery would need two
concurrent sessions, one editing and one watching — not yet done.

## Cloudflare

`design.penpot.app` is behind Cloudflare bot protection. It does not block the
app when driven through real Chrome (`channel: "chrome"`, which is why the
spikes use it rather than Playwright's headless shell), but it does challenge
programmatic requests. Assume anything that bypasses the app's own code paths
will be challenged.

## Running

`node_modules` is currently a symlink to a scratch install. Before committing,
replace it with a real install (`pnpm install` in this directory); the package
is deliberately absent from `mcp/pnpm-workspace.yaml` so it stays outside the
build.
