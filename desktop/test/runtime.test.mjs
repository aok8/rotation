import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOOPBACK,
  childEnvironment,
  classifyExistingDesktop,
  readConfig,
  startSetup,
  userPaths,
} from "../runtime.mjs";

const temp = mkdtempSync(join(tmpdir(), "rotation-desktop-test-"));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
try {
  await test("per-user paths and child settings stay on loopback", () => {
    assert.equal(
      userPaths({ os: "linux", env: {}, home: "/home/user" }).configDir,
      "/home/user/.config/rotation",
    );
    assert.equal(
      userPaths({ os: "darwin", env: {}, home: "/Users/user" }).dataDir,
      "/Users/user/Library/Application Support/Rotation/data",
    );
    assert.match(
      userPaths({ os: "win32", env: {}, home: "C:\\Users\\user" }).configDir,
      /Rotation$/,
    );
    const env = childEnvironment({
      config: {
        spotifyClientId: "client123456",
        spotifyClientSecret: "secret123456",
        sessionSecret: "a".repeat(64),
      },
      dataDir: "/private/data",
      webDist: "/app/web/dist",
      port: 3000,
      parentEnv: {},
    });
    assert.equal(env.HOST, LOOPBACK);
    assert.equal(
      env.SPOTIFY_REDIRECT_URI,
      "http://127.0.0.1:3000/auth/callback",
    );
    assert.equal(env.APP_BASE_URL, "http://127.0.0.1:3000");
    assert.equal(env.DESKTOP_MODE, "1");
    assert.equal(env.DESKTOP_CONTROL_TOKEN.length, 64);
    assert.equal(env.MAC_LOCAL_SPOTIFY_PROBE, undefined);
    assert.equal(env.ROTATION_BUILD_ID, "");
    const macEnv = childEnvironment({
      config: {
        spotifyClientId: "client123456",
        spotifyClientSecret: "secret123456",
        sessionSecret: "a".repeat(64),
      },
      dataDir: "/private/data",
      webDist: "/app/web/dist",
      port: 3000,
      parentEnv: { MAC_LOCAL_SPOTIFY_PROBE: "1" },
      buildId: "c".repeat(32),
    });
    assert.equal(macEnv.MAC_LOCAL_SPOTIFY_PROBE, undefined);
    assert.equal(macEnv.ROTATION_BUILD_ID, "c".repeat(32));
    assert.equal(
      classifyExistingDesktop(
        { desktop: true, desktopBuildId: "c".repeat(32) },
        "c".repeat(32),
      ),
      "same",
    );
    assert.equal(
      classifyExistingDesktop({ desktop: true }, "c".repeat(32)),
      "different",
    );
    assert.equal(
      classifyExistingDesktop({ desktop: false }, "c".repeat(32)),
      "foreign",
    );
  });
  await test("launcher rejects another build already serving the loopback port", async () => {
    const appRoot = join(temp, "build-check");
    mkdirSync(join(appRoot, "server", "dist"), { recursive: true });
    mkdirSync(join(appRoot, "web", "dist"), { recursive: true });
    writeFileSync(join(appRoot, "server", "dist", "index.js"), "");
    writeFileSync(join(appRoot, "web", "dist", "index.html"), "");
    writeFileSync(
      join(appRoot, "build-manifest.json"),
      JSON.stringify({ buildId: "c".repeat(32) }),
    );
    let runningBuildId = "d".repeat(32);
    const server = createHttpServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ desktop: true, desktopBuildId: runningBuildId }),
      );
    });
    await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
    const port = server.address().port;
    const command = [
      join(import.meta.dirname, "..", "launcher.mjs"),
      "--no-open",
      "--app-root",
      appRoot,
      "--port",
      String(port),
    ];
    try {
      await assert.rejects(
        promisify(execFile)(process.execPath, command, { timeout: 5000 }),
        (error) =>
          error.code === 16 && /different Rotation build/.test(error.stderr),
      );
      runningBuildId = "c".repeat(32);
      const reused = await promisify(execFile)(process.execPath, command, {
        timeout: 5000,
      });
      assert.equal(reused.stderr, "");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await test("first-run setup requires same-origin nonce before saving credentials", async () => {
    const port = await freePort();
    const configDir = join(temp, "config");
    const setup = await startSetup({ port, configDir, buildId: "c".repeat(32) });
    try {
      const page = await fetch(setup.url);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("referrer-policy"), "same-origin");
      const html = await page.text();
      assert.match(html, /<meta name="rotation-build-id" content="c{32}">/);
      assert.match(html, new RegExp(`127\\.0\\.0\\.1:${port}/auth/callback`));
      const cookie = page.headers.get("set-cookie").split(";")[0];
      const nonce = html.match(/name="nonce" value="([a-f0-9]+)"/)[1];
      const body = new URLSearchParams({
        nonce,
        clientId: "client123456",
        clientSecret: "secret123456",
      });
      const denied = await fetch(`${setup.url}/save`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://example.com" },
        body,
      });
      assert.equal(denied.status, 403);
      const opaque = await fetch(`${setup.url}/save`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "null" },
        body,
      });
      assert.equal(opaque.status, 403);
      assert.equal(await readConfig(configDir), null);
      const saved = await fetch(`${setup.url}/save`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: setup.url },
        body,
      });
      assert.equal(saved.status, 200);
      const config = await setup.completion;
      assert.equal(config.spotifyClientId, "client123456");
      assert.equal((await readConfig(configDir)).sessionSecret.length, 64);
      assert.equal(
        JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))
          .spotifyClientSecret,
        "secret123456",
      );
      if (process.platform !== "win32")
        assert.equal(
          statSync(join(configDir, "config.json")).mode & 0o777,
          0o600,
        );
    } finally {
      await new Promise((resolve) => setup.server.close(resolve));
    }
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
