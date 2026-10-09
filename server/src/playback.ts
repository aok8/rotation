import { AppError } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { currentPlayerOperation, recordPlayerConfirmation } from "./player-ops.js";
import { SpotifyApiError } from "./spotify.js";
import { spotify } from "./spotify.js";
import { save } from "./store.js";
import type { Rotation, Session } from "./types.js";

export const ACTIVE_DEVICE = "active";

export function requirePlaybackRead(s: Session) {
  if (!s.grantedScopes?.includes("user-read-playback-state"))
    throw new AppError(
      "reauthorization_required",
      "Reconnect Spotify to allow device and playback access.",
      403,
    );
}

function requirePlaybackModify(s: Session) {
  if (!s.grantedScopes?.includes("user-modify-playback-state"))
    throw new AppError(
      "reauthorization_required",
      "Reconnect Spotify to allow playback control.",
      403,
    );
}

export function deviceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new AppError("invalid_playback", "Choose a connected player.");
  return value;
}

export function deviceParameter(selectedDevice: string, separator = "?") {
  return selectedDevice === ACTIVE_DEVICE
    ? ""
    : `${separator}device_id=${encodeURIComponent(selectedDevice)}`;
}

export async function devices(s: Session) {
  requirePlaybackRead(s);
  const result = await spotify(s, "/me/player/devices");
  const raw = Array.isArray(result?.devices)
    ? result.devices.filter((x: unknown) => x && typeof x === "object")
    : [];
  const active = raw.filter((x: any) => x?.is_active === true);
  const list = raw.map((x: any) => ({
    id: typeof x.id === "string" && x.id !== ACTIVE_DEVICE ? x.id : null,
    name: String(x.name || "Spotify device"),
    type: String(x.type || "Unknown"),
    isActive: x.is_active === true,
    isRestricted: x.is_restricted === true,
    volumePercent:
      typeof x.volume_percent === "number" ? x.volume_percent : null,
  }));
  return {
    devices: list,
    activeDeviceId:
      active.length === 1
        ? list.find((x: any) => x.isActive)?.id || null
        : null,
  };
}

