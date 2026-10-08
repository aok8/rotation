import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { uriPattern } from "./config.js";
import { AppError } from "./errors.js";
import { save } from "./store.js";
import type { Rotation } from "./types.js";

const execute = promisify(execFile);
const playScript = `on run argv
  set selectedTrack to item 1 of argv
  tell application "Spotify"
    play track selectedTrack
  end tell
  return "accepted"
end run`;
const observeScript = `on run
  tell application "Spotify"
    if not running then return "unavailable" & tab & "" & tab & "0" & tab & "0"
    if player state is playing then
      set currentState to "playing"
    else if player state is paused then
      set currentState to "paused"
    else
      set currentState to "idle"
    end if
    set currentURI to ""
    set currentPosition to 0
    set currentDuration to 0
    try
      set currentURI to id of current track
      set currentPosition to player position
      set currentDuration to duration of current track
    end try
  end tell
  return currentState & tab & currentURI & tab & currentPosition & tab & currentDuration
end run`;
const pauseScript = `on run
  tell application "Spotify" to pause
  return "accepted"
end run`;
const resumeScript = `on run
  tell application "Spotify" to play
  return "accepted"
end run`;
const seekScript = `on run argv
  set targetPosition to (item 1 of argv) as real
  tell application "Spotify" to set player position to targetPosition
  return "accepted"
end run`;

export type MacObservation = {
  state: "playing" | "paused" | "idle" | "unavailable";
  uri: string | null;
  positionMs: number;
  durationMs?: number;
};
export type MacState = Omit<MacObservation, "state"> & {
  state: MacObservation["state"] | "other_track";
  active: boolean;
  currentIndex: number;
  durationMs: number;
  observedAtMs: number;
  autoAdvance: boolean;
  reason?: "ended" | "other_track" | "unconfirmed";
};
export type ScriptRunner = (script: string, args: string[]) => Promise<string>;
type ProbeOptions = {
  run?: ScriptRunner;
  wait?: (ms: number) => Promise<void>;
  onAccepted?: () => void;
};

