import type { ConnectPlayback } from "./api";

export type RemoteTransition =
  | "current-playing"
  | "current-paused"
  | "expected-next"
  | "ended"
  | "other-device"
  | "other-track"
  | "idle";

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
