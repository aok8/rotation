import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRemotePlayback,
  chooseConnectDevice,
  findForwardMatch,
  navigationAvailable,
  pendingPlaybackStatus,
  unconfirmedPlaybackMismatch,
} from "../src/connect-state.ts";

const device = "desk";
const current = "spotify:track:current";
const next = "spotify:track:next";
const state = (uri, isPlaying, positionMs = 0, deviceId = device) => ({
  deviceId,
  uri,
  positionMs,
  durationMs: 180_000,
  isPlaying,
});
const classify = (remote, previous = 170_000, nextUri = next) =>
  classifyRemotePlayback(
    remote,
    device,
    current,
    nextUri,
    previous,
    180_000,
    true,
  );

test("current playback and an explicit pause retain current app item", () => {
  assert.equal(classify(state(current, true, 171_000)), "current-playing");
  assert.equal(classify(state(current, false, 179_500)), "current-paused");
});

test("Spotify auto-next advances only to expected shuffled item", () => {
  assert.equal(classify(state(next, true, 1_000), 175_000), "expected-next");
  assert.equal(classify(state(next, true, 1_000), 60_000), "other-track");
  assert.equal(classify(state("spotify:track:outside", true)), "other-track");
});

test("external device switch never advances the app order", () => {
  assert.equal(classify(state(next, true, 0, "phone")), "other-device");
  assert.equal(classify(state(next, true, 0, null)), "idle");
});

test("idle after confirmed near-end playback can advance", () => {
  assert.equal(classify(state(null, false, 0, null), 179_000), "ended");
  assert.equal(classify(state(null, false, 0, null), 80_000), "idle");
});

test("duplicate URI requires a position reset near the boundary", () => {
  assert.equal(
    classify(state(current, true, 8_000), 178_000, current),
    "expected-next",
  );
  assert.equal(
    classify(state(current, true, 120_000), 178_000, current),
    "current-playing",
  );
});

test("a unique queued track several positions ahead can catch up", () => {
  assert.deepEqual(
    findForwardMatch(["a", "b", "c", "d", "e"], 0, 4, "d"),
    { kind: "match", targetIndex: 3 },
  );
  assert.deepEqual(
    findForwardMatch(["a", "b", "c", "d", "e"], 0, 2, "d"),
    { kind: "none" },
  );
});

test("repeated URI in the queued window is ambiguous", () => {
  assert.deepEqual(findForwardMatch(["a", "b", "c", "b"], 0, 3, "b"), {
    kind: "ambiguous",
  });
  assert.deepEqual(findForwardMatch(["a", "b", "a"], 0, 2, "a"), {
    kind: "ambiguous",
  });
  assert.deepEqual(findForwardMatch(["a", "b"], 0, 1, "a"), {
    kind: "none",
  });
});

test("pending playback expires even without a poll or with a different device", () => {
  const startedAt = 1_000;
  assert.equal(
    pendingPlaybackStatus(null, device, current, startedAt, 20_999),
    "waiting",
  );
  assert.equal(
    pendingPlaybackStatus(null, device, current, startedAt, 21_000),
    "expired",
  );
  assert.equal(
    pendingPlaybackStatus(
      state(current, true, 0, "another-device"),
      device,
      current,
      startedAt,
      21_000,
    ),
    "expired",
  );
  assert.equal(
    pendingPlaybackStatus(state(next, true), device, current, startedAt, 21_000),
    "expired",
  );
  assert.equal(
    pendingPlaybackStatus(
      state(current, true),
      device,
      current,
      startedAt,
      21_000,
    ),
    "confirmed",
  );
});

test("navigation waits for Spotify confirmation, then unlocks", () => {
  assert.equal(navigationAvailable(current, false), false);
  assert.equal(navigationAvailable("", true), false);
  assert.equal(navigationAvailable("", false), true);
});

test("an unconfirmed command never adopts another queued song", () => {
  assert.equal(
    unconfirmedPlaybackMismatch(state(next, true), device, current),
    "other-track",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(current, true), device, current),
    "none",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(next, true, 0, "phone"), device, current),
    "other-device",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(null, false, 0, null), device, current),
    "no-playback",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(current, true, 0, null), device, current),
    "unknown-device",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(null, false), device, current),
    "selected-idle",
  );
  assert.equal(
    unconfirmedPlaybackMismatch(state(current, false), device, current),
    "selected-paused",
  );
});

test("local Mac probe requires explicit Connect device selection", () => {
  const available = [
    { id: "mac", name: "This Mac", type: "computer", isActive: true, isRestricted: false },
  ];
  assert.equal(chooseConnectDevice(available, "", null, "mac", true), "");
  assert.equal(chooseConnectDevice(available, "", null, "mac", false), "mac");
  assert.equal(chooseConnectDevice(available, "mac", "mac", "mac", true), "");
});
