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
let deviceRestricted = false;
let deviceAvailable = true;
let deviceEntries = null;
let failPlay = false;
let activateOnTransfer = true;
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
  if (u.pathname === "/v1/me/player" && init.method !== "PUT")
    return currentPlayback
      ? response(currentPlayback)
      : new Response(null, { status: 204 });
  if (u.pathname === "/v1/me/player" && init.method === "PUT") {
    const body = JSON.parse(init.body);
    playbackCommands.push({ path: u.pathname, body });
    if (activateOnTransfer) {
      for (const entry of deviceEntries || [])
        entry.is_active = entry.id === body.device_ids[0];
      if (currentPlayback)
        currentPlayback.device = { id: body.device_ids[0], is_active: true };
    }
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
    assert.equal(play.body.queuedThroughIndex, 1);
    assert.deepEqual(playbackCommands.at(-1).body.uris, [track.uri, track.uri]);
    assert.equal(playbackCommands.at(-1).body.position_ms, 2000);
    currentPlayback = {
      device: { id: "device12345" },
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
    const gone = await request(
      "/api/playback",
      "PUT",
      { deviceId: "device12345", uri: track.uri },
      csrf,
      cookie,
    );
    assert.equal(gone.body.error.code, "no_device");
    deviceAvailable = true;
    failPlay = true;
    const failedNavigation = await request(
      "/api/rotation/navigate",
      "POST",
      { direction: "next", deviceId: "device12345" },
      csrf,
      cookie,
    );
    assert.equal(failedNavigation.status, 502);
    const unchanged = await request(
      "/api/rotation",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(unchanged.body.currentIndex, 0);
    const goodNavigation = await request(
      "/api/rotation/navigate",
      "POST",
      { direction: "next", deviceId: "device12345" },
      csrf,
      cookie,
    );
    assert.equal(goodNavigation.status, 200);
    assert.equal(goodNavigation.body.currentIndex, 1);
    const back = await request(
      "/api/rotation/navigate",
      "POST",
      { direction: "previous", deviceId: "device12345" },
      csrf,
      cookie,
    );
    assert.equal(back.body.currentIndex, 0);
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

    deviceEntries = [
      {
        id: null,
        name: "Mac",
        type: "Computer",
        is_active: true,
        is_restricted: false,
      },
      {
        id: null,
        name: "Sleeping Mac",
        type: "Computer",
        is_active: false,
        is_restricted: false,
      },
    ];
    const macList = await request(
      "/api/playback/devices",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(macList.body.activeDeviceId, "active");
    assert.equal(macList.body.devices[0].id, "active");
    assert.equal(macList.body.devices[1].id, null);
    deviceEntries[0].is_restricted = true;
    const restrictedMac = await request(
      "/api/playback/devices",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(restrictedMac.body.devices[0].id, null);
    deviceEntries[0].is_restricted = false;

    otherTracks = ["aaa111", "bbb222", "ccc333", "ddd444"].map((suffix) => ({
      ...track,
      uri: `spotify:track:${suffix}`,
    }));
    const macRotation = (
      await request("/api/rotation/start", "POST", {}, csrf, cookie)
    ).body;
    const macItems = new Map(macRotation.items.map((item) => [item.key, item]));
    const firstUri = macItems.get(macRotation.order[0]).uri;
    currentPlayback = {
      device: { id: null, is_active: true, is_restricted: false },
      currently_playing_type: "track",
      item: { ...track, uri: firstUri },
      progress_ms: 2000,
      is_playing: true,
    };
    const macPlay = await request(
      "/api/playback",
      "PUT",
      { deviceId: "active", uri: firstUri },
      csrf,
      cookie,
    );
    assert.equal(macPlay.body.queuedThroughIndex, 3);
    assert.equal(playbackCommands.at(-1).deviceId, null);
    const macState = await request(
      "/api/playback/state",
      "GET",
      undefined,
      undefined,
      cookie,
    );
    assert.equal(macState.body.deviceId, "active");
    const macPause = await request(
      "/api/playback/control",
      "PUT",
      { deviceId: "active", action: "pause" },
      csrf,
      cookie,
    );
    assert.equal(macPause.status, 200);
    assert.equal(playbackCommands.at(-1).deviceId, null);
    const macSeek = await request(
      "/api/playback/seek",
      "PUT",
      { deviceId: "active", positionMs: 1000 },
      csrf,
      cookie,
    );
    assert.equal(macSeek.status, 200);
    assert.equal(playbackCommands.at(-1).deviceId, null);
    const wrongLive = await request(
      "/api/rotation/sync",
      "POST",
      {
        targetIndex: 2,
        deviceId: "active",
        uri: macItems.get(macRotation.order[2]).uri,
        queuedThroughIndex: 3,
      },
      csrf,
      cookie,
    );
    assert.equal(wrongLive.body.error.code, "playback_mismatch");
    const forgedEnd = await request(
      "/api/rotation/sync",
      "POST",
      {
        targetIndex: 2,
        deviceId: "active",
        uri: macItems.get(macRotation.order[2]).uri,
        queuedThroughIndex: 99,
      },
      csrf,
      cookie,
    );
    assert.equal(forgedEnd.body.error.code, "sync_unavailable");
    const targetUri = macItems.get(macRotation.order[2]).uri;
    currentPlayback.item = { ...track, uri: targetUri };
    const synced = await request(
      "/api/rotation/sync",
      "POST",
      {
        targetIndex: 2,
        deviceId: "active",
        uri: targetUri,
        queuedThroughIndex: 3,
      },
      csrf,
      cookie,
    );
    assert.equal(synced.status, 200);
    assert.equal(synced.body.currentIndex, 2);
    const replay = await request(
      "/api/rotation/sync",
      "POST",
      {
        targetIndex: 2,
        deviceId: "active",
        uri: targetUri,
        queuedThroughIndex: 3,
      },
      csrf,
      cookie,
    );
    assert.equal(replay.body.error.code, "sync_unavailable");
    const macNext = await request(
      "/api/rotation/navigate",
      "POST",
      { direction: "next", deviceId: "active" },
      csrf,
      cookie,
    );
    assert.equal(macNext.status, 200);
    assert.equal(playbackCommands.at(-1).deviceId, null);

    deviceEntries = [
      {
        id: "mac:desktop/1",
        name: "Mac",
        type: "Computer",
        is_active: true,
        is_restricted: false,
      },
    ];
    currentPlayback.device = { id: "mac:desktop/1", is_active: true };
    const opaqueIdPlay = await request(
      "/api/playback",
      "PUT",
      {
        deviceId: "mac:desktop/1",
        uri: macItems.get(macRotation.order[3]).uri,
      },
      csrf,
      cookie,
    );
    assert.equal(opaqueIdPlay.status, 200);
    assert.equal(playbackCommands.at(-1).deviceId, "mac:desktop/1");
    deviceEntries = [
      {
        id: null,
        name: "Mac",
        type: "Computer",
        is_active: true,
        is_restricted: false,
      },
    ];
    currentPlayback.device = {
      id: null,
      is_active: true,
      is_restricted: false,
    };

    otherTracks = ["aaa111", "bbb222", "aaa111"].map((suffix) => ({
      ...track,
      uri: `spotify:track:${suffix}`,
    }));
    const repeatedRotation = (
      await request("/api/rotation/start", "POST", {}, csrf, cookie)
    ).body;
    const repeatedItems = new Map(
      repeatedRotation.items.map((item) => [item.key, item]),
    );
    const repeatedPlay = await request(
      "/api/playback",
      "PUT",
      {
        deviceId: "active",
        uri: repeatedItems.get(repeatedRotation.order[0]).uri,
      },
      csrf,
      cookie,
    );
    assert.equal(repeatedPlay.status, 200);
    const duplicateTarget = repeatedRotation.order.findIndex(
      (key, index) =>
        index > 0 && repeatedItems.get(key).uri === "spotify:track:aaa111",
    );
    currentPlayback.item = { ...track, uri: "spotify:track:aaa111" };
    const ambiguous = await request(
      "/api/rotation/sync",
      "POST",
      {
        targetIndex: duplicateTarget,
        deviceId: "active",
        uri: "spotify:track:aaa111",
        queuedThroughIndex: 2,
      },
      csrf,
      cookie,
    );
    assert.equal(ambiguous.body.error.code, "sync_ambiguous");
  });
  await test("inactive desktop device is activated and queue modes are cleared before play", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const csrf = store.session.csrf;
    const fresh = (
      await request("/api/rotation/start", "POST", {}, csrf, cookie)
    ).body;
    const first = fresh.items.find((item) => item.key === fresh.order[0]);
    deviceEntries = [
      {
        id: "desktop123",
        name: "Desktop",
        type: "Computer",
        is_active: false,
        is_restricted: false,
      },
      {
        id: "phone123",
        name: "Phone",
        type: "Smartphone",
        is_active: true,
        is_restricted: false,
      },
    ];
    currentPlayback = {
      device: { id: "phone123", is_active: true },
      currently_playing_type: "track",
      item: track,
      is_playing: false,
      shuffle_state: true,
      repeat_state: "context",
    };
    const before = playbackCommands.length;
    const played = await request(
      "/api/playback",
      "PUT",
      { deviceId: "desktop123", uri: first.uri },
      csrf,
      cookie,
    );
    assert.equal(played.status, 200);
    assert.deepEqual(
      playbackCommands.slice(before).map((command) => command.path),
      [
        "/v1/me/player",
        "/v1/me/player/shuffle",
        "/v1/me/player/repeat",
        "/v1/me/player/play",
      ],
    );
    assert.equal(deviceEntries[0].is_active, true);
    assert.equal(currentPlayback.shuffle_state, false);
    assert.equal(currentPlayback.repeat_state, "off");
    store.session.grantedScopes = store.session.grantedScopes.filter(
      (scope) => scope !== "user-modify-playback-state",
    );
    const denied = await request(
      "/api/playback",
      "PUT",
      { deviceId: "desktop123", uri: first.uri },
      csrf,
      cookie,
    );
    assert.equal(denied.body.error.code, "reauthorization_required");
    store.session.grantedScopes.push("user-modify-playback-state");
    deviceEntries = null;
  });
  await test("unconfirmed device transfer never sends a play command", async () => {
    const cookie = `rotation_session=${store.session.id}.${(await import("../dist/store.js")).sign(store.session.id)}`;
    const r = store.session.rotation;
    const item = r.items.find((x) => x.key === r.order[r.currentIndex]);
    deviceEntries = [
      {
        id: "sleeping-desktop",
        name: "Desktop",
        type: "Computer",
        is_active: false,
        is_restricted: false,
      },
      {
        id: "phone123",
        name: "Phone",
        type: "Smartphone",
        is_active: true,
        is_restricted: false,
      },
    ];
    activateOnTransfer = false;
    const before = playbackCommands.length;
    try {
      const result = await request(
        "/api/playback",
        "PUT",
        { deviceId: "sleeping-desktop", uri: item.uri },
        store.session.csrf,
        cookie,
      );
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, "device_activation_failed");
      assert.deepEqual(
        playbackCommands.slice(before).map((command) => command.path),
        ["/v1/me/player"],
      );
      assert.equal(store.session.rotation.currentIndex, r.currentIndex);
    } finally {
      activateOnTransfer = true;
      deviceEntries = null;
    }
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
