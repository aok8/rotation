#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
const temp = await mkdtemp(join(tmpdir(), "rotation-macos-setup-"));
const configDir = join(temp, "config");
const dataDir = join(temp, "data");
await mkdir(configDir);

const open = spawn("open", [
  "-W", "-n", "-a", bundle, "--args",
  "--no-open", "--port", String(port),
  "--config-dir", configDir, "--data-dir", dataDir,
], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
open.stdout.on("data", (data) => { output += data.toString(); });
open.stderr.on("data", (data) => { output += data.toString(); });

function waitForExit(timeoutMs = 12_000) {
  if (open.exitCode !== null) return Promise.resolve(open.exitCode);
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`First-run app did not exit: ${output}`)), timeoutMs);
    open.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
}

try {
  const deadline = Date.now() + 30_000;
  let setup;
  while (Date.now() < deadline) {
    if (open.exitCode !== null) throw new Error(`App exited before setup opened: ${output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const html = await response.text();
      if (response.ok && html.includes("<title>Set up rotation</title>")) {
        setup = { html, cookie: response.headers.get("set-cookie")?.split(";")[0] };
        break;
      }
    } catch {}
    await delay(200);
  }
  if (!setup) throw new Error(`First-run setup did not listen: ${output}`);
  const nonce = setup.html.match(/name="nonce" value="([a-f0-9]+)"/)?.[1];
  if (!nonce || !setup.cookie) throw new Error("First-run setup lacked its local control token.");
  const quit = await fetch(`${url}/quit`, {
    method: "POST",
    headers: {
      Origin: url,
      Cookie: setup.cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ nonce }),
  });
  if (!quit.ok) throw new Error(`First-run Quit returned ${quit.status}.`);
  const code = await waitForExit();
  if (code !== 0) throw new Error(`First-run Launch Services returned ${code}: ${output}`);
  console.log("macOS first-run smoke passed: setup listener and Quit through Launch Services.");
} finally {
  if (open.exitCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const html = await response.text();
      const nonce = html.match(/name="nonce" value="([a-f0-9]+)"/)?.[1];
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      if (nonce && cookie)
        await fetch(`${url}/quit`, {
          method: "POST",
          headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ nonce }),
          signal: AbortSignal.timeout(500),
        });
      await waitForExit(4000);
    } catch {
      open.kill("SIGTERM");
    }
  }
  await rm(temp, { recursive: true, force: true });
}
