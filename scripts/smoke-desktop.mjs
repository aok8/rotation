#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const appRoot = process.argv[2] && resolve(process.argv[2]);
if (!appRoot) {
  console.error("Usage: node scripts/smoke-desktop.mjs <built-app-root>");
  process.exit(2);
}

const temp = await mkdtemp(join(tmpdir(), "rotation-desktop-smoke-"));
const configDir = join(temp, "config");
const dataDir = join(temp, "data");
await mkdir(configDir);
await writeFile(
  join(configDir, "config.json"),
  JSON.stringify({
    spotifyClientId: "fakeclientid123",
    spotifyClientSecret: "fakeclientsecret123",
    sessionSecret: "a".repeat(64),
  }),
);

const child = spawn(
  process.execPath,
  [
    join(appRoot, "desktop", "launcher.mjs"),
    "--no-open",
    "--port", "0",
    "--config-dir", configDir,
    "--data-dir", dataDir,
    "--app-root", appRoot,
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ROTATION_NODE_BIN: process.execPath } },
);
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

async function waitForExit(timeoutMs = 5000) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop launcher did not exit after Quit.")), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

try {
  const deadline = Date.now() + 20000;
  let url;
  while (Date.now() < deadline) {
    url = output.match(/Rotation is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) break;
    if (child.exitCode !== null) throw new Error(`Launcher exited early (${child.exitCode}).`);
    await delay(100);
  }
  if (!url) throw new Error("Launcher did not report readiness.");
  const health = await fetch(`${url}/health`);
  if (health.status !== 200 || JSON.stringify(await health.json()) !== '{"ok":true}')
    throw new Error("Health response was not the expected minimal result.");
  const sessionResponse = await fetch(`${url}/api/session`);
  const session = await sessionResponse.json();
  if (session.authenticated !== false || session.desktop !== true || !session.csrfToken)
    throw new Error("Unauthenticated desktop setup session is missing.");
  const unauthorized = await fetch(`${url}/api/playlists`);
  if (unauthorized.status !== 401) throw new Error("Private playlist API is not protected.");
  const quit = await fetch(`${url}/api/desktop/quit`, {
    method: "POST",
    headers: { Origin: url, "X-CSRF-Token": session.csrfToken },
  });
  if (quit.status !== 200) throw new Error(`Quit route returned ${quit.status}.`);
  const code = await waitForExit();
  if (code !== 0) throw new Error(`Launcher exited with ${code}.`);
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    throw new Error("Server still accepts connections after Quit.");
  } catch (error) {
    if (error.message === "Server still accepts connections after Quit.") throw error;
  }
  console.log("Desktop smoke passed: loopback startup, private API, Quit, and port release.");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
