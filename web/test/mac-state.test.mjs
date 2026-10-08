import assert from "node:assert/strict";
import test from "node:test";
import { macDisplayPosition, macPlaybackAction, macPlaybackMessage } from "../src/mac-state.ts";

const base = {
  active: true,
  state: "playing",
  uri: "spotify:track:selected",
  positionMs: 1000,
  durationMs: 180000,
  observedAtMs: 1000,
  currentIndex: 0,
  autoAdvance: true,
};

test("local controls pause or resume only the confirmed selected track", () => {
  assert.equal(macPlaybackAction(base, base.uri), "pause");
  assert.equal(macPlaybackAction({ ...base, state: "paused" }, base.uri), "resume");
  assert.equal(macPlaybackAction({ ...base, active: false }, base.uri), "start");
  assert.equal(macPlaybackAction({ ...base, uri: "spotify:track:other" }, base.uri), "start");
  assert.equal(macPlaybackAction({ ...base, state: "other_track" }, base.uri), "start");
  assert.equal(macPlaybackAction(null, base.uri), "start");
});

test("cached local position advances smoothly without moving paused or mismatched playback", () => {
  assert.equal(macDisplayPosition(base, base.uri, 6000), 6000);
  assert.equal(macDisplayPosition({ ...base, positionMs: 179000 }, base.uri, 6000), 180000);
  assert.equal(macDisplayPosition({ ...base, state: "paused" }, base.uri, 6000), 1000);
  assert.equal(macDisplayPosition({ ...base, active: false }, base.uri, 6000), 0);
  assert.equal(macDisplayPosition(base, "spotify:track:other", 6000), 0);
});

test("local playback status distinguishes background continuation and recovery", () => {
  assert.match(macPlaybackMessage(base), /continues while this page is in the background/);
  assert.match(macPlaybackMessage({ ...base, active: false, reason: "other_track" }), /Press Play to resume/);
  assert.match(macPlaybackMessage({ ...base, active: false, reason: "unconfirmed" }), /did not confirm/);
  assert.match(macPlaybackMessage({ ...base, active: false, reason: "ended" }), /end of this rotation/);
});
