import type { MacPlayback } from "./api";

export function macPlaybackAction(
  state: MacPlayback | null,
  currentUri: string | undefined,
): "start" | "pause" | "resume" {
  if (
    !state?.active ||
    state.uri !== currentUri ||
    (state.state !== "playing" && state.state !== "paused")
  )
    return "start";
  return state.state === "playing" ? "pause" : "resume";
}

export function macPlaybackMessage(state: MacPlayback): string {
  if (state.reason === "ended")
    return "You reached the end of this rotation. Start again for a fresh order.";
  if (state.reason === "unconfirmed")
    return "Spotify did not confirm the selected song on this Mac. Check Spotify, then press Play to retry.";
  if (state.reason === "other_track" || state.state === "other_track")
    return "Spotify on this Mac switched to another song. Press Play to resume Rotation.";
  if (state.active && state.state === "playing")
    return "Playing in Spotify on this Mac. Rotation continues while this page is in the background.";
  if (state.active && state.state === "paused")
    return "Paused in Spotify on this Mac. Press Play to resume.";
  if (state.state === "unavailable")
    return "Open Spotify on this Mac, then press Play to resume Rotation.";
  if (state.active)
    return "Spotify on this Mac is idle. Press Play to resume Rotation.";
  return "Press Play to start Rotation in Spotify on this Mac.";
}

export function macDisplayPosition(
  state: MacPlayback,
  selectedUri: string | undefined,
  nowMs: number,
): number {
  if (!state.active || state.uri !== selectedUri) return 0;
  const elapsed =
    state.state === "playing" ? Math.max(0, nowMs - state.observedAtMs) : 0;
  const position = Math.max(0, state.positionMs + elapsed);
  return state.durationMs > 0
    ? Math.min(state.durationMs, position)
    : position;
}
