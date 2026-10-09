import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const env = process.env;
export const clientId = env.SPOTIFY_CLIENT_ID || "";
export const clientSecret = env.SPOTIFY_CLIENT_SECRET || "";
export const redirectUri = env.SPOTIFY_REDIRECT_URI || "";
export const appBaseUrl = env.APP_BASE_URL || "http://127.0.0.1:3000";
export const sessionSecret = env.SESSION_SECRET || "";
export const dataDir = resolve(env.DATA_DIR || "./data");
export const port = Number(env.PORT || 3000);
export const host = env.HOST || "0.0.0.0";
export const desktopMode = env.DESKTOP_MODE === "1";
export const desktopBuildId = /^[a-f0-9]{32}$/.test(env.ROTATION_BUILD_ID || "")
  ? env.ROTATION_BUILD_ID
  : null;
export const desktopControlToken = env.DESKTOP_CONTROL_TOKEN || "";
if (desktopMode && (host !== "127.0.0.1" || desktopControlToken.length < 32))
  throw new Error("Desktop mode requires loopback HOST and control token");
if (sessionSecret.length < 32)
  throw new Error("SESSION_SECRET must contain at least 32 characters");
if (!clientId || !clientSecret || !redirectUri)
  throw new Error("Spotify OAuth environment variables are required");
export const baseOrigin = new URL(appBaseUrl).origin;
export const secureCookie = new URL(appBaseUrl).protocol === "https:";
export const key = createHash("sha256").update(sessionSecret).digest();
export const idPattern = /^[A-Za-z0-9]{10,64}$/;
export const uriPattern = /^spotify:track:[A-Za-z0-9]+$/;
export const scopes = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
].join(" ");
