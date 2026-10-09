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
const playbackCommands = [];
let currentPlayback = null;
let playbackStateReads = 0;
let rateLimitState = false;
let rateLimitRefresh = false;
let deviceRestricted = false;
let deviceAvailable = true;
let deviceEntries = null;
let failPlay = false;
let noActivePlay = false;
let nextUri = null;
let queuedUri = null;
let failNext = false;
let activateOnTransfer = true;
let heldPlay = null;
let userId = "user";
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
  if (url.startsWith("https://accounts.spotify.com/api/token") && rateLimitRefresh) {
    rateLimitRefresh = false;
    return new Response(JSON.stringify({ error: "rate_limited" }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "121" } });
  }
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
    return response({ id: userId, display_name: "Listener" });
  if (u.pathname === "/v1/me/player/devices")
    return response({
      devices:
        deviceEntries ??
        (deviceAvailable
          ? [
              {
                id: "device12345",
                name: "Desk",
                type: "Computer",
                is_active: true,
                is_restricted: deviceRestricted,
                volume_percent: 50,
              },
            ]
          : []),
    });
  if (u.pathname === "/v1/me/player" && init.method !== "PUT") {
    playbackStateReads++;
    if (rateLimitState) {
      rateLimitState = false;
      return new Response(JSON.stringify({ error: { message: "private upstream diagnostic", reason: "UNLISTED" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
    }
    return currentPlayback
      ? response(currentPlayback)
      : new Response(null, { status: 204 });
  }
  if (u.pathname === "/v1/me/player/queue")
    return response({ currently_playing: currentPlayback?.item || null,
      queue: queuedUri ? [{ uri: queuedUri }] : [] });
  if (u.pathname === "/v1/me/player" && init.method === "PUT") {
    const body = JSON.parse(init.body);
    playbackCommands.push({ path: u.pathname, body });
    if (activateOnTransfer) {
      for (const entry of deviceEntries || [])
        entry.is_active = entry.id === body.device_ids[0];
      if (currentPlayback)
        currentPlayback.device = { id: body.device_ids[0], is_active: true, is_restricted: false };
    }
    return new Response(null, { status: 204 });
  }
  if (u.pathname === "/v1/me/player/next" && init.method === "POST") {
    playbackCommands.push({ path: u.pathname, deviceId: u.searchParams.get("device_id") });
    if (failNext) {
      failNext = false;
      return response({ error: { status: 502, message: "temporary" } }, 502);
    }
    if (nextUri && currentPlayback)
      currentPlayback.item = { ...track, uri: nextUri };
    return new Response(null, { status: 204 });
  }
  if (
    (u.pathname === "/v1/me/player/pause" ||
      u.pathname === "/v1/me/player/play" ||
      u.pathname === "/v1/me/player/seek" ||
      u.pathname === "/v1/me/player/shuffle" ||
      u.pathname === "/v1/me/player/repeat") &&
    init.method === "PUT"
  ) {
    if (u.pathname === "/v1/me/player/play" && noActivePlay) {
      noActivePlay = false;
      playbackCommands.push({ path: u.pathname, deviceId: u.searchParams.get("device_id"), body: JSON.parse(init.body) });
      return response({ error: { status: 404, message: "No active device found", reason: "NO_ACTIVE_DEVICE" } }, 404);
    }
    if (u.pathname === "/v1/me/player/play" && failPlay) {
      failPlay = false;
      return response({ error: "device error" }, 502);
    }
    playbackCommands.push({
      path: u.pathname,
      deviceId: u.searchParams.get("device_id"),
      body: init.body ? JSON.parse(init.body) : null,
      positionMs: u.searchParams.get("position_ms"),
    });
    if (u.pathname === "/v1/me/player/play" && heldPlay) {
      const held = heldPlay;
      heldPlay = null;
      held.started();
      await held.resume;
    }
    if (u.pathname === "/v1/me/player/shuffle" && currentPlayback)
      currentPlayback.shuffle_state = u.searchParams.get("state") === "true";
    if (u.pathname === "/v1/me/player/repeat" && currentPlayback)
      currentPlayback.repeat_state = u.searchParams.get("state");
    return new Response("device12345", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
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
const { store, save } = await import("../dist/store.js");
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
    const unauthenticatedControl = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "pause" },
    );
    assert.equal(unauthenticatedControl.status, 401);
    const noCsrfControl = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "pause" },
      undefined,
      cookie,
    );
    assert.equal(noCsrfControl.status, 403);
    const invalidControl = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "stop" },
      csrf,
      cookie,
    );
    assert.equal(invalidControl.status, 400);
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
    assert.deepEqual(
      (
        await request(
          "/api/playback/state",
          "GET",
          undefined,
          undefined,
          cookie,
        )
      ).body,
      {
        deviceId: null,
        uri: null,
        positionMs: 0,
        durationMs: 0,
        isPlaying: false,
      },
    );
    const deviceList = await request(
      "/api/playback/devices",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(deviceList.body.activeDeviceId, "device12345");
    assert.equal(deviceList.headers.get("cache-control"), "no-store");
    const play = await request(
      "/api/playback",
      "PUT",
      { deviceId: "device12345", uri: track.uri, positionMs: 2000 },
      csrf,
      cookie,
    );
    assert.equal(play.status, 200);
    assert.equal(play.body.queuedThroughIndex, 0);
    assert.deepEqual(playbackCommands.at(-1).body.uris, [track.uri]);
    assert.equal(playbackCommands.at(-1).body.position_ms, 2000);
    currentPlayback = {
      device: { id: "device12345", is_active: true, is_restricted: false },
      currently_playing_type: "track",
      item: track,
      progress_ms: 2500,
      is_playing: true,
    };
    const observed = await request(
      "/api/playback/state",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.deepEqual(observed.body, {
      deviceId: "device12345",
      uri: track.uri,
      positionMs: 2500,
      durationMs: 120000,
      isPlaying: true,
    });
    const paused = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "pause" },
      csrf,
      cookie,
    );
    assert.deepEqual(paused.body, { ok: true });
    const seeked = await request(
      "/api/playback/seek",
      "PUT",
      { deviceId: "device12345", positionMs: 4000 },
      csrf,
      cookie,
    );
    assert.deepEqual(seeked.body, { ok: true });
    currentPlayback = {
      ...currentPlayback,
      item: { ...track, uri: "spotify:track:elsewhere" },
    };
    const mismatch = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "resume" },
      csrf,
      cookie,
    );
    assert.equal(mismatch.body.error.code, "playback_mismatch");
    currentPlayback = { ...currentPlayback, item: track };
    deviceRestricted = true;
    currentPlayback.device.is_restricted = true;
    const restricted = await request(
      "/api/playback",
      "PUT",
      { deviceId: "device12345", uri: track.uri },
      csrf,
      cookie,
    );
    assert.equal(restricted.body.error.code, "restricted_device");
    deviceRestricted = false;
    deviceAvailable = false;
    currentPlayback.device.is_active = false;
    const gone = await request(
      "/api/playback",
      "PUT",
      { deviceId: "device12345", uri: track.uri },
      csrf,
      cookie,
    );
    assert.equal(gone.body.error.code, "no_device");
    deviceAvailable = true;
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
    currentPlayback = {
      device: { id: "device12345" },
      currently_playing_type: "track",
      item: { ...track, uri: next.items[0].uri },
      progress_ms: 1000,
      is_playing: true,
    };
    const finalPause = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "device12345", action: "pause", uri: next.items[0].uri },
      csrf,
      cookie,
    );
    assert.equal(finalPause.status, 200);
    const badPause = await request(
      "/api/playback/control",
      "PUT",
      {
        deviceId: "device12345",
        action: "pause",
        uri: "spotify:track:unrelated",
      },
      csrf,
      cookie,
    );
    assert.equal(badPause.body.error.code, "playback_mismatch");

    deviceEntries = [{ id: null, name: "Mac", type: "Computer", is_active: true, is_restricted: false }];
    const nullIdList = await request("/api/playback/devices", "GET", undefined, undefined, cookie);
    assert.equal(nullIdList.body.activeDeviceId, null);
    assert.equal(nullIdList.body.devices[0].id, null);
    const nullIdPlay = await request("/api/playback", "PUT", { deviceId: "active", uri: track.uri }, csrf, cookie);
    assert.equal(nullIdPlay.body.error.code, "invalid_playback");
    deviceEntries = null;
    currentPlayback = null;
  });
  await test("direct play avoids transfer; explicit no-active 404 gets one fallback", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const csrf = store.session.csrf;
    otherTracks = [track, { ...track, uri: "spotify:track:second123" }];
    const fresh = (await request("/api/rotation/start", "POST", {}, csrf, cookie)).body;
    const first = fresh.items.find((item) => item.key === fresh.order[0]);
    deviceEntries = [
      { id: "desktop123", name: "Desktop", type: "Computer", is_active: false, is_restricted: false },
      { id: "phone123", name: "Phone", type: "Smartphone", is_active: true, is_restricted: false },
    ];
    currentPlayback = {
      device: { id: "phone123", is_active: true, is_restricted: false }, currently_playing_type: "track",
      item: track, is_playing: false, shuffle_state: false, repeat_state: "off",
    };
    const before = playbackCommands.length;
    const played = await request("/api/playback", "PUT", { deviceId: "desktop123", uri: first.uri }, csrf, cookie);
    assert.equal(played.status, 200);
    assert.equal(played.body.queuedThroughIndex, 0, "inactive target gets provisional one-URI window");
    assert.deepEqual(playbackCommands.slice(before).map((x) => x.path), ["/v1/me/player/play"]);
    assert.equal(deviceEntries[0].is_active, false, "no speculative transfer");

    noActivePlay = true;
    const fallbackStart = playbackCommands.length;
    const fallback = await request("/api/playback", "PUT", { deviceId: "desktop123", uri: first.uri }, csrf, cookie);
    assert.equal(fallback.status, 200);
    assert.deepEqual(playbackCommands.slice(fallbackStart).map((x) => x.path),
      ["/v1/me/player/play", "/v1/me/player", "/v1/me/player/play"]);
    assert.equal(deviceEntries[0].is_active, true);
    assert.equal(playbackCommands[fallbackStart + 1].body.play, true);

    const activeStart = playbackCommands.length;
    const active = await request("/api/playback", "PUT", { deviceId: "desktop123", uri: first.uri }, csrf, cookie);
    assert.equal(active.status, 200);
    assert.equal(active.body.queuedThroughIndex, 1, "known safe modes get ordered window");
    assert.deepEqual(playbackCommands.slice(activeStart).map((x) => x.path), ["/v1/me/player/play"]);
    currentPlayback.shuffle_state = true;
    const modeBlocked = await request("/api/playback", "PUT", { deviceId: "desktop123", uri: first.uri }, csrf, cookie);
    assert.equal(modeBlocked.body.error.code, "playback_mode");
    currentPlayback.shuffle_state = false;
    deviceEntries = null;
  });
  await test("native Next checks live queue and confirms before committing index", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const csrf = store.session.csrf;
    otherTracks = [track, { ...track, uri: "spotify:track:next456" }];
    const r = (await request("/api/rotation/start", "POST", {}, csrf, cookie)).body;
    const first = r.items.find((item) => item.key === r.order[0]);
    const second = r.items.find((item) => item.key === r.order[1]);
    currentPlayback = { device: { id: "device12345", is_active: true, is_restricted: false },
      currently_playing_type: "track", item: { ...track, uri: first.uri },
      is_playing: true, shuffle_state: false, repeat_state: "off" };
    const play = await request("/api/playback", "PUT", { deviceId: "device12345", uri: first.uri }, csrf, cookie);
    assert.equal(play.body.queuedThroughIndex, 1);
    queuedUri = "spotify:track:unexpected";
    const before = playbackCommands.length;
    const refused = await request("/api/rotation/navigate", "POST", { direction: "next", deviceId: "device12345" }, csrf, cookie);
    assert.equal(refused.body.error.code, "queue_mismatch");
    assert.equal(playbackCommands.length, before);
    assert.equal(store.session.rotation.currentIndex, 0);
    queuedUri = second.uri;
    nextUri = second.uri;
    const confirmed = await request("/api/rotation/navigate", "POST", { direction: "next", deviceId: "device12345" }, csrf, cookie);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.playbackConfirmed, true);
    assert.equal(confirmed.body.currentIndex, 1);
    assert.deepEqual(playbackCommands.slice(before).map((entry) => entry.path), ["/v1/me/player/next"]);
    queuedUri = null;
    nextUri = null;
  });
  await test("adjacent duplicate URI uses explicit play instead of native Next", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const csrf = store.session.csrf;
    otherTracks = [track, track];
    const r = (await request("/api/rotation/start", "POST", {}, csrf, cookie)).body;
    currentPlayback = { device: { id: "device12345", is_active: true, is_restricted: false },
      currently_playing_type: "track", item: track, is_playing: true,
      shuffle_state: false, repeat_state: "off" };
    const play = await request("/api/playback", "PUT", { deviceId: "device12345", uri: track.uri }, csrf, cookie);
    assert.equal(play.body.queuedThroughIndex, 1);
    const before = playbackCommands.length;
    const result = await request("/api/rotation/navigate", "POST", { direction: "next", deviceId: "device12345" }, csrf, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.currentIndex, 1);
    assert.equal(result.body.playbackConfirmed, undefined);
    assert.deepEqual(playbackCommands.slice(before).map((entry) => entry.path), ["/v1/me/player/play"]);
    assert.equal(playbackCommands.at(-1).body.uris[0], track.uri);
    assert.equal(store.session.rotation.currentIndex, 1);
  });
  await test("fallback refuses unconfirmed transfer without a second play", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const r = store.session.rotation;
    const item = r.items.find((x) => x.key === r.order[r.currentIndex]);
    deviceEntries = [
      { id: "sleeping-desktop", name: "Desktop", type: "Computer", is_active: false, is_restricted: false },
      { id: "phone123", name: "Phone", type: "Smartphone", is_active: true, is_restricted: false },
    ];
    currentPlayback.device = { id: "phone123", is_active: true };
    activateOnTransfer = false;
    noActivePlay = true;
    const before = playbackCommands.length;
    try {
      const result = await request("/api/playback", "PUT", { deviceId: "sleeping-desktop", uri: item.uri }, store.session.csrf, cookie);
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, "device_activation_failed");
      assert.deepEqual(playbackCommands.slice(before).map((x) => x.path),
        ["/v1/me/player/play", "/v1/me/player"]);
    } finally {
      activateOnTransfer = true;
      deviceEntries = null;
      currentPlayback.device = { id: "device12345", is_active: true };
    }
  });
  await test("playback diagnostic is private, single-read, and classifies Spotify state", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    otherTracks = [track, { ...track, uri: "spotify:track:diagnostic456" }];
    const fresh = (await request("/api/rotation/start", "POST", {}, store.session.csrf, cookie)).body;
    const first = fresh.items.find((item) => item.key === fresh.order[0]);
    currentPlayback = { device: { id: "device12345", is_active: true, is_restricted: false },
      currently_playing_type: "track", item: { ...track, uri: first.uri }, is_playing: true,
      shuffle_state: false, repeat_state: "off" };
    const prepared = await request("/api/playback", "PUT", { deviceId: "device12345", uri: first.uri }, store.session.csrf, cookie);
    assert.equal(prepared.status, 200);
    const r = store.session.rotation;
    const window = r.queuedWindow;
    const expected = r.items.find((x) => x.key === r.order[r.currentIndex]);
    const otherQueued = r.order
      .slice(r.currentIndex + 1, window.endIndex + 1)
      .map((key) => r.items.find((x) => x.key === key).uri)
      .find((uri) => uri !== expected.uri);
    const unauthenticated = await request("/api/playback/diagnostic");
    assert.equal(unauthenticated.status, 401);
    const before = playbackStateReads;
    currentPlayback = null;
    const idle = await request(
      "/api/playback/diagnostic",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(idle.body.state, "no_playback");
    assert.equal(idle.headers.get("cache-control"), "no-store");
    assert.equal(playbackStateReads, before + 1);
    currentPlayback = {
      device: { id: window.deviceId, is_active: true },
      currently_playing_type: "track",
      item: { ...track, uri: expected.uri, is_playable: true },
      is_playing: false,
      shuffle_state: false,
      repeat_state: "off",
    };
    const paused = await request(
      "/api/playback/diagnostic",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(paused.body.state, "expected_paused");
    currentPlayback.is_playing = true;
    currentPlayback.item = { ...track, uri: otherQueued };
    const skipped = await request(
      "/api/playback/diagnostic",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(skipped.body.state, "other_queued_track");
    currentPlayback.item = { ...track, uri: "spotify:track:outside123" };
    const wrong = await request(
      "/api/playback/diagnostic",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(wrong.body.state, "wrong_track");
    currentPlayback.device = { id: "another-device", is_active: true };
    const moved = await request(
      "/api/playback/diagnostic",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(moved.body.state, "other_device");
    for (const diagnostic of [idle, paused, skipped, wrong, moved]) {
      const body = JSON.stringify(diagnostic.body);
      assert.doesNotMatch(
        body,
        /spotify:track:|desktop123|another-device|Song|Artist/,
      );
    }
  });
  await test("overlapping playback mutations return 409 while Spotify play is pending", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const r = store.session.rotation;
    const item = r.items.find((x) => x.key === r.order[r.currentIndex]);
    currentPlayback = null;
    deviceEntries = null;
    let started;
    let release;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    heldPlay = { started, resume };
    const first = request(
      "/api/playback",
      "PUT",
      { deviceId: "device12345", uri: item.uri },
      store.session.csrf,
      cookie,
    );
    try {
      await began;
      const second = await request(
        "/api/playback",
        "PUT",
        { deviceId: "device12345", uri: item.uri },
        store.session.csrf,
        cookie,
      );
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "operation_in_progress");
      const navigate = await request(
        "/api/rotation/navigate",
        "POST",
        { direction: "next", deviceId: "device12345" },
        store.session.csrf,
        cookie,
      );
      assert.equal(navigate.status, 409);
      assert.equal(navigate.body.error.code, "operation_in_progress");
    } finally {
      release();
      heldPlay = null;
    }
    assert.equal((await first).status, 200);
  });
  await test("Player logs are private, 429 pauses polling, and deadline applies to the operation", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const ops = await import("../dist/player-ops.js");
    const unauthenticated = await request("/api/playback/logs");
    assert.equal(unauthenticated.status, 401);
    const logs = await request("/api/playback/logs", "GET", undefined, undefined, cookie);
    assert.equal(logs.status, 200);
    assert.equal(logs.headers.get("cache-control"), "no-store");
    assert.ok(logs.body.entries.length > 0);
    assert.doesNotMatch(JSON.stringify(logs.body), /spotify:track:|device12345|private upstream diagnostic/);
    rateLimitState = true;
    const limited = await request("/api/playback/state", "GET", undefined, undefined, cookie);
    assert.equal(limited.status, 429);
    const reads = playbackStateReads;
    const cooled = await request("/api/playback/state", "GET", undefined, undefined, cookie);
    assert.equal(cooled.body.error.code, "playback_cooldown");
    assert.equal(playbackStateReads, reads, "cooldown must block polling before Spotify API");
    const afterLimit = await request("/api/playback/logs", "GET", undefined, undefined, cookie);
    assert.ok(afterLimit.body.cooldownUntil > Date.now());
    assert.ok(afterLimit.body.entries.some((entry) => entry.status === 429 && entry.retryAfter === 2));
    ops.resetPlayerSession(store.session);
    const oldExpiry = store.session.tokens.expiresAt;
    store.session.tokens.expiresAt = 0;
    rateLimitRefresh = true;
    const refreshLimited = await request("/api/playback/state", "GET", undefined, undefined, cookie);
    assert.equal(refreshLimited.status, 429);
    assert.equal(refreshLimited.body.error.spotifyStatus, 429);
    assert.equal(refreshLimited.headers.get("retry-after"), "121");
    const refreshLogs = await request("/api/playback/logs", "GET", undefined, undefined, cookie);
    assert.ok(refreshLogs.body.cooldownUntil > Date.now());
    store.session.tokens.expiresAt = oldExpiry;
    ops.resetPlayerSession(store.session);
    await assert.rejects(
      ops.runPlayerOperation(store.session, async () => {
        await new Promise((resolve, reject) => {
          const signal = ops.currentPlayerOperation().signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }, 20),
      (error) => error.code === "playback_timeout",
    );
    assert.ok(ops.playerLogs(store.session).cooldownUntil > Date.now());
    ops.resetPlayerSession(store.session);
  });
  await test("OAuth reconnect requires new scope and preserves only same-account settings", async () => {
    store.session.grantedScopes = undefined;
    save();
    const stale = await request(
      "/api/playback/devices",
      "GET",
      undefined,
      undefined,
      `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`,
    );
    assert.equal(stale.body.error.code, "reauthorization_required");
    async function reconnect() {
      const start = await request("/auth/start");
      const state = new URL(start.headers.get("location")).searchParams.get(
        "state",
      );
      const oauthCookie = start.headers.get("set-cookie").split(";")[0];
      return request(
        `/auth/callback?code=code&state=${state}`,
        "GET",
        undefined,
        undefined,
        oauthCookie,
      );
    }
    await reconnect();
    assert.equal(store.session.settings.sourceId, "source12345");
    assert.ok(store.session.grantedScopes.includes("user-read-playback-state"));
    userId = "different-user";
    await reconnect();
    assert.equal(store.session.user.id, "different-user");
    assert.equal(store.session.settings, undefined);
    assert.equal(store.session.rotation, undefined);
    assert.deepEqual(store.session.operations, []);
  });
} finally {
  await app.close();
  globalThis.fetch = nativeFetch;
  rmSync(dataDir, { recursive: true, force: true });
}
