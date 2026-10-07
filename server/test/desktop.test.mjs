import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir = mkdtempSync(join(tmpdir(), "rotation-desktop-api-test-"));
process.env.SPOTIFY_CLIENT_ID = "client123456";
process.env.SPOTIFY_CLIENT_SECRET = "secret123456";
process.env.SPOTIFY_REDIRECT_URI = "http://127.0.0.1:3000/auth/callback";
process.env.SESSION_SECRET = "a".repeat(64);
process.env.APP_BASE_URL = "http://127.0.0.1:3000";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.DESKTOP_MODE = "1";
process.env.DESKTOP_CONTROL_TOKEN = "b".repeat(64);
process.env.ROTATION_BUILD_ID = "c".repeat(32);
const { app } = await import("../dist/index.js");
const base = `http://127.0.0.1:${app.server.address().port}`;
try {
  await test("desktop quit is loopback mode only and requires same-origin CSRF", async () => {
    const session = await (await fetch(`${base}/api/session`)).json();
    assert.equal(session.desktop, true);
    assert.equal(session.desktopBuildId, "c".repeat(32));
    assert.equal(session.authenticated, false);
    const missing = await fetch(`${base}/api/desktop/quit`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    assert.equal(missing.status, 403);
    const foreign = await fetch(`${base}/api/desktop/quit`, {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "X-CSRF-Token": session.csrfToken,
      },
    });
    assert.equal(foreign.status, 403);
    const valid = await fetch(`${base}/api/desktop/quit`, {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "X-CSRF-Token": session.csrfToken,
      },
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { ok: true });
  });
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
