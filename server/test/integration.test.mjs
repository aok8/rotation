import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rotation-test-"));
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-test-secret";
process.env.SPOTIFY_CLIENT_ID = "client";
process.env.SPOTIFY_CLIENT_SECRET = "secret";
process.env.SPOTIFY_REDIRECT_URI = "http://127.0.0.1:3000/auth/callback";
process.env.APP_BASE_URL = "http://127.0.0.1:3000";
process.env.PORT = "0";
process.env.DATA_DIR = dataDir;
const webDist = join(dataDir, "web");
mkdirSync(webDist);
writeFileSync(
  join(webDist, "index.html"),
  "<!doctype html><title>rotation test</title>",
);
process.env.WEB_DIST_DIR = webDist;
const nativeFetch = globalThis.fetch;
let duplicates = true;
let failDelete = false;
let archiveAdds = 0;
let archiveTimeout = false;
let deletes = 0;
let snapshot = "snap-1";
let otherTracks = null;
const track = {
  type: "track",
  uri: "spotify:track:abc123",
  name: "Song",
  artists: [{ name: "Artist" }],
  album: { name: "Album", images: [] },
  duration_ms: 120000,
  external_urls: { spotify: "https://open.spotify.com/track/abc123" },
};
function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://accounts.spotify.com/api/token"))
    return response({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
    });
  if (!url.startsWith("https://api.spotify.com/v1"))
    return nativeFetch(input, init);
  const u = new URL(url);
  if (u.pathname === "/v1/me")
    return response({ id: "user", display_name: "Listener" });
  if (u.pathname === "/v1/me/playlists")
    return response({
      items: [
        { id: "source12345", name: "Source", owner: { id: "user" } },
        { id: "archive12345", name: "Archive", owner: { id: "user" } },
      ],
      next: null,
    });
  if (u.pathname === "/v1/playlists/source12345" && init.method !== "DELETE")
    return response({ snapshot_id: snapshot });
  if (
    u.pathname === "/v1/playlists/source12345/items" &&
    (!init.method || init.method === "GET")
  )
    return response({
      items: otherTracks
        ? otherTracks.map((item) => ({ item }))
        : duplicates
          ? [{ item: track }, { item: track }]
          : [{ item: track }],
      next: null,
    });
  if (
    u.pathname === "/v1/playlists/archive12345/items" &&
    init.method === "POST"
  ) {
    archiveAdds++;
    if (archiveTimeout) {
      archiveTimeout = false;
      throw new Error("connection reset after archive add");
    }
    return response({ snapshot_id: "archive-snap" }, 201);
  }
  if (
    u.pathname === "/v1/playlists/source12345/items" &&
    init.method === "DELETE"
  ) {
    deletes++;
    if (failDelete) {
      failDelete = false;
      return response({ error: "temporary" }, 500);
    }
    if (otherTracks) {
      const uri = JSON.parse(init.body).items[0].uri;
      otherTracks = otherTracks.filter((item) => item.uri !== uri);
    }
    snapshot = `snap-${deletes + 1}`;
    return response({ snapshot_id: snapshot });
  }
  return response({ error: "unmocked" }, 404);
};
const { app } = await import("../dist/index.js");
const address = app.server.address();
const base = `http://127.0.0.1:${address.port}`;
async function request(path, method = "GET", body, csrf, cookie) {
  const result = await nativeFetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: result.status,
    body: result.headers.get("content-type")?.includes("json")
      ? await result.json()
      : null,
    headers: result.headers,
  };
}
try {
  await test("duplicate guard and archive retry never archive twice", async () => {
    const shell = await nativeFetch(base + "/");
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /rotation test/);
    const start = await request("/auth/start");
    const state = new URL(start.headers.get("location")).searchParams.get(
      "state",
    );
    const oauthCookie = start.headers.get("set-cookie").split(";")[0];
    const callback = await request(
      `/auth/callback?code=code&state=${state}`,
      "GET",
      undefined,
      undefined,
      oauthCookie,
    );
    const cookie = callback.headers
      .getSetCookie()
      .find((x) => x.startsWith("rotation_session="))
      .split(";")[0];
    const session = (
      await request("/api/session", "GET", undefined, undefined, cookie)
    ).body;
    const csrf = session.csrfToken;
    assert.equal(session.authenticated, true);
    const blocked = await request(
      "/api/settings",
      "PUT",
      { sourceId: "source12345", archiveId: null },
      undefined,
      cookie,
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "csrf");
    const settings = await request(
      "/api/settings",
      "PUT",
      { sourceId: "source12345", archiveId: "archive12345" },
      csrf,
      cookie,
    );
    assert.equal(settings.status, 200);
    let rotation = (
      await request("/api/rotation/start", "POST", {}, csrf, cookie)
    ).body;
    let result = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: rotation.order[0] },
      csrf,
      cookie,
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "duplicate_conflict");
    assert.equal(archiveAdds, 0);
    assert.equal(deletes, 0);
    duplicates = false;
    rotation = (await request("/api/rotation/start", "POST", {}, csrf, cookie))
      .body;
    failDelete = true;
    result = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: rotation.order[0] },
      csrf,
      cookie,
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "partial_failure");
    assert.equal(archiveAdds, 1);
    assert.equal(deletes, 1);
    const retry = await request(
      "/api/rotation/retry",
      "POST",
      { operationId: result.body.error.operationId },
      csrf,
      cookie,
    );
    assert.equal(retry.status, 200);
    assert.equal(archiveAdds, 1);
    assert.equal(deletes, 2);
    assert.equal(retry.body.rotation.order.length, 0);

    const fresh = (
      await request("/api/rotation/start", "POST", {}, csrf, cookie)
    ).body;
    archiveTimeout = true;
    const uncertain = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: fresh.order[0] },
      csrf,
      cookie,
    );
    assert.equal(uncertain.body.error.code, "archive_uncertain");
    const second = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: fresh.order[0] },
      csrf,
      cookie,
    );
    assert.equal(second.body.error.code, "archive_uncertain");
    assert.equal(archiveAdds, 2);

    otherTracks = [
      { ...track, uri: "spotify:track:bbb222" },
      { ...track, uri: "spotify:track:ccc333" },
    ];
    const two = (await request("/api/rotation/start", "POST", {}, csrf, cookie))
      .body;
    const first = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: two.order[0], removeWithoutArchive: true },
      csrf,
      cookie,
    );
    assert.equal(first.status, 200);
    const next = first.body.rotation;
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].position, 0);
    const final = await request(
      "/api/rotation/remove",
      "POST",
      { itemKey: next.order[0], removeWithoutArchive: true },
      csrf,
      cookie,
    );
    assert.equal(final.status, 200);
    assert.equal(final.body.rotation.order.length, 0);
  });
} finally {
  await app.close();
  globalThis.fetch = nativeFetch;
  rmSync(dataDir, { recursive: true, force: true });
}
