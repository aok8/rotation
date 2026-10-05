#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "darwin") throw new Error("This smoke test requires macOS.");
const bundle = process.argv[2] && resolve(process.argv[2]);
if (!bundle?.endsWith(".app")) throw new Error("Pass the staged Rotation.app path.");

const listener = createServer();
await new Promise((done, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", done);
});
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const url = `http://127.0.0.1:${port}`;
const temp = await mkdtemp(join(tmpdir(), "rotation-macos-launch-"));
const configDir = join(temp, "config");
const dataDir = join(temp, "data");
await mkdir(configDir);
await writeFile(join(configDir, "config.json"), JSON.stringify({
  spotifyClientId: "fakeclientid123",
  spotifyClientSecret: "fakeclientsecret123",
  sessionSecret: "a".repeat(64),
}));

const open = spawn("open", [
  "-W", "-n", "-a", bundle, "--args",
  "--no-open", "--port", String(port),
  "--config-dir", configDir, "--data-dir", dataDir,
], { stdio: ["ignore", "pipe", "pipe"] });
let launchOutput = "";
open.stdout.on("data", (data) => { launchOutput += data.toString(); });
open.stderr.on("data", (data) => { launchOutput += data.toString(); });

function waitForExit(timeoutMs = 12_000) {
  if (open.exitCode !== null) return Promise.resolve(open.exitCode);
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Launch Services app did not exit: ${launchOutput}`)), timeoutMs);
    open.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
}

try {
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (open.exitCode !== null) throw new Error(`Launch Services exited early: ${launchOutput}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      healthy = response.ok && (await response.json()).ok === true;
      if (healthy) break;
    } catch {}
    await delay(200);
  }
  if (!healthy) throw new Error(`App did not become healthy after Launch Services open: ${launchOutput}`);
  execFileSync("xcrun", ["swift", resolve("scripts/verify-macos-launch.swift"), bundle], { stdio: "inherit" });
  const session = await (await fetch(`${url}/api/session`)).json();
  if (session.desktop !== true || !session.csrfToken)
    throw new Error("Desktop control session was unavailable.");
  const quit = await fetch(`${url}/api/desktop/quit`, {
    method: "POST",
    headers: { Origin: url, "X-CSRF-Token": session.csrfToken },
  });
  if (!quit.ok) throw new Error(`Quit returned ${quit.status}.`);
  const code = await waitForExit();
  if (code !== 0) throw new Error(`Launch Services returned ${code}: ${launchOutput}`);
  console.log("macOS Launch Services smoke passed: AppKit launch, local server, and Quit.");
} finally {
  if (open.exitCode === null) {
    try {
      const session = await (await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(500) })).json();
      if (session.desktop && session.csrfToken)
        await fetch(`${url}/api/desktop/quit`, {
          method: "POST",
          headers: { Origin: url, "X-CSRF-Token": session.csrfToken },
          signal: AbortSignal.timeout(500),
        });
      await waitForExit(4000);
    } catch {
      open.kill("SIGTERM");
    }
  }
  await rm(temp, { recursive: true, force: true });
}
