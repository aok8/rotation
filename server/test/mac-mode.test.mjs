import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rotation-mac-mode-test-"));
process.env.SPOTIFY_CLIENT_ID = "client123456";
process.env.SPOTIFY_CLIENT_SECRET = "secret123456";
process.env.SPOTIFY_REDIRECT_URI = "http://127.0.0.1:3000/auth/callback";
process.env.SESSION_SECRET = "a".repeat(64);
process.env.DATA_DIR = dataDir;
const { MacLocalMode } = await import("../dist/mac-mode.js");
const { parseMacObservation, playMacTrack, controlMacTrack, runScript } =
  await import("../dist/mac-local.js");
const { AppError } = await import("../dist/errors.js");
const uriA = "spotify:track:AAA123";
const uriB = "spotify:track:BBB456";
function fixture() {
  const rotation = {
    items: [
      { key: "a", uri: uriA, durationMs: 10_000 },
      { key: "b", uri: uriB, durationMs: 10_000 },
    ],
    order: ["a", "b"],
    currentIndex: 0,
    queuedWindow: { startIndex: 0, endIndex: 1, deviceId: "old-connect" },
  };
  const session = { id: "one", rotation };
  let observed = { state: "playing", uri: uriA, positionMs: 1000 };
  let now = 1000;
  let plays = [];
  let playOptions = [];
  let playImpl = async (uri, options) => {
    plays.push(uri);
    playOptions.push(options);
    options?.onAccepted?.();
    return { state: "playing", uri, positionMs: 0 };
  };
  let saves = 0;
  let pauses = 0;
  const mode = new MacLocalMode({
    observe: async () => observed,
    play: (uri, options) => playImpl(uri, options),
    pause: async () => {
      pauses++;
    },
    seek: async (_uri, positionMs) => ({
      state: "playing",
      uri: uriA,
      positionMs,
    }),
    control: async (action) => ({
      state: action === "pause" ? "paused" : "playing",
      uri: observed.uri,
      positionMs: observed.positionMs,
    }),
    save: () => {
      saves++;
    },
    getSession: () => session,
    now: () => now,
    schedule: () => 1,
    cancel: () => {},
  });
  return {
    mode,
    session,
    rotation,
    setObserved: (value) => {
      observed = value;
    },
    setNow: (value) => {
      now = value;
    },
    plays: () => plays,
    playOptions: () => playOptions,
    setPlay: (value) => {
      playImpl = value;
    },
    saves: () => saves,
    pauses: () => pauses,
  };
}
try {
  await test(
    "osascript receives a track URI as the first run argument on macOS",
    {
      skip: process.platform !== "darwin",
    },
    async () => {
      const output = await runScript(
        "on run argv\nreturn item 1 of argv\nend run",
        [uriA],
      );
      assert.equal(output.trim(), uriA);
    },
  );
  await test("Mac state parsing keeps only valid track URIs and finite position", () => {
    assert.deepEqual(parseMacObservation(`playing\t${uriA}\t12.25\n`), {
      state: "playing",
      uri: uriA,
      positionMs: 12250,
    });
    assert.deepEqual(parseMacObservation("idle\tnot-a-uri\tNaN\n"), {
      state: "idle",
      uri: null,
      positionMs: 0,
    });
  });
  await test("local start can adopt a confirmed probe track without replay", async () => {
    const calls = [];
    const observed = await playMacTrack(uriA, {
      adopt: true,
      run: async (_script, args) => {
        calls.push(args);
        return `playing\t${uriA}\t2.5`;
      },
    });
    assert.equal(observed.positionMs, 2500);
    assert.deepEqual(calls, [[]]);
  });
  await test("local pause refuses to control an unrelated Spotify track", async () => {
    await assert.rejects(
      controlMacTrack("pause", uriA, async (_script, args) => {
        assert.deepEqual(args, []);
        return `playing\t${uriB}\t1`;
      }),
      (error) => error.code === "mac_playback_mismatch",
    );
  });
  await test("confirmed manual navigation commits only the selected Rotation track", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    assert.equal(f.rotation.queuedWindow, undefined);
    const result = await f.mode.navigate(f.session, "next");
    assert.deepEqual(f.plays(), [uriA, uriB]);
    assert.equal(result.rotation.currentIndex, 1);
    assert.equal(result.state.state, "playing");
    assert.equal(result.state.active, true);
    f.mode.deactivate();
  });
  await test("manual Next at end confirms pause before committing end index", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    await f.mode.navigate(f.session, "next");
    f.setObserved({ state: "playing", uri: uriB, positionMs: 500 });
    const result = await f.mode.navigate(f.session, "next");
    assert.equal(result.rotation.currentIndex, 2);
    assert.equal(result.state.state, "paused");
    assert.equal(f.mode.active, false);
  });
  await test("unconfirmed navigation preserves index and stops the watcher", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    f.setPlay(async (_uri, options) => {
      options.onAccepted();
      throw new AppError("mac_unconfirmed", "not confirmed", 409);
    });
    await assert.rejects(
      f.mode.navigate(f.session, "next"),
      (error) => error.code === "mac_unconfirmed",
    );
    assert.equal(f.rotation.currentIndex, 0);
    assert.equal(f.mode.active, false);
    assert.equal(f.rotation.queuedWindow, undefined);
  });
  await test("watcher advances after observed natural end without a browser request", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    f.setNow(7000);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 6_000 });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 0);
    f.setNow(10000);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 9_000 });
    await f.mode.tick();
    assert.equal(
      f.rotation.currentIndex,
      0,
      "last second must not be cut short",
    );
    f.setNow(11150);
    f.setObserved({
      state: "playing",
      uri: "spotify:track:OTHER",
      positionMs: 150,
    });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 1);
    assert.deepEqual(f.plays(), [uriA, uriB]);
    f.mode.deactivate();
  });
  await test("auto advance restarts an adjacent duplicate URI after the end", async () => {
    const f = fixture();
    f.rotation.items[1].uri = uriA;
    await f.mode.start(f.session, "a");
    f.setNow(7000);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 6_000 });
    await f.mode.tick();
    f.setNow(10000);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 9_000 });
    await f.mode.tick();
    f.setNow(11150);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 10_000 });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 1);
    assert.equal(f.playOptions().at(-1).requireRestart, true);
    f.mode.deactivate();
  });
  await test("predicted end follows validated local duration after Spotify changes URI", async () => {
    const f = fixture();
    f.rotation.items[0].durationMs = 100_000;
    await f.mode.start(f.session, "a");
    f.setNow(90_000);
    f.setObserved({
      state: "playing",
      uri: uriA,
      positionMs: 89_000,
      durationMs: 104_000,
    });
    await f.mode.tick();
    f.setNow(101_000);
    f.setObserved({
      state: "playing",
      uri: uriA,
      positionMs: 100_000,
      durationMs: 104_000,
    });
    await f.mode.tick();
    f.setNow(103_000);
    f.setObserved({
      state: "playing",
      uri: uriA,
      positionMs: 102_000,
      durationMs: 104_000,
    });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 0);
    f.setNow(105_100);
    f.setObserved({
      state: "playing",
      uri: "spotify:track:OTHER",
      positionMs: 100,
      durationMs: 200_000,
    });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 1);
    f.mode.deactivate();
  });
  await test("mode stops on unrelated track change and stop is idempotent", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    f.setObserved({
      state: "playing",
      uri: "spotify:track:OTHER",
      positionMs: 1000,
    });
    await f.mode.tick();
    assert.equal(f.mode.active, false);
    assert.equal(f.rotation.currentIndex, 0);
    await f.mode.stop(f.session);
    assert.equal(f.pauses(), 0);
  });
  await test("watcher pauses natural continuation at Rotation end", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    await f.mode.navigate(f.session, "next");
    f.setNow(7000);
    f.setObserved({ state: "playing", uri: uriB, positionMs: 6_000 });
    await f.mode.tick();
    f.setNow(10000);
    f.setObserved({ state: "playing", uri: uriB, positionMs: 9_000 });
    await f.mode.tick();
    assert.equal(
      f.rotation.currentIndex,
      1,
      "final song must finish before stopping",
    );
    f.setNow(11150);
    f.setObserved({ state: "playing", uri: uriB, positionMs: 10_000 });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 2);
    assert.equal(f.mode.active, false);
    assert.equal(f.pauses(), 1);
  });
  await test("final track never pauses a different Spotify URI", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    await f.mode.navigate(f.session, "next");
    f.setNow(7000);
    f.setObserved({ state: "playing", uri: uriB, positionMs: 6_000 });
    await f.mode.tick();
    f.setNow(10000);
    f.setObserved({ state: "playing", uri: uriB, positionMs: 9_000 });
    await f.mode.tick();
    f.setNow(11150);
    f.setObserved({ state: "playing", uri: uriA, positionMs: 100 });
    await f.mode.tick();
    assert.equal(f.rotation.currentIndex, 2);
    assert.equal(f.pauses(), 0);
  });
  await test("pause, seek, and external track switch near end never advance", async () => {
    const paused = fixture();
    await paused.mode.start(paused.session, "a");
    paused.setNow(7000);
    paused.setObserved({ state: "playing", uri: uriA, positionMs: 6_000 });
    await paused.mode.tick();
    paused.setNow(8000);
    paused.setObserved({ state: "paused", uri: uriA, positionMs: 8_000 });
    await paused.mode.tick();
    paused.setNow(9000);
    await paused.mode.tick();
    assert.equal(paused.rotation.currentIndex, 0);
    paused.setObserved({ state: "playing", uri: uriB, positionMs: 0 });
    await paused.mode.tick();
    assert.equal(paused.rotation.currentIndex, 0);
    assert.equal(paused.mode.active, false);

    const seeked = fixture();
    await seeked.mode.start(seeked.session, "a");
    await seeked.mode.seek(seeked.session, 9_500);
    seeked.setNow(2000);
    seeked.setObserved({ state: "playing", uri: uriA, positionMs: 9_800 });
    await seeked.mode.tick();
    assert.equal(seeked.rotation.currentIndex, 0);
    seeked.mode.deactivate();
  });
  await test("successful removal pauses only the expected old track", async () => {
    const f = fixture();
    await f.mode.start(f.session, "a");
    await f.mode.afterRemoval(f.session, uriA);
    assert.equal(f.pauses(), 1);
    assert.equal(f.mode.active, false);
    await f.mode.afterRemoval(f.session, uriA);
    assert.equal(f.pauses(), 1);
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
