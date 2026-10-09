import assert from "node:assert/strict";
import test from "node:test";
import { safePlaybackDiagnostics } from "../src/playback-diagnostics.ts";

test("copied playback logs exclude track, device, token, and query details", () => {
  const safe = safePlaybackDiagnostics({
    buildId: "abc123",
    cooldownUntil: null,
    entries: [{
      id: "operation-1",
      at: 1000,
      method: "PUT",
      endpoint: "/me/player/play?device_id=secret-device",
      status: 204,
      elapsedMs: 120,
      reason: "NO_ACTIVE_DEVICE",
      outcome: "accepted",
      uri: "spotify:track:secret-track",
      token: "secret-token",
    }],
  });
  const copied = JSON.stringify(safe);
  assert.match(copied, /abc123/);
  assert.match(copied, /NO_ACTIVE_DEVICE|accepted/);
  assert.doesNotMatch(copied, /secret-device|secret-track|secret-token/);
});
