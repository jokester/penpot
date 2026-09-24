import test from "node:test";
import assert from "node:assert/strict";

import { rehostedAsset } from "./assets.ts";

const HOME = "http://127.0.0.1:30900";

test("an asset the backend addressed publicly comes back to this origin", async () => {
    // The real failure: an SVG export's download URI, built from the
    // backend's PENPOT_PUBLIC_URI, which the worker cannot reach and would
    // not be authenticated for if it could.
    assert.equal(
        rehostedAsset("https://penpot.ihate.work/assets/by-id/9002af4a-ef3b-4b62-a767-361a96e94a69", HOME),
        `${HOME}/assets/by-id/9002af4a-ef3b-4b62-a767-361a96e94a69`
    );
});

test("the query survives, because share links carry one", async () => {
    assert.equal(
        rehostedAsset("https://penpot.example/assets/by-id/abc?share-id=xyz", HOME),
        `${HOME}/assets/by-id/abc?share-id=xyz`
    );
});

test("a same-origin request is left alone, which is nearly every request", async () => {
    assert.equal(rehostedAsset(`${HOME}/assets/by-id/abc`, HOME), null);
    assert.equal(rehostedAsset(`${HOME}/js/config.js`, HOME), null);
});

test("a cross-origin request that is not an asset is left alone", async () => {
    // Fonts, telemetry, anything the app legitimately fetches elsewhere. The
    // rewrite is for the one path the backend addresses absolutely, not for
    // everything that leaves the page.
    assert.equal(rehostedAsset("https://fonts.googleapis.com/css2?family=X", HOME), null);
    assert.equal(rehostedAsset("https://penpot.ihate.work/api/rpc/command/get-profile", HOME), null);
});

test("a trailing slash on the account origin does not change the answer", async () => {
    assert.equal(
        rehostedAsset("https://penpot.ihate.work/assets/by-id/abc", "http://127.0.0.1:30900/"),
        "http://127.0.0.1:30900/assets/by-id/abc"
    );
});

test("something that is not a URL is not rewritten", async () => {
    assert.equal(rehostedAsset("data:image/png;base64,AAAA", HOME), null);
    assert.equal(rehostedAsset("not a url", HOME), null);
});
