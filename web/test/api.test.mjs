import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "../src/api.ts";

test("playback cooldown has a specific recovery message", () => {
  const error = Object.assign(new Error("cooldown"), {
    code: "playback_cooldown",
    status: 429,
    retryAfter: 9,
  });
  assert.match(describeError(error), /about 9 seconds/);
});
