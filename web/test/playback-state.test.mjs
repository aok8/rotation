import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLocalTrackEnded,
  reconcileSdkState,
} from "../src/playback-state.ts";

const uri = "spotify:track:example";
const input = {
  desiredUri: uri,
  playingIntent: true,
  position: 35_000,
  expectedDuration: 180_000,
};
const sdkState = (paused, position, duration = 180_000, trackUri = uri) => ({
  paused,
  position,
  duration,
  track_window: { current_track: { uri: trackUri } },
});

test("paused transfer snapshot does not stop play intent or rewind progress", () => {
  const result = reconcileSdkState(sdkState(true, 30_000, 30_000), input);
  assert.equal(result.playback.paused, false);
  assert.equal(result.playback.duration, 180_000);
  assert.equal(result.position, 35_000);
  assert.equal(result.phase, null);
  assert.equal(result.ended, false);
});

test("old device or track snapshot is ignored while this track plays", () => {
  assert.equal(
    reconcileSdkState(
      sdkState(true, 8_000, 180_000, "spotify:track:old"),
      input,
    ),
    null,
  );
});

test("a paused snapshot at the actual track end advances", () => {
  const result = reconcileSdkState(sdkState(true, 179_700), input);
  assert.equal(result.ended, true);
});

test("after explicit pause, paused SDK state is accepted", () => {
  const result = reconcileSdkState(sdkState(true, 36_000), {
    ...input,
    playingIntent: false,
  });
  assert.equal(result.playback.paused, true);
  assert.equal(result.phase, "paused");
  assert.equal(result.position, 36_000);
});

test("local clock advances at duration when SDK end event never arrives", () => {
  assert.equal(hasLocalTrackEnded(true, true, 180_000, 180_000), true);
  assert.equal(hasLocalTrackEnded(true, true, 179_750, 180_000), false);
  assert.equal(hasLocalTrackEnded(false, true, 180_000, 180_000), false);
  assert.equal(hasLocalTrackEnded(true, false, 180_000, 180_000), false);
});
