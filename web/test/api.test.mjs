import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "../src/api.ts";

test("macOS Automation denial keeps its actionable recovery guidance", () => {
  const error = Object.assign(new Error("denied"), {
    code: "mac_automation_denied",
    status: 403,
  });
  assert.match(describeError(error), /System Settings.*Automation/);
});
