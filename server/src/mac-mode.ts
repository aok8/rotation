import { AppError } from "./errors.js";
import {
  controlMacTrack,
  observeMacTrack,
  pauseMacPlayback,
  playMacTrack,
  seekMacTrack,
  type MacObservation,
  type MacState,
} from "./mac-local.js";
import { current } from "./rotation.js";
import { save, store } from "./store.js";
import type { Rotation, Session, Track } from "./types.js";

type Dependencies = {
  observe?: () => Promise<MacObservation>;
  play?: typeof playMacTrack;
  control?: typeof controlMacTrack;
  seek?: typeof seekMacTrack;
  pause?: () => Promise<void>;
  lock?: <T>(work: () => Promise<T>) => Promise<T>;
  save?: () => void;
  getSession?: () => Session | undefined;
  now?: () => number;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};
const blank: MacObservation = {
  state: "unavailable",
  uri: null,
  positionMs: 0,
};
let registeredMode: MacLocalMode | null = null;
export function registerMacLocalMode(mode: MacLocalMode) {
  registeredMode = mode;
}
export function deactivateMacLocalMode() {
  registeredMode?.deactivate();
}

/** One local Mac output per app process. No persisted automation mode is resumed on restart. */
export class MacLocalMode {
  private session: Session | null = null;
  private rotation: Rotation | null = null;
  private last: MacObservation = blank;
  private lastNearEndAt = 0;
  private lastPositionMs = 0;
  private manualPaused = false;
  private suppressAutoAdvance = false;
  private reason: MacState["reason"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observedAt = 0;
  private readonly d: Required<Dependencies>;

  constructor(deps: Dependencies = {}) {
    this.d = {
      observe: deps.observe || (() => observeMacTrack()),
      play: deps.play || playMacTrack,
      control: deps.control || controlMacTrack,
      seek: deps.seek || seekMacTrack,
      pause: deps.pause || (() => pauseMacPlayback()),
      lock: deps.lock || (async (work) => work()),
      save: deps.save || save,
      getSession: deps.getSession || (() => store.session),
      now: deps.now || Date.now,
      schedule:
        deps.schedule ||
        ((callback, ms) => {
          const timer = setTimeout(callback, ms);
          timer.unref();
          return timer;
        }),
      cancel: deps.cancel || clearTimeout,
    };
  }

  get active() {
    return this.session !== null;
  }
  isActiveFor(s: Session) {
    return this.session === s && this.rotation === s.rotation;
  }
  deactivate(reason?: MacState["reason"]) {
    if (this.timer) this.d.cancel(this.timer);
    this.timer = null;
    this.session = null;
    this.rotation = null;
    this.lastNearEndAt = 0;
    this.manualPaused = false;
    this.suppressAutoAdvance = false;
    this.reason = reason;
  }
  private currentItem(s: Session): Track {
    const item = s.rotation && current(s.rotation);
    if (!item)
      throw new AppError("item_changed", "Choose a Rotation track.", 409);
    return item;
  }
  private requireActive(s: Session) {
    if (this.session !== s || this.rotation !== s.rotation)
      throw new AppError(
        "mac_local_inactive",
        "Press Play to start Mac local playback.",
        409,
      );
  }
  private validSession() {
    if (
      !this.session ||
      this.d.getSession() !== this.session ||
      this.session.rotation !== this.rotation
    ) {
      this.deactivate();
      return false;
    }
    return true;
  }
  private publicState(s: Session, observed: MacObservation): MacState {
    const item = s.rotation && current(s.rotation);
    const durationMs = item && observed.uri === item.uri && observed.durationMs &&
      Math.abs(observed.durationMs - item.durationMs) < item.durationMs * 0.05
      ? observed.durationMs : item?.durationMs || 0;
    return {
      active: this.session === s && this.rotation === s.rotation,
      state:
        observed.uri && item && observed.uri !== item.uri
          ? "other_track"
          : observed.state,
      uri: observed.uri,
      positionMs: observed.positionMs,
      durationMs,
      observedAtMs: this.observedAt,
      currentIndex: s.rotation?.currentIndex ?? 0,
      autoAdvance: this.session === s && this.rotation === s.rotation,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
  private async observe() {
    this.last = await this.d.observe();
    this.observedAt = this.d.now();
    return this.last;
  }
  async state(s: Session): Promise<MacState> {
    if (this.session !== s) return this.publicState(s, blank);
    if (!this.validSession()) return this.publicState(s, blank);
    // The watcher owns observations. A GET must not race an AppleScript
    // command and overwrite its confirmed state with a stale reading.
    return this.publicState(s, this.last);
  }
  private scheduleNext(delayMs: number) {
    if (!this.active) return;
    if (this.timer) this.d.cancel(this.timer);
    this.timer = this.d.schedule(() => {
      void this.tick();
    }, delayMs);
  }
  async start(s: Session, itemKey: unknown): Promise<MacState> {
    const r = s.rotation;
    const item = this.currentItem(s);
    if (itemKey !== item.key)
      throw new AppError(
        "item_changed",
        "The selected Rotation track changed. Refresh the player.",
        409,
      );
    this.deactivate();
    let sent = false;
    try {
      const observed = await this.d.play(item.uri, {
        adopt: true,
        onAccepted: () => {
          sent = true;
          if (r) r.queuedWindow = undefined;
          this.d.save();
        },
      });
      if (this.d.getSession() !== s || s.rotation !== r)
        throw new AppError(
          "item_changed",
          "Rotation changed while starting playback.",
          409,
        );
      if (r && !sent) {
        r.queuedWindow = undefined;
        this.d.save();
      }
      this.session = s;
      this.rotation = r || null;
      this.last = observed;
      this.observedAt = this.d.now();
      this.lastPositionMs = observed.positionMs;
      this.manualPaused = false;
      this.suppressAutoAdvance = false;
      this.reason = undefined;
      this.scheduleNext(1_000);
      return this.publicState(s, observed);
    } catch (error) {
      if (sent) this.deactivate("unconfirmed");
      throw error;
    }
  }
  async navigate(
    s: Session,
    direction: unknown,
  ): Promise<{ rotation: Rotation; state: MacState }> {
    this.requireActive(s);
    const r = s.rotation!;
    const old = this.currentItem(s);
    if (direction !== "next" && direction !== "previous")
      throw new AppError("invalid_direction", "Choose previous or next.");
    const target =
      direction === "next"
        ? Math.min(r.currentIndex + 1, r.order.length)
        : Math.max(r.currentIndex - 1, 0);
    const before = await this.observe();
    if (before.uri !== old.uri) {
      this.deactivate("other_track");
      throw new AppError(
        "mac_playback_mismatch",
        "Spotify is playing another track. Press Play to return to Rotation.",
        409,
      );
    }
    if (target >= r.order.length) {
      const stopped =
        before.state === "playing"
          ? await this.d.control("pause", old.uri)
          : before;
      r.currentIndex = target;
      r.queuedWindow = undefined;
      this.d.save();
      this.deactivate("ended");
      return { rotation: r, state: this.publicState(s, stopped) };
    }
    const item = r.items.find((x) => x.key === r.order[target]);
    if (!item)
      throw new AppError("item_changed", "Refresh the Rotation playlist.", 409);
    let sent = false;
    try {
      const observed = await this.d.play(item.uri, {
        requireRestart: item.uri === old.uri,
        onAccepted: () => {
          sent = true;
          r.queuedWindow = undefined;
          this.d.save();
        },
      });
      if (this.session !== s || this.rotation !== r)
        throw new AppError(
          "item_changed",
          "Rotation changed while playing. Refresh the player.",
          409,
        );
      r.currentIndex = target;
      this.d.save();
      this.last = observed;
      this.observedAt = this.d.now();
      this.lastPositionMs = observed.positionMs;
      this.lastNearEndAt = 0;
      this.manualPaused = false;
      this.suppressAutoAdvance = false;
      this.scheduleNext(1_000);
      return { rotation: r, state: this.publicState(s, observed) };
    } catch (error) {
      if (sent) this.deactivate("unconfirmed");
      throw error;
    }
  }
  async control(s: Session, action: unknown): Promise<MacState> {
    this.requireActive(s);
    if (action !== "pause" && action !== "resume")
      throw new AppError("invalid_playback", "Choose pause or resume.");
    let observed: MacObservation;
    try {
      observed = await this.d.control(action, this.currentItem(s).uri);
    } catch (error) {
      this.deactivate("unconfirmed");
      throw error;
    }
    this.last = observed;
    this.observedAt = this.d.now();
    this.manualPaused = action === "pause";
    this.lastNearEndAt = 0;
    this.scheduleNext(action === "pause" ? 8_000 : 1_000);
    return this.publicState(s, observed);
  }
  async seek(s: Session, positionMs: unknown): Promise<MacState> {
    this.requireActive(s);
    const item = this.currentItem(s);
    if (
      !Number.isInteger(positionMs) ||
      (positionMs as number) < 0 ||
      (positionMs as number) >= item.durationMs
    )
      throw new AppError(
        "invalid_playback",
        "Choose a position within the active track.",
      );
    let observed: MacObservation;
    try {
      observed = await this.d.seek(item.uri, positionMs as number);
    } catch (error) {
      this.deactivate("unconfirmed");
      throw error;
    }
    this.last = observed;
    this.observedAt = this.d.now();
    this.lastPositionMs = observed.positionMs;
    this.lastNearEndAt = 0;
    this.suppressAutoAdvance = true;
    this.scheduleNext(1_000);
    return this.publicState(s, observed);
  }
  async stop(s: Session): Promise<MacState> {
    let observed = this.last;
    let pauseFailed = false;
    let didPause = false;
    try {
      if (this.session === s && s.rotation) {
        const expected = current(s.rotation)?.uri;
        observed = await this.observe();
        if (observed.uri === expected && observed.state === "playing") {
          await this.d.pause();
          didPause = true;
        }
      }
    } catch {
      pauseFailed = true;
    } finally {
      this.deactivate(pauseFailed ? "unconfirmed" : undefined);
    }
    return this.publicState(
      s,
      didPause
        ? { ...observed, state: pauseFailed ? "unavailable" : "paused" }
        : observed,
    );
  }
  async afterRemoval(s: Session, removedUri: string) {
    if (this.session !== s) return;
    try {
      const observed = await this.observe();
      if (observed.uri === removedUri && observed.state === "playing")
        await this.d.pause();
    } catch {
      // Playlist removal has already succeeded. A local playback failure must
      // never make the client retry the archive operation.
    } finally {
      this.deactivate();
    }
  }
  private async advanceAfterEnd(
    s: Session,
    r: Rotation,
    observed: MacObservation,
  ) {
    const nextIndex = r.currentIndex + 1;
    const next = r.items.find((x) => x.key === r.order[nextIndex]);
    const old = current(r);
    if (!next) {
      if (observed.uri === old?.uri && observed.state === "playing")
        await this.d.pause();
      r.currentIndex = r.order.length;
      this.d.save();
      this.deactivate("ended");
      return;
    }
    let sent = false;
    try {
      const started = await this.d.play(next.uri, {
        requireRestart: old?.uri === next.uri,
        onAccepted: () => {
          sent = true;
          r.queuedWindow = undefined;
          this.d.save();
        },
      });
      if (!this.validSession() || r.currentIndex !== nextIndex - 1) return;
      r.currentIndex = nextIndex;
      this.d.save();
      this.last = started;
      this.observedAt = this.d.now();
      this.lastPositionMs = started.positionMs;
      this.lastNearEndAt = 0;
    } catch {
      this.deactivate(sent ? "unconfirmed" : "other_track");
    }
  }
  async tick() {
    this.timer = null;
    if (!this.validSession()) return;
    try {
      await this.d.lock(async () => {
        if (!this.validSession()) return;
        const s = this.session!;
        const r = this.rotation!;
        const item = current(r);
        if (!item) {
          this.deactivate("ended");
          return;
        }
        const prior = this.last;
        const priorAt = this.observedAt;
        const priorNearEndAt = this.lastNearEndAt;
        const priorPosition = this.lastPositionMs;
        const observed = await this.observe();
        if (!this.validSession()) return;
        const now = this.d.now();
        const reportedDuration =
          observed.uri === item.uri ? observed.durationMs : prior.durationMs;
        const duration =
          reportedDuration &&
          Math.abs(reportedDuration - item.durationMs) < item.durationMs * 0.05
            ? reportedDuration
            : item.durationMs;
        if (this.suppressAutoAdvance && observed.positionMs < duration - 6_000)
          this.suppressAutoAdvance = false;
        const samePlaying =
          observed.uri === item.uri && observed.state === "playing";
        const elapsed = now - priorAt;
        const progress = observed.positionMs - priorPosition;
        const credibleProgress =
          samePlaying &&
          prior.uri === item.uri &&
          prior.state === "playing" &&
          progress > 0 &&
          elapsed > 0 &&
          Math.abs(progress - elapsed) < 2_500;
        if (
          credibleProgress &&
          !this.manualPaused &&
          !this.suppressAutoAdvance &&
          observed.positionMs >= duration - 4_000
        )
          this.lastNearEndAt = now;
        const reset =
          samePlaying &&
          priorNearEndAt > 0 &&
          now - priorNearEndAt < 15_000 &&
          observed.positionMs + 5_000 < priorPosition;
        const predictedEndAt = priorAt + Math.max(0, duration - priorPosition);
        const withinEndWindow =
          priorNearEndAt > 0 &&
          prior.uri === item.uri &&
          prior.state === "playing" &&
          priorPosition >= duration - 4_000 &&
          now >= predictedEndAt &&
          now - predictedEndAt <= 3_000 &&
          now - priorAt <= 5_000;
        const stillAtEnd =
          observed.uri === item.uri &&
          (observed.state === "playing"
            ? observed.positionMs >= duration - 300
            : observed.positionMs >= duration);
        const naturalContinuation =
          observed.uri !== item.uri &&
          ((observed.state === "playing" && observed.positionMs < 2_000) ||
            observed.state === "idle");
        if (
          !this.manualPaused &&
          !this.suppressAutoAdvance &&
          withinEndWindow &&
          (stillAtEnd || naturalContinuation)
        ) {
          await this.advanceAfterEnd(s, r, observed);
        } else if (reset) {
          // A same-URI reset could be Spotify repeat or a manual seek. Do not
          // infer which occurrence is next from the URI alone.
          this.deactivate("other_track");
        } else if (
          observed.uri !== item.uri ||
          observed.state === "unavailable"
        ) {
          this.deactivate("other_track");
        } else {
          this.lastPositionMs = observed.positionMs;
        }
      });
    } catch (error) {
      if (
        !(error instanceof AppError && error.code === "operation_in_progress")
      )
        this.deactivate("unconfirmed");
    }
    if (this.active) {
      const item = this.rotation && current(this.rotation);
      const duration =
        item &&
        this.last.durationMs &&
        Math.abs(this.last.durationMs - item.durationMs) <
          item.durationMs * 0.05
          ? this.last.durationMs
          : item?.durationMs || 0;
      const remaining = duration - this.last.positionMs;
      this.scheduleNext(
        this.last.state === "paused"
          ? 8_000
          : remaining > 30_000
            ? 8_000
            : remaining > 8_000
              ? 3_000
              : Math.max(200, Math.min(1_000, remaining + 150)),
      );
    }
  }
}