export async function requireDevice(s: Session, wanted: string) {
  const { devices: list } = await devices(s);
  if (!list.length)
    throw new AppError("no_device", "Open Spotify on a playback device.", 409);
  if (
    wanted === ACTIVE_DEVICE &&
    list.some((x: any) => x.isActive && x.id === null && x.isRestricted)
  )
    throw new AppError(
      "restricted_device",
      "This Spotify device does not accept playback commands.",
      409,
    );
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
  return found;
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
    deviceId:
      typeof state.device?.id === "string"
        ? state.device.id
        : state.device?.is_active === true &&
            state.device?.is_restricted !== true
          ? ACTIVE_DEVICE
          : null,
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

// Safe to share when diagnosing a Spotify client that accepted a command but
// did not begin playback. This deliberately omits device and track identifiers.
export async function playbackDiagnostic(s: Session) {
  requirePlaybackRead(s);
  const r = s.rotation;
  const window = r?.queuedWindow;
  const expectedKey = r?.order[r.currentIndex];
  const expectedUri = r?.items.find((item) => item.key === expectedKey)?.uri;
  if (!window || !expectedUri) return { state: "no_queue" as const };
  const raw = await spotify(s, "/me/player");
  if (!raw)
    return {
      state: "no_playback" as const,
      selectedDeviceActive: false,
      shuffleOn: null,
      repeatOn: null,
      itemPlayable: null,
      itemRestricted: null,
      relinkedFromExpected: false,
    };
  const actualDevice =
    typeof raw.device?.id === "string"
      ? raw.device.id
      : raw.device?.is_active === true && raw.device?.is_restricted !== true
        ? ACTIVE_DEVICE
        : null;
  const selectedDeviceActive =
    actualDevice === window.deviceId && raw.device?.is_active === true;
  const actualUri =
    raw.currently_playing_type === "track" && typeof raw.item?.uri === "string"
      ? raw.item.uri
      : null;
  const queuedUris = r.order
    .slice(r.currentIndex + 1, window.endIndex + 1)
    .map((key) => r.items.find((item) => item.key === key)?.uri);
  const state = !selectedDeviceActive
    ? "other_device"
    : actualUri === expectedUri
      ? raw.is_playing === true
        ? "expected_playing"
        : "expected_paused"
      : !actualUri
        ? "selected_idle"
        : queuedUris.includes(actualUri)
          ? "other_queued_track"
          : "wrong_track";
  return {
    state,
    selectedDeviceActive,
    shuffleOn:
      typeof raw.shuffle_state === "boolean" ? raw.shuffle_state : null,
    repeatOn:
      typeof raw.repeat_state === "string" ? raw.repeat_state !== "off" : null,
    itemPlayable:
      typeof raw.item?.is_playable === "boolean" ? raw.item.is_playable : null,
    itemRestricted: raw.item ? Boolean(raw.item.restrictions) : null,
    relinkedFromExpected: raw.item?.linked_from?.uri === expectedUri,
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

export async function playbackCommand(s: Session, path: string, body?: object, method = "PUT") {
  requirePlaybackModify(s);
  await spotify(s, path, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function realDevice(selectedDevice: string) {
  if (selectedDevice === ACTIVE_DEVICE)
    throw new AppError("device_gone", "Refresh devices and choose a player with a device ID.", 409);
}
function modeSafe(state: any) {
  return state?.shuffle_state === false && state?.repeat_state === "off";
}
function stateDevice(state: any) {
  return typeof state?.device?.id === "string" ? state.device.id : null;
}
function stateUri(state: any) {
  return state?.currently_playing_type === "track" && typeof state?.item?.uri === "string"
    ? state.item.uri : null;
}
export async function skipWithinWindow(
  s: Session,
  r: Rotation,
  nextIndex: number,
  selectedDevice: string,
) {
  if (!s.grantedScopes?.includes("user-read-currently-playing"))
    throw new AppError("reauthorization_required", "Reconnect Spotify to allow queue access for Next.", 403);
  realDevice(selectedDevice);
  const window = r.queuedWindow;
  const byKey = new Map(r.items.map((item) => [item.key, item]));
  const currentUri = byKey.get(r.order[r.currentIndex])?.uri;
  const nextUri = byKey.get(r.order[nextIndex])?.uri;
  const remainingUris = r.order.slice(r.currentIndex, window?.endIndex === undefined ? 0 : window.endIndex + 1)
    .map((key) => byKey.get(key)?.uri);
  if (!window || window.deviceId !== selectedDevice ||
      r.currentIndex < window.startIndex || nextIndex !== r.currentIndex + 1 ||
      nextIndex > window.endIndex || !currentUri || !nextUri)
    throw new AppError("sync_unavailable", "The saved Spotify queue changed. Press Play to restore it.", 409);
  if (currentUri === nextUri || remainingUris.filter((uri) => uri === nextUri).length !== 1)
    throw new AppError("sync_ambiguous", "This queued track cannot be identified safely. Press Play to restore playback.", 409);
  const before = await spotify(s, "/me/player");
  if (stateDevice(before) !== selectedDevice || stateUri(before) !== currentUri)
    throw new AppError("playback_mismatch", "Spotify is playing something else. Press Play to restore Rotation.", 409);
  if (!modeSafe(before))
    throw new AppError("playback_mode", "Turn off Shuffle and Repeat in Spotify, then press Play again.", 409);
  const liveQueue = await spotify(s, "/me/player/queue");
  if (liveQueue?.queue?.[0]?.uri !== nextUri)
    throw new AppError("queue_mismatch", "Spotify's next song differs from Rotation. Press Play to restore the Rotation queue.", 409);
  await playbackCommand(s, `/me/player/next?device_id=${encodeURIComponent(selectedDevice)}`, undefined, "POST");
  for (let attempt = 0; attempt < 2; attempt++) {
    await delay(350, undefined, { signal: currentPlayerOperation()?.signal });
    const after = await spotify(s, "/me/player");
    if (stateDevice(after) === selectedDevice && stateUri(after) === nextUri &&
        after?.is_playing === true && modeSafe(after)) {
      recordPlayerConfirmation(s);
      return;
    }
  }
  throw new AppError("playback_unconfirmed", "Spotify did not confirm the next Rotation track. Refresh playback before trying again.", 409);
}

export async function playWindow(
  s: Session,
  r: Rotation,
  index: number,
  selectedDevice: string,
  positionMs?: number,
) {
  realDevice(selectedDevice);
  const before = await spotify(s, "/me/player");
  const activeTarget = stateDevice(before) === selectedDevice &&
    before?.device?.is_active === true && before?.device?.is_restricted === false;
  if (!activeTarget) await requireDevice(s, selectedDevice);
  if (activeTarget && before && !modeSafe(before) &&
      (before.shuffle_state === true || (typeof before.repeat_state === "string" && before.repeat_state !== "off")))
    throw new AppError("playback_mode", "Turn off Shuffle and Repeat in Spotify, then press Play again.", 409);
  const verifiedQueue = activeTarget && modeSafe(before);
  const byKey = new Map(r.items.map((item) => [item.key, item]));
  const uris = r.order.slice(index, index + (verifiedQueue ? 20 : 1))
    .map((key) => byKey.get(key)?.uri);
  if (!uris.length || uris.some((uri) => !uri))
    throw new AppError("item_changed", "Refresh the Rotation playlist.", 409);
  const body: { uris: string[]; position_ms?: number } = { uris: uris as string[] };
  if (positionMs !== undefined) body.position_ms = positionMs;
  try {
    await playbackCommand(s, `/me/player/play?device_id=${encodeURIComponent(selectedDevice)}`, body);
  } catch (error) {
    if (!(error instanceof SpotifyApiError && error.upstreamStatus === 404 && error.reason === "NO_ACTIVE_DEVICE"))
      throw error;
    // A single transfer is allowed only for Spotify's explicit no-active-device
    // response. Observe the target once before retrying the exact Rotation URI.
    await playbackCommand(s, "/me/player", { device_ids: [selectedDevice], play: true });
    const transferred = await spotify(s, "/me/player");
    if (stateDevice(transferred) !== selectedDevice)
      throw new AppError("device_activation_failed", "Spotify did not activate the selected player. Open Spotify there and try again.", 409);
    await playbackCommand(s, `/me/player/play?device_id=${encodeURIComponent(selectedDevice)}`, body);
  }
  const queuedThroughIndex = index + uris.length - 1;
  r.queuedWindow = { startIndex: index, endIndex: queuedThroughIndex, deviceId: selectedDevice };
  save();
  return { ok: true, queuedThroughIndex };
}
