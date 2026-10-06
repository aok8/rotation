import type { ConnectPlayback } from "./api";

export type RemoteTransition =
  | "current-playing"
  | "current-paused"
  | "expected-next"
  | "ended"
  | "other-device"
  | "other-track"
  | "idle";

export type ForwardMatch =
  | { kind: "match"; targetIndex: number }
  | { kind: "ambiguous" }
  | { kind: "none" };

export function navigationAvailable(
  pendingUri: string,
  commandInFlight: boolean,
) {
  return !pendingUri && !commandInFlight;
}

export function unconfirmedPlaybackMismatch(
  remote: ConnectPlayback,
  deviceId: string,
  expectedUri: string,
):
  | "none"
  | "other-device"
  | "unknown-device"
  | "other-track"
  | "no-playback"
  | "selected-idle"
  | "selected-paused" {
  if (remote.deviceId !== deviceId)
    return remote.deviceId
      ? "other-device"
      : remote.uri || remote.isPlaying
        ? "unknown-device"
        : "no-playback";
  if (remote.uri === expectedUri)
    return remote.isPlaying ? "none" : "selected-paused";
  return remote.uri ? "other-track" : "selected-idle";
}

export function pendingPlaybackStatus(
  remote: ConnectPlayback | null,
  deviceId: string,
  uri: string,
  startedAt: number,
  now: number,
): "confirmed" | "waiting" | "expired" {
  if (
    remote?.deviceId === deviceId &&
    remote.uri === uri &&
    remote.isPlaying
  )
    return "confirmed";
  return now - startedAt >= 20_000 ? "expired" : "waiting";
}

// Spotify queues at most twenty tracks from the selected item. A URI can
// occur more than once in a playlist, so only a unique forward match is safe
// to use when catching up after the browser was inactive.
export function findForwardMatch(
  uris: string[],
  currentIndex: number,
  queuedThroughIndex: number,
  remoteUri: string | null,
): ForwardMatch {
  if (!remoteUri || currentIndex < 0) return { kind: "none" };
  const last = Math.min(uris.length - 1, queuedThroughIndex);
  const matches: number[] = [];
  for (let index = currentIndex; index <= last; index += 1) {
    if (uris[index] === remoteUri) matches.push(index);
  }
  if (matches.length > 1) return { kind: "ambiguous" };
  if (matches.length === 1 && matches[0] > currentIndex)
    return { kind: "match", targetIndex: matches[0] };
  return { kind: "none" };
}

export function classifyRemotePlayback(
  remote: ConnectPlayback,
  selectedDeviceId: string,
  currentUri: string,
  nextUri: string | null,
  priorPosition: number,
  duration: number,
  wasPlaying: boolean,
): RemoteTransition {
  const nearEnd =
    wasPlaying && duration > 0 && priorPosition >= duration - 10_000;
  if (remote.deviceId !== selectedDeviceId) {
    if (remote.deviceId) return "other-device";
    return !remote.uri && !remote.isPlaying && nearEnd ? "ended" : "idle";
  }
  // The expected next URI may equal the current URI for duplicate occurrences.
  // Compare a clear backward jump: a five-second polling gap can already put
  // the next occurrence beyond its first five seconds.
  if (
    nextUri &&
    remote.uri === nextUri &&
    nearEnd &&
    (nextUri !== currentUri ||
      (remote.positionMs < 15_000 &&
        remote.positionMs < priorPosition - 10_000))
  )
    return "expected-next";
  if (remote.uri === currentUri)
    return remote.isPlaying ? "current-playing" : "current-paused";
  if (!remote.uri) return nearEnd && !remote.isPlaying ? "ended" : "idle";
  return "other-track";
}
