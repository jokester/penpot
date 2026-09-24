// Pointing the page's asset fetches back at the origin it is logged into.
//
// The backend hands the browser absolute URLs for things the browser then has
// to fetch, and it builds them from its own `PENPOT_PUBLIC_URI` -- one value,
// for every client, whatever origin that client arrived on:
//
//   backend/src/app/rpc/management/exporter.clj:49
//     :uri (-> (cf/get :public-uri) (u/join "assets/by-id/") (u/join id))
//
// For a person that is right: they came in on the public hostname. For a
// worker it is wrong twice over. The public hostname is going behind an
// identity-aware proxy that a headless browser cannot satisfy, and even
// reachable it would be cross-origin, so the session cookie would not be sent
// and the fetch would 401 instead of failing outright. An SVG export fails
// with "unable to perform fetch operation" and names a URL nothing about this
// deployment can serve.
//
// The frontend has no such problem because it has no public URI at all and
// derives everything from `location.origin`. The backend cannot do that: it
// has one value and does not know which origin asked. Fixing it properly means
// returning a relative URI from that RPC, which is a one-line change to
// Penpot -- and a non-stock backend image, which this deployment will not have.
//
// So the launcher fixes it where it owns the machinery: in the browser. This
// is a deliberate lie to the page, and it is kept as narrow as a lie can be --
// only an absolute URL, only under /assets/, only when its origin is not the
// one the tab is signed in to. Anything else is passed through untouched.

import { normalizeOrigin } from "../core/target.ts";

/** The only path prefix the backend hands out absolutely. */
const REHOSTED = "/assets/";

/**
 * Where a request should really go, or null to leave it alone.
 *
 * Pure, so the rule can be argued with in a test rather than through a
 * browser. The Playwright half is four lines and has nothing to decide.
 */
export function rehostedAsset(requestUrl: string, origin: string): string | null {
    let asked: URL;
    let home: URL;
    try {
        asked = new URL(requestUrl);
        home = new URL(normalizeOrigin(origin));
    } catch {
        return null;
    }

    // Same origin already: the overwhelmingly common case, and the one that
    // must stay free -- every script, style and image the workspace loads
    // comes through here.
    if (asked.origin === home.origin) return null;
    if (!asked.pathname.startsWith(REHOSTED)) return null;

    return `${home.origin}${asked.pathname}${asked.search}`;
}