export async function runScript(
  script: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execute(
    "/usr/bin/osascript",
    ["-e", script, ...args],
    {
      encoding: "utf8",
      timeout: args.length ? 17_000 : 2_000,
      maxBuffer: 4096,
      windowsHide: true,
      env: {
        HOME: process.env.HOME || "",
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR || "/tmp",
      },
    },
  );
  return stdout;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function scriptError(error: unknown): AppError {
  const detail = String((error as { stderr?: string }).stderr || "");
  if (/-1743|not authorized|not permitted/i.test(detail))
    return new AppError(
      "mac_automation_denied",
      "Allow Rotation to control Spotify in macOS System Settings → Privacy & Security → Automation, then try again.",
      403,
    );
  return new AppError(
    "mac_local_unavailable",
    "Open Spotify on this Mac and allow Automation access, then try again.",
    409,
  );
}
function validUri(uri: string) {
  if (!uriPattern.test(uri))
    throw new AppError("invalid_playback", "Choose a Rotation track.", 400);
}
export function parseMacObservation(output: string): MacObservation {
  const [rawState, rawUri, rawSeconds, rawDuration] = output
    .trim()
    .split("\t", 4);
  const state = ["playing", "paused", "idle", "unavailable"].includes(rawState)
    ? (rawState as MacObservation["state"])
    : "unavailable";
  const seconds = Number(rawSeconds);
  const duration = Number(rawDuration);
  return {
    state,
    uri: rawUri && uriPattern.test(rawUri) ? rawUri : null,
    positionMs:
      Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 0,
    ...(rawDuration !== undefined && Number.isFinite(duration) && duration > 0
      ? { durationMs: duration }
      : {}),
  };
}
export async function observeMacTrack(
  run: ScriptRunner = runScript,
): Promise<MacObservation> {
  try {
    return parseMacObservation(await run(observeScript, []));
  } catch (error) {
    if (scriptError(error).code === "mac_automation_denied")
      throw scriptError(error);
    return { state: "unavailable", uri: null, positionMs: 0 };
  }
}
async function command(script: string, args: string[], run: ScriptRunner) {
  try {
    await run(script, args);
  } catch (error) {
    throw scriptError(error);
  }
}
export async function playMacTrack(
  uri: string,
  options: ProbeOptions & { adopt?: boolean; requireRestart?: boolean } = {},
): Promise<MacObservation> {
  validUri(uri);
  const run = options.run || runScript;
  if (options.adopt) {
    const already = await observeMacTrack(run);
    if (already.uri === uri && already.state === "playing") return already;
  }
  await command(playScript, [uri], run);
  options.onAccepted?.();
  let last = {
    state: "unavailable",
    uri: null,
    positionMs: 0,
  } as MacObservation;
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt) await (options.wait || wait)(1000);
    last = await observeMacTrack(run);
    if (
      last.uri === uri &&
      last.state === "playing" &&
      (!options.requireRestart || last.positionMs < 5_000)
    )
      return last;
  }
  throw new AppError(
    "mac_unconfirmed",
    "Spotify did not confirm the selected Rotation track. Check Spotify on this Mac before trying again.",
    409,
  );
}
export async function controlMacTrack(
  action: "pause" | "resume",
  expectedUri: string,
  run: ScriptRunner = runScript,
): Promise<MacObservation> {
  validUri(expectedUri);
  const before = await observeMacTrack(run);
  if (before.uri !== expectedUri)
    throw new AppError(
      "mac_playback_mismatch",
      "Spotify is playing another track. Press Play to return to Rotation.",
      409,
    );
  if (action === "pause" && before.state === "paused") return before;
  if (action === "resume" && before.state === "playing") return before;
  await command(action === "pause" ? pauseScript : resumeScript, [], run);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(500);
    const after = await observeMacTrack(run);
    if (
      after.uri === expectedUri &&
      after.state === (action === "pause" ? "paused" : "playing")
    )
      return after;
  }
  throw new AppError(
    "mac_unconfirmed",
    "Spotify did not confirm the playback change.",
    409,
  );
}
export async function seekMacTrack(
  expectedUri: string,
  positionMs: number,
  run: ScriptRunner = runScript,
): Promise<MacObservation> {
  validUri(expectedUri);
  const before = await observeMacTrack(run);
  if (before.uri !== expectedUri)
    throw new AppError(
      "mac_playback_mismatch",
      "Spotify is playing another track. Press Play to return to Rotation.",
      409,
    );
  await command(seekScript, [(positionMs / 1000).toFixed(3)], run);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(500);
    const after = await observeMacTrack(run);
    if (
      after.uri === expectedUri &&
      Math.abs(after.positionMs - positionMs) < 3_000
    )
      return after;
  }
  throw new AppError(
    "mac_unconfirmed",
    "Spotify did not confirm the new position.",
    409,
  );
}
export async function pauseMacPlayback(run: ScriptRunner = runScript) {
  await command(pauseScript, [], run);
}
export async function probeMacTrack(uri: string, options: ProbeOptions = {}) {
  validUri(uri);
  const run = options.run || runScript;
  await command(playScript, [uri], run);
  options.onAccepted?.();
  let observed: "expected_paused" | "other_track" | "idle" | "unavailable" =
    "unavailable";
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await (options.wait || wait)(1000);
    const status = await observeMacTrack(run);
    if (status.uri === uri && status.state === "playing")
      return { accepted: true, state: "expected_playing" as const };
    observed =
      status.uri === uri && status.state === "paused"
        ? "expected_paused"
        : status.uri
          ? "other_track"
          : status.state === "unavailable"
            ? "unavailable"
            : "idle";
  }
  return { accepted: true, state: observed };
}
export async function probeMacRotationTrack(
  rotation: Rotation,
  uri: string,
  options: Omit<ProbeOptions, "onAccepted"> = {},
) {
  return probeMacTrack(uri, {
    ...options,
    onAccepted: () => {
      rotation.queuedWindow = undefined;
      save();
    },
  });
}
