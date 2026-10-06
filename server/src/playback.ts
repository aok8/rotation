import { AppError } from "./errors.js";
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
    id:
      typeof x.id === "string" && x.id !== ACTIVE_DEVICE
        ? x.id
        : active.length === 1 &&
            x.is_active === true &&
            x.is_restricted !== true
          ? ACTIVE_DEVICE
          : null,
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
  requirePlaybackModify(s);
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

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function activateDevice(s: Session, selectedDevice: string) {
  const found = await requireDevice(s, selectedDevice);
  if (found.isActive) return;
  // Spotify does not guarantee ordering across Player endpoints. Observe the
  // transfer before sending a play command to an inactive desktop client.
  await playbackCommand(s, "/me/player", {
    device_ids: [selectedDevice],
    play: false,
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await pause(500);
    const { devices: list } = await devices(s);
    const current = list.find(
      (x: { id: string | null }) => x.id === selectedDevice,
    );
    if (!current)
      throw new AppError(
        "device_gone",
        "Spotify lost the selected device. Refresh devices and try again.",
        409,
      );
    if (current.isRestricted)
      throw new AppError(
        "restricted_device",
        "This Spotify device does not accept playback commands.",
        409,
      );
    if (current.isActive) return;
  }
  throw new AppError(
    "device_activation_failed",
    "Spotify did not activate the selected device. Open Spotify there, then try Play again.",
    409,
  );
}

async function ensureQueueMode(s: Session, selectedDevice: string) {
  let state = await spotify(s, "/me/player");
  if (!state) return;
  const matchesDevice = (value: any) =>
    (typeof value?.device?.id === "string"
      ? value.device.id
      : value?.device?.is_active === true &&
          value?.device?.is_restricted !== true
        ? ACTIVE_DEVICE
        : null) === selectedDevice;
  for (
    let attempt = 0;
    state && !matchesDevice(state) && attempt < 5;
    attempt++
  ) {
    await pause(500);
    state = await spotify(s, "/me/player");
  }
  if (!state) return;
  if (!matchesDevice(state))
    throw new AppError(
      "device_activation_failed",
      "Spotify still reports another active device. Open Spotify on the selected device, then try Play again.",
      409,
    );
  const shuffleOn = state.shuffle_state === true;
  const repeatOn =
    typeof state.repeat_state === "string" && state.repeat_state !== "off";
  if (!shuffleOn && !repeatOn) return;
  if (shuffleOn)
    await playbackCommand(
      s,
      `/me/player/shuffle?state=false${deviceParameter(selectedDevice, "&")}`,
    );
  if (repeatOn)
    await playbackCommand(
      s,
      `/me/player/repeat?state=off${deviceParameter(selectedDevice, "&")}`,
    );
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await pause(500);
    const observed = await spotify(s, "/me/player");
    if (
      matchesDevice(observed) &&
      observed?.shuffle_state === false &&
      observed?.repeat_state === "off"
    )
      return;
  }
  throw new AppError(
    "playback_mode",
    "Turn off Shuffle and Repeat in Spotify, then try Play again.",
    409,
  );
}

export async function playWindow(
  s: Session,
  r: Rotation,
  index: number,
  selectedDevice: string,
  positionMs?: number,
) {
  await activateDevice(s, selectedDevice);
  if (selectedDevice === ACTIVE_DEVICE) {
    const state = await playbackState(s);
    if (state.deviceId !== ACTIVE_DEVICE && state.deviceId !== null)
      throw new AppError(
        "device_gone",
        "The active Spotify device changed. Refresh devices and try again.",
        409,
      );
  }
  await ensureQueueMode(s, selectedDevice);
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
    `/me/player/play${deviceParameter(selectedDevice)}`,
    body,
  );
  const queuedThroughIndex = index + uris.length - 1;
  r.queuedWindow = {
    startIndex: index,
    endIndex: queuedThroughIndex,
    deviceId: selectedDevice,
  };
  save();
  return { ok: true, queuedThroughIndex };
}
