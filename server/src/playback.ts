import { AppError } from "./errors.js";
import { spotify } from "./spotify.js";
import type { Rotation, Session } from "./types.js";

const deviceIdPattern = /^[A-Za-z0-9_-]{10,128}$/;

export function requirePlaybackRead(s: Session) {
  if (!s.grantedScopes?.includes("user-read-playback-state"))
    throw new AppError(
      "reauthorization_required",
      "Reconnect Spotify to allow device and playback access.",
      403,
    );
}

export function deviceId(value: unknown): string {
  if (typeof value !== "string" || !deviceIdPattern.test(value))
    throw new AppError("invalid_playback", "Choose a connected player.");
  return value;
}

export async function devices(s: Session) {
  requirePlaybackRead(s);
  const result = await spotify(s, "/me/player/devices");
  const list = (result?.devices || []).map((x: any) => ({
    id: typeof x.id === "string" ? x.id : null,
    name: String(x.name || "Spotify device"),
    type: String(x.type || "Unknown"),
    isActive: x.is_active === true,
    isRestricted: x.is_restricted === true,
    volumePercent:
      typeof x.volume_percent === "number" ? x.volume_percent : null,
  }));
  return {
    devices: list,
    activeDeviceId: list.find((x: any) => x.isActive)?.id || null,
  };
}

export async function requireDevice(s: Session, wanted: string) {
  const { devices: list } = await devices(s);
  if (!list.length)
    throw new AppError("no_device", "Open Spotify on a playback device.", 409);
  const found = list.find((x: any) => x.id === wanted);
  if (!found)
    throw new AppError(
      "device_gone",
      "Refresh the device list and select a player.",
      409,
    );
  if (found.isRestricted)
    throw new AppError(
      "restricted_device",
      "This Spotify device does not accept playback commands.",
      409,
    );
}

export async function playbackState(s: Session) {
  requirePlaybackRead(s);
  const state = await spotify(s, "/me/player");
  if (!state)
    return {
      deviceId: null,
      uri: null,
      positionMs: 0,
      durationMs: 0,
      isPlaying: false,
    };
  return {
    deviceId: typeof state.device?.id === "string" ? state.device.id : null,
    uri:
      state.currently_playing_type === "track" &&
      typeof state.item?.uri === "string"
        ? state.item.uri
        : null,
    positionMs: Number.isFinite(state.progress_ms) ? state.progress_ms : 0,
    durationMs: Number.isFinite(state.item?.duration_ms)
      ? state.item.duration_ms
      : 0,
    isPlaying: state.is_playing === true,
  };
}

export async function requireCurrentPlayback(
  s: Session,
  selectedDevice: string,
  uri: string,
) {
  const state = await playbackState(s);
  if (state.deviceId !== selectedDevice || state.uri !== uri)
    throw new AppError(
      "playback_mismatch",
      "Spotify is playing something else. Start this Rotation track again.",
      409,
    );
  return state;
}

export async function playbackCommand(s: Session, path: string, body?: object) {
  try {
    await spotify(s, path, {
      method: "PUT",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404)
      throw new AppError(
        "device_gone",
        "Refresh the device list and select a player.",
        409,
      );
    throw error;
  }
}

export async function playWindow(
  s: Session,
  r: Rotation,
  index: number,
  selectedDevice: string,
  positionMs?: number,
) {
  await requireDevice(s, selectedDevice);
  const byKey = new Map(r.items.map((item) => [item.key, item]));
  const uris = r.order
    .slice(index, index + 20)
    .map((key) => byKey.get(key)?.uri);
  if (!uris.length || uris.some((uri) => !uri))
    throw new AppError("item_changed", "Refresh the Rotation playlist.", 409);
  const body: { uris: string[]; position_ms?: number } = {
    uris: uris as string[],
  };
  if (positionMs !== undefined) body.position_ms = positionMs;
  await playbackCommand(
    s,
    `/me/player/play?device_id=${encodeURIComponent(selectedDevice)}`,
    body,
  );
  return { ok: true, queuedThroughIndex: index + uris.length - 1 };
}
