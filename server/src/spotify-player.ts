import { AppError } from "./errors.js";
import { spotify } from "./spotify.js";
import type { Session } from "./types.js";
import type { PlayerRequest } from "./player-requests.js";
export * from "./player-requests.js";

export async function sendPlayerCommand(s: Session, request: PlayerRequest, retry = true): Promise<void> {
  if (!s.grantedScopes?.includes("user-modify-playback-state"))
    throw new AppError("reauthorization_required", "Reconnect Spotify to allow playback control.", 403);
  await spotify(s, request.path, {
    method: request.method,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  }, retry);
}

export function summarizePlayer(raw: any, selectedDevice: string, expectedUri: string) {
  if (!raw) return { state: "no_playback" as const, selectedDeviceActive: false,
    shuffleOn: null, repeatOn: null, itemPlayable: null, itemRestricted: null };
  const selectedDeviceActive = raw.device?.id === selectedDevice && raw.device?.is_active === true;
  const uri = raw.currently_playing_type === "track" && typeof raw.item?.uri === "string" ? raw.item.uri : null;
  const state = !selectedDeviceActive ? "other_device" as const
    : !uri ? "selected_idle" as const
      : uri !== expectedUri ? "other_track" as const
        : raw.is_playing === true ? "expected_playing" as const : "expected_paused" as const;
  return { state, selectedDeviceActive,
    shuffleOn: typeof raw.shuffle_state === "boolean" ? raw.shuffle_state : null,
    repeatOn: typeof raw.repeat_state === "string" ? raw.repeat_state !== "off" : null,
    itemPlayable: typeof raw.item?.is_playable === "boolean" ? raw.item.is_playable : null,
    itemRestricted: raw.item ? Boolean(raw.item.restrictions) : null };
}
