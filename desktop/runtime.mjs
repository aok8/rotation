import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

export const LOOPBACK = "127.0.0.1";

export function userPaths({
  os = platform(),
  env = process.env,
  home = homedir(),
} = {}) {
  if (os === "win32") {
    return {
      configDir: win32.join(
        env.APPDATA || win32.join(home, "AppData", "Roaming"),
        "Rotation",
      ),
      dataDir: win32.join(
        env.LOCALAPPDATA || win32.join(home, "AppData", "Local"),
        "Rotation",
        "data",
      ),
    };
  }
  if (os === "darwin") {
    const base = posix.join(home, "Library", "Application Support", "Rotation");
    return { configDir: base, dataDir: posix.join(base, "data") };
  }
  return {
    configDir: posix.join(
      env.XDG_CONFIG_HOME || posix.join(home, ".config"),
      "rotation",
    ),
    dataDir: posix.join(
      env.XDG_DATA_HOME || posix.join(home, ".local", "share"),
      "rotation",
    ),
  };
}

export function validateConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    !/^[A-Za-z0-9]{10,128}$/.test(config.spotifyClientId || "") ||
    !/^[A-Za-z0-9]{10,256}$/.test(config.spotifyClientSecret || "") ||
    !/^[a-f0-9]{64}$/.test(config.sessionSecret || "")
  ) {
    throw new Error(
      "Rotation configuration is incomplete. Check your Spotify app credentials in the per-user config file.",
    );
  }
  return config;
}

export async function readConfig(configDir) {
  const path = join(configDir, "config.json");
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeConfig(configDir, credentials) {
  const config = validateConfig({
    spotifyClientId: credentials.spotifyClientId,
    spotifyClientSecret: credentials.spotifyClientSecret,
    sessionSecret: randomBytes(32).toString("hex"),
  });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(configDir, 0o700);
  const path = join(configDir, "config.json");
  const temp = join(configDir, `.config-${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
  if (platform() !== "win32") await chmod(path, 0o600);
  return config;
}

export function childEnvironment({
  config,
  dataDir,
  webDist,
  port,
  parentEnv = process.env,
  os = platform(),
  macPackage = false,
  buildId = null,
}) {
  const baseUrl = `http://${LOOPBACK}:${port}`;
  return {
    ...parentEnv,
    SPOTIFY_CLIENT_ID: config.spotifyClientId,
    SPOTIFY_CLIENT_SECRET: config.spotifyClientSecret,
    SPOTIFY_REDIRECT_URI: `${baseUrl}/auth/callback`,
    SESSION_SECRET: config.sessionSecret,
    APP_BASE_URL: baseUrl,
    PORT: String(port),
    HOST: LOOPBACK,
    DATA_DIR: dataDir,
    WEB_DIST_DIR: webDist,
    DESKTOP_MODE: "1",
    DESKTOP_CONTROL_TOKEN: randomBytes(32).toString("hex"),
    MAC_LOCAL_SPOTIFY_PROBE: os === "darwin" && macPackage ? "1" : "0",
    ROTATION_BUILD_ID: buildId || "",
  };
}

export function classifyExistingDesktop(session, buildId) {
  if (session?.desktop !== true) return "foreign";
  return (session.desktopBuildId || null) === (buildId || null)
    ? "same"
    : "different";
}

function page(nonce, port, buildId) {
  const callback = `http://${LOOPBACK}:${port}/auth/callback`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="rotation-build-id" content="${buildId || ""}"><title>Set up rotation</title><style>body{font:16px system-ui,sans-serif;background:#f6f1e9;color:#252c28;margin:0;padding:2rem}main{max-width:32rem;margin:5vh auto;background:#fffcf7;padding:2rem;border:1px solid #e6d8c9;border-radius:18px}label{display:block;margin:1rem 0}.field{display:block;width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #a9a99f;border-radius:8px;font:inherit}button{padding:.7rem 1rem;border:0;border-radius:8px;background:#b95f4d;color:white;font:inherit;cursor:pointer}.secondary{background:#4b5b52}code{overflow-wrap:anywhere}p{line-height:1.5}</style></head><body><main><h1>Set up rotation</h1><p>Create a Spotify Developer app and register this exact redirect URI:</p><p><code>${callback}</code></p><p>Your credentials stay in your user profile and are never bundled with rotation.</p><form method="post" action="/save"><input type="hidden" name="nonce" value="${nonce}"><label>Spotify Client ID<input class="field" name="clientId" autocomplete="off" required></label><label>Spotify Client Secret<input class="field" name="clientSecret" type="password" autocomplete="off" required></label><button type="submit">Save and open rotation</button></form><form method="post" action="/quit"><input type="hidden" name="nonce" value="${nonce}"><p><button class="secondary" type="submit">Quit rotation</button></p></form></main></body></html>`;
}

function respond(res, status, body, contentType = "text/html; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function safeEqual(a, b) {
  const x = Buffer.from(a || "");
  const y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function startSetup({ port, configDir, buildId = null }) {
  const origin = `http://${LOOPBACK}:${port}`;
  const nonce = randomBytes(32).toString("hex");
  let done;
  const completion = new Promise((resolve) => {
    done = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `${LOOPBACK}:${port}`)
      return respond(res, 403, "Wrong host.");
    if (req.method === "GET" && req.url === "/") {
      res.setHeader(
        "Set-Cookie",
        `rotation_setup=${nonce}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return respond(res, 200, page(nonce, port, buildId));
    }
    if (req.method !== "POST" || !["/save", "/quit"].includes(req.url))
      return respond(res, 404, "Not found.");
    if (
      req.headers.origin !== origin ||
      !req.headers.cookie
        ?.split(";")
        .some((part) => safeEqual(part.trim(), `rotation_setup=${nonce}`))
    )
      return respond(res, 403, "Refresh setup and try again.");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) return respond(res, 413, "Request too large.");
    }
    const form = new URLSearchParams(raw);
    if (!safeEqual(form.get("nonce"), nonce))
      return respond(res, 403, "Refresh setup and try again.");
    if (req.url === "/quit") {
      respond(
        res,
        200,
        "<h1>Rotation stopped.</h1><p>You can close this tab.</p>",
      );
      done(null);
      return;
    }
    try {
      const config = await writeConfig(configDir, {
        spotifyClientId: form.get("clientId"),
        spotifyClientSecret: form.get("clientSecret"),
      });
      respond(
        res,
        200,
        "<h1>Rotation is starting.</h1><p>The app will open in a new tab. You can close this tab.</p>",
      );
      done(config);
    } catch {
      respond(
        res,
        400,
        "<h1>Invalid credentials</h1><p>Check the values and reload setup to try again.</p>",
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, resolve);
  });
  return { server, completion, url: origin, cancel: () => done(null) };
}

export function openBrowser(
  url,
  { os = platform(), spawnProcess = spawn } = {},
) {
  const [command, args] =
    os === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : os === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawnProcess(command, args, {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (error) =>
    console.error(
      `Could not open the browser: ${error.message}. Open ${url} manually.`,
    ),
  );
  child.unref();
}

export async function waitForHealth(url, child, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error("Rotation server stopped before becoming ready.");
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Rotation server did not become ready.");
}

export function packagedPaths(appRoot) {
  const server = resolve(appRoot, "server", "dist", "index.js");
  const webDist = resolve(appRoot, "web", "dist");
  if (!existsSync(server) || !existsSync(join(webDist, "index.html")))
    throw new Error(
      "Built app files are missing. Build server and web before launching rotation.",
    );
  return { server, webDist };
}
