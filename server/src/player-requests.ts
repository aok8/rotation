export type PlayerRequestKind =
  | "context" | "tracks" | "resume" | "pause" | "next" | "previous"
  | "transfer" | "shuffle" | "repeat" | "seek";
export type PlayerRequest = {
  kind: PlayerRequestKind;
  method: "PUT" | "POST";
  path: string;
  body?: Record<string, unknown>;
};
const trackUri = /^spotify:track:[A-Za-z0-9]+$/;
const contextUri = /^spotify:(playlist|album|artist):[A-Za-z0-9]+$/;
function target(deviceId: string) {
  if (!deviceId || deviceId === "active" || deviceId.length > 256 || /[\u0000-\u001f\u007f]/.test(deviceId))
    throw new Error("Choose a connected player.");
  return `device_id=${encodeURIComponent(deviceId)}`;
}
function playBody(positionMs: number) {
  if (!Number.isInteger(positionMs) || positionMs < 0)
    throw new Error("Choose a valid playback position.");
  return positionMs > 0 ? { position_ms: positionMs } : {};
}

// These request builders mirror Spotify's documented Player methods and the
// request shapes used by Spotifast. They have no network or session effects.
export function startTracks(deviceId: string, uris: string[], offset = 0, positionMs = 0): PlayerRequest {
  if (!uris.length || uris.some((uri) => !trackUri.test(uri)) ||
      !Number.isInteger(offset) || offset < 0 || offset >= uris.length)
    throw new Error("Choose Rotation tracks to play.");
  return { kind: "tracks", method: "PUT", path: `/me/player/play?${target(deviceId)}`,
    body: { uris: [...uris], offset: { position: offset }, ...playBody(positionMs) } };
}
export function startContext(deviceId: string, playlistUri: string, offsetUri: string, positionMs = 0): PlayerRequest {
  if (!contextUri.test(playlistUri) || !trackUri.test(offsetUri))
    throw new Error("Choose a playlist song to play.");
  return { kind: "context", method: "PUT", path: `/me/player/play?${target(deviceId)}`,
    body: { context_uri: playlistUri, offset: { uri: offsetUri }, ...playBody(positionMs) } };
}
export function resume(deviceId: string): PlayerRequest {
  return { kind: "resume", method: "PUT", path: `/me/player/play?${target(deviceId)}` };
}
export function pause(deviceId: string): PlayerRequest {
  return { kind: "pause", method: "PUT", path: `/me/player/pause?${target(deviceId)}` };
}
export function next(deviceId: string): PlayerRequest {
  return { kind: "next", method: "POST", path: `/me/player/next?${target(deviceId)}` };
}
export function previous(deviceId: string): PlayerRequest {
  return { kind: "previous", method: "POST", path: `/me/player/previous?${target(deviceId)}` };
}
export function transfer(deviceId: string, play = false): PlayerRequest {
  target(deviceId);
  return { kind: "transfer", method: "PUT", path: "/me/player", body: { device_ids: [deviceId], play } };
}
export function shuffleOff(deviceId: string): PlayerRequest {
  return { kind: "shuffle", method: "PUT", path: `/me/player/shuffle?state=false&${target(deviceId)}` };
}
export function repeatOff(deviceId: string): PlayerRequest {
  return { kind: "repeat", method: "PUT", path: `/me/player/repeat?state=off&${target(deviceId)}` };
}
export function seek(deviceId: string, positionMs: number): PlayerRequest {
  if (!Number.isInteger(positionMs) || positionMs < 0)
    throw new Error("Choose a valid playback position.");
  return { kind: "seek", method: "PUT", path: `/me/player/seek?position_ms=${positionMs}&${target(deviceId)}` };
}

export type CheckAction = "play-context" | "play-tracks" | "resume" | "pause" | "next" | "previous";
export type CheckOptions = { deviceId: string; sourceId?: string; currentUri?: string; uris?: string[] };
export function buildPlayerRequest(action: CheckAction, options: CheckOptions): PlayerRequest {
  const { deviceId } = options;
  if (action === "play-context")
    return startContext(deviceId, `spotify:playlist:${options.sourceId || ""}`, options.currentUri || "");
  if (action === "play-tracks")
    return startTracks(deviceId, options.uris || [], 0);
  if (action === "resume") return resume(deviceId);
  if (action === "pause") return pause(deviceId);
  if (action === "next") return next(deviceId);
  if (action === "previous") return previous(deviceId);
  throw new Error("Choose one Player command.");
}
