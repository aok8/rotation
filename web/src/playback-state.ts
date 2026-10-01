import type { PlaybackState } from "./spotify-sdk";

type ReconcileInput = {
  desiredUri: string;
  playingIntent: boolean;
  position: number;
  expectedDuration: number;
};

// A successful Web API play command is authoritative while Connect transfers
// the browser device. The SDK can briefly send an old or paused snapshot.
export function reconcileSdkState(state: PlaybackState, input: ReconcileInput) {
  const uri = state.track_window?.current_track?.uri;
  if (input.playingIntent && uri !== input.desiredUri) return null;

  const duration = input.expectedDuration || state.duration;
  const ended =
    state.paused &&
    uri === input.desiredUri &&
    duration > 0 &&
    state.position >= duration - 750;
  const interimPause = input.playingIntent && state.paused && !ended;

  return {
    playback: {
      ...state,
      duration,
      paused: interimPause ? false : state.paused,
    },
    position: interimPause
      ? Math.max(input.position, state.position)
      : state.position,
    phase: interimPause
      ? null
      : state.paused
        ? ("paused" as const)
        : ("playing" as const),
    ended,
  };
}

export function hasLocalTrackEnded(
  playingIntent: boolean,
  hasTrack: boolean,
  position: number,
  duration: number,
) {
  return playingIntent && hasTrack && duration > 0 && position >= duration;
}
