import { clientId, clientSecret, uriPattern } from "./config.js";
import { AppError } from "./errors.js";
import { save } from "./store.js";
import type { Session, Playlist, Track } from "./types.js";

export async function spotify(
  s: Session,
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<any> {
  if (s.tokens.expiresAt < Date.now() + 60_000) await refresh(s);
  const send = () =>
    fetch("https://api.spotify.com/v1" + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${s.tokens.access}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(12000),
    });
  let response = await send();
  if (response.status === 401 && retry) {
    await refresh(s);
    response = await send();
  }
  if (response.status === 429) {
    const seconds = Math.min(
      120,
      Math.max(1, Number(response.headers.get("retry-after") || 1)),
    );
    throw new AppError(
      "rate_limited",
      `Spotify is busy. Retry in ${seconds} seconds.`,
      429,
      undefined,
      seconds,
    );
  }
  if (!response.ok) {
    const code =
      response.status === 403
        ? "spotify_forbidden"
        : response.status === 401
          ? "spotify_auth"
          : "spotify_error";
    throw new AppError(
      code,
      response.status === 403
        ? "Spotify does not allow this playlist or playback action."
        : `Spotify request failed (${response.status}).`,
      response.status >= 500 ? 502 : response.status,
    );
  }
  if (response.status === 204) return {};
  if (path.startsWith("/me/player/") && init.method === "PUT") return {};
  if (response.headers.get("content-type")?.includes("json"))
    return response.json();
  throw new AppError(
    "spotify_response",
    "Spotify returned an unexpected response.",
    502,
  );
}
export async function refresh(s: Session) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.tokens.refresh,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new AppError(
      "spotify_auth",
      "Spotify connection expired. Please sign in again.",
      401,
    );
  const t = (await response.json()) as any;
  s.tokens.access = t.access_token;
  s.tokens.refresh = t.refresh_token || s.tokens.refresh;
  s.tokens.expiresAt = Date.now() + t.expires_in * 1000;
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
