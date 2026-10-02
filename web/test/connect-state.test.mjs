import assert from "node:assert/strict";
import test from "node:test";
import { classifyRemotePlayback } from "../src/connect-state.ts";

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
