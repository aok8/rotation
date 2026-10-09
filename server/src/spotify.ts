import { randomBytes } from "node:crypto";
import { clientId, clientSecret, uriPattern } from "./config.js";
import { AppError } from "./errors.js";
import { assertPlayerReady, currentPlayerOperation, recordPlayerCall, setPlayerCooldown } from "./player-ops.js";
import { save } from "./store.js";
import type { Session, Playlist, Track } from "./types.js";

export class SpotifyApiError extends AppError {
  constructor(
    code: string,
    message: string,
    status: number,
    public upstreamStatus: number,
    public reason: string | null = null,
    retryAfter?: number,
  ) {
    super(code, message, status, undefined, retryAfter);
  }
}
function signal() {
  return currentPlayerOperation()?.signal || AbortSignal.timeout(12_000);
}
const knownReasons = [
  "NO_ACTIVE_DEVICE", "DEVICE_NOT_FOUND", "PLAYER_COMMAND_FAILED",
  "RESTRICTED_DEVICE", "PREMIUM_REQUIRED",
] as const;
function safeReason(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: { reason?: unknown; message?: unknown } }).error;
  const rawReason = typeof error?.reason === "string" ? error.reason.toUpperCase() : "";
  if (knownReasons.includes(rawReason as (typeof knownReasons)[number])) return rawReason;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/no active device/i.test(message)) return "NO_ACTIVE_DEVICE";
  if (/device not found|unknown device/i.test(message)) return "DEVICE_NOT_FOUND";
  if (/player command failed/i.test(message)) return "PLAYER_COMMAND_FAILED";
  if (/restricted device/i.test(message)) return "RESTRICTED_DEVICE";
  if (/premium required|premium account/i.test(message)) return "PREMIUM_REQUIRED";
  return null;
}
function reasonMessage(reason: string | null, status: number) {
  if (reason === "NO_ACTIVE_DEVICE") return "Spotify reports no active playback device.";
  if (reason === "DEVICE_NOT_FOUND") return "Spotify cannot find the selected device. Refresh the device list.";
  if (reason === "PLAYER_COMMAND_FAILED") return "Spotify rejected the playback command. Open Spotify on the selected device and try again.";
  if (reason === "RESTRICTED_DEVICE") return "The selected Spotify device does not accept playback commands.";
  if (reason === "PREMIUM_REQUIRED") return "Spotify Premium is required for playback control.";
  return status === 403 ? "Spotify does not allow this playback or playlist action." :
    `Spotify request failed (${status}).`;
}
function retrySeconds(response: Response) {
  const raw = Number(response.headers.get("retry-after") || 1);
  return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 1;
}
async function readError(response: Response) {
  try { return await response.json(); } catch { return null; }
}
async function sendSpotify(s: Session, path: string, init: RequestInit) {
  const op = currentPlayerOperation();
  const method = (init.method || "GET").toUpperCase();
  const endpoint = path.split("?", 1)[0];
  if (endpoint.startsWith("/me/player") && !op) assertPlayerReady(s);
  const at = Date.now();
  const id = op?.id || randomBytes(8).toString("hex");
  let response: Response;
  try {
    response = await fetch("https://api.spotify.com/v1" + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${s.tokens.access}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: signal(),
    });
  } catch (error) {
    if (endpoint.startsWith("/me/player"))
      recordPlayerCall(s, { id, at, method, endpoint, status: null, elapsedMs: Date.now() - at,
        errorCode: op?.signal.aborted ? "playback_timeout" : "spotify_network" });
    if (op?.signal.aborted)
      throw new AppError("playback_timeout", "Spotify playback request timed out.", 504);
    throw new AppError("spotify_network", "Spotify did not respond. Try again shortly.", 502);
  }
  let payload: unknown = null;
  if (!response.ok) payload = await readError(response);
  const reason = safeReason(payload);
  if (endpoint.startsWith("/me/player"))
    recordPlayerCall(s, { id, at, method, endpoint, status: response.status,
      elapsedMs: Date.now() - at,
      ...(!response.ok ? { errorCode: reason === "NO_ACTIVE_DEVICE" ? "no_active_device" :
        response.status === 429 ? "rate_limited" : `spotify_${response.status}` } : {}),
      ...(reason ? { reason } : {}),
      ...(response.ok && method !== "GET" ? { outcome: "accepted" as const } : {}),
      ...(response.status === 429 ? { retryAfter: retrySeconds(response) } : {}) });
  if (response.status === 429) {
    const seconds = retrySeconds(response);
    if (endpoint.startsWith("/me/player")) setPlayerCooldown(s, seconds);
    throw new SpotifyApiError("rate_limited", `Spotify is busy. Retry in ${seconds} seconds.`, 429, 429, null, seconds);
  }
  if (response.status === 401) return response;
  if (!response.ok) {
    const code = response.status === 403 ? "spotify_forbidden" :
      response.status === 401 ? "spotify_auth" : "spotify_error";
    if (endpoint.startsWith("/me/player") && response.status >= 500) setPlayerCooldown(s, 10);
    throw new SpotifyApiError(code,
      reasonMessage(reason, response.status),
      response.status >= 500 ? 502 : response.status, response.status, reason);
  }
  return response;
}
export async function spotify(
  s: Session,
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<any> {
  if (path.startsWith("/me/player")) assertPlayerReady(s);
  if (s.tokens.expiresAt < Date.now() + 60_000) await refresh(s);
  let response = await sendSpotify(s, path, init);
  if (response.status === 401 && retry) {
    await refresh(s);
    response = await sendSpotify(s, path, init);
  }
  if (response.status === 401)
    throw new SpotifyApiError("spotify_auth", "Spotify connection expired. Please sign in again.", 401, 401);
  if (response.status === 204) return null;
  if (path.startsWith("/me/player/") && init.method === "PUT") return {};
  if (response.headers.get("content-type")?.includes("json")) return response.json();
  throw new AppError("spotify_response", "Spotify returned an unexpected response.", 502);
}
export async function refresh(s: Session) {
  const op = currentPlayerOperation();
  const at = Date.now();
  let response: Response;
  try {
    response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.tokens.refresh }),
      signal: signal(),
    });
  } catch {
    if (op) recordPlayerCall(s, { id: op.id, at, method: "POST", endpoint: "/api/token",
      status: null, elapsedMs: Date.now() - at,
      errorCode: op.signal.aborted ? "playback_timeout" : "spotify_network" });
    if (op?.signal.aborted) throw new AppError("playback_timeout", "Spotify playback request timed out.", 504);
    throw new AppError("spotify_network", "Spotify did not respond. Try again shortly.", 502);
  }
  if (op) recordPlayerCall(s, { id: op.id, at, method: "POST", endpoint: "/api/token",
    status: response.status, elapsedMs: Date.now() - at,
    ...(!response.ok ? { errorCode: response.status === 429 ? "rate_limited" : `spotify_${response.status}` } : {}),
    ...(response.status === 429 ? { retryAfter: retrySeconds(response) } : {}) });
  if (response.status === 429) {
    const seconds = retrySeconds(response);
    setPlayerCooldown(s, seconds);
    throw new SpotifyApiError("rate_limited", `Spotify is busy. Retry in ${seconds} seconds.`, 429, 429, null, seconds);
  }
  if (response.status >= 500) {
    if (op) setPlayerCooldown(s, 10);
    throw new SpotifyApiError("spotify_error", "Spotify could not refresh the connection. Try again shortly.", 502, response.status);
  }
  if (!response.ok)
    throw new AppError("spotify_auth", "Spotify connection expired. Please sign in again.", 401);
  const t = (await response.json()) as any;
  s.tokens.access = t.access_token;
  s.tokens.refresh = t.refresh_token || s.tokens.refresh;
  s.tokens.expiresAt = Date.now() + t.expires_in * 1000;
  if (typeof t.scope === "string") s.grantedScopes = t.scope.split(" ");
  save();
}
export async function allPlaylists(s: Session): Promise<Playlist[]> {
  const result: Playlist[] = [];
  for (let offset = 0; offset < 5000; offset += 50) {
    const p = await spotify(s, `/me/playlists?limit=50&offset=${offset}`);
    for (const x of p.items || [])
      if (x?.id && x?.name)
        result.push({
          id: x.id,
          name: x.name,
          owner: x.owner?.display_name || x.owner?.id || "Unknown",
          images: x.images || [],
          collaborative: x.collaborative,
          public: x.public,
        });
    if (!p.next) break;
  }
  return result;
}
export async function selected(s: Session, pid: string) {
  const list = await allPlaylists(s);
  const p = list.find((x) => x.id === pid);
  if (!p)
    throw new AppError(
      "playlist_unavailable",
      "Playlist is not available to this account.",
      403,
    );
  return p;
}
export async function loadItems(s: Session, pid: string) {
  const p = await spotify(s, `/playlists/${pid}`);
  const raw: any[] = [];
  for (let offset = 0; offset < 10000; offset += 50) {
    const page = await spotify(
      s,
      `/playlists/${pid}/items?limit=50&offset=${offset}`,
    );
    raw.push(...(page.items || []));
    if (!page.next) break;
  }
  const uriCounts = new Map<string, number>();
  for (const entry of raw) {
    const uri = entry?.item?.uri;
    if (typeof uri === "string")
      uriCounts.set(uri, (uriCounts.get(uri) || 0) + 1);
  }
  const items: Track[] = [];
  raw.forEach((entry, position) => {
    const x = entry?.item;
    if (
      entry?.is_local ||
      x?.type !== "track" ||
      typeof x.uri !== "string" ||
      !uriPattern.test(x.uri) ||
      x.is_playable === false ||
      x.restrictions
    )
      return;
    items.push({
      key: `${position}:${x.uri}`,
      uri: x.uri,
      name: x.name || "Untitled",
      artists:
        (x.artists || [])
          .map((a: any) => a.name)
          .filter(Boolean)
          .join(", ") || "Unknown artist",
      album: x.album?.name || "",
      durationMs: Number(x.duration_ms) || 0,
      imageUrl: x.album?.images?.[0]?.url || null,
      spotifyUrl: x.external_urls?.spotify || null,
      position,
    });
  });
  return { items, snapshotId: p.snapshot_id as string, uriCounts };
}
