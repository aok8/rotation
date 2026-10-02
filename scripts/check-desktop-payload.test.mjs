import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-desktop-payload.mjs", import.meta.url));

test("payload check accepts built app files and rejects local credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "rotation-payload-"));
  try {
    mkdirSync(join(root, "server", "dist"), { recursive: true });
    writeFileSync(join(root, "server", "dist", "index.js"), "export {};\n");
    let result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    mkdirSync(join(root, "desktop"));
    writeFileSync(join(root, "desktop", ".env"), "SPOTIFY_CLIENT_SECRET=private\n");
    result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktop.*\.env/);

    writeFileSync(join(root, "session.enc"), "private");
    result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /session\.enc/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
