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
    if player state is playing then
      set currentState to "playing"
    else if player state is paused then
      set currentState to "paused"
    else
      set currentState to "stopped"
    end if
    set currentURI to ""
    try
      set currentURI to id of current track
    end try
  end tell
  return currentState & tab & currentURI
end run`;

type ScriptRunner = (script: string, args: string[]) => Promise<string>;
type ProbeOptions = {
  run?: ScriptRunner;
  wait?: typeof wait;
  onAccepted?: () => void;
};

async function runScript(script: string, args: string[]): Promise<string> {
  const { stdout } = await execute(
    "/usr/bin/osascript",
    ["-e", script, "--", ...args],
    {
      encoding: "utf8",
      timeout: args.length ? 17_000 : 750,
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

export async function probeMacTrack(
  uri: string,
  options: ProbeOptions = {},
) {
  if (!uriPattern.test(uri))
    throw new AppError("invalid_playback", "Choose a Rotation track.", 400);
  const run = options.run || runScript;
  try {
    await run(playScript, [uri]);
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr || "");
    if (/-1743|not authorized|not permitted/i.test(detail))
      throw new AppError(
        "mac_automation_denied",
        "Allow rotation to control Spotify in macOS System Settings → Privacy & Security → Automation, then try again.",
        403,
      );
    throw new AppError(
      "mac_local_unavailable",
      "Open Spotify on this Mac and allow Automation access, then try again.",
      409,
    );
  }
  options.onAccepted?.();
  let observed: "expected_paused" | "other_track" | "idle" | "unavailable" =
    "unavailable";
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await (options.wait || wait)(1000);
    try {
      const output = (await run(observeScript, [])).trim();
      const [playerState, currentUri] = output.split("\t", 2);
      if (currentUri === uri && playerState === "playing")
        return { accepted: true, state: "expected_playing" as const };
      observed =
        currentUri === uri && playerState === "paused"
          ? "expected_paused"
          : currentUri && uriPattern.test(currentUri)
            ? "other_track"
            : "idle";
    } catch {
      // An observation can time out while Spotify loads; retain the last state.
    }
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
      // AppleScript play replaces Spotify's playback context. Invalidate the
      // prior Connect queue before the slower state observation begins.
      rotation.queuedWindow = undefined;
      save();
    },
  });
}
