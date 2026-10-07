import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  api,
  describeError,
  setCsrfToken,
  type ApiError,
  type ConnectDevice,
  type ConnectPlayback,
  type Playlist,
  type Rotation,
  type Session,
  type TrackItem,
} from "./api";
import {
  classifyRemotePlayback,
  chooseConnectDevice,
  findForwardMatch,
  navigationAvailable,
  pendingPlaybackStatus,
  playbackObservationStillRelevant,
  unconfirmedPlaybackMismatch,
} from "./connect-state";

type Notice = { text: string; kind: "ok" | "error" | "info" } | null;
const formatTime = (ms = 0) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const artist = (item: TrackItem) =>
  Array.isArray(item.artists) ? item.artists.join(", ") : item.artists;
const owner = (p: Playlist) =>
  typeof p.owner === "string"
    ? p.owner
    : p.owner?.display_name || p.owner?.id || "Spotify";
const initialTheme = (): "light" | "dark" => {
  const saved = localStorage.getItem("rotation-theme");
  return saved === "light" || saved === "dark"
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
};
const resultRotation = (result: Rotation | { rotation: Rotation }) =>
  "rotation" in result ? result.rotation : result;
const playbackTimeout = () => AbortSignal.timeout(30_000);
function pendingRecoveryMessage(
  mismatch: ReturnType<typeof unconfirmedPlaybackMismatch>,
  deviceName: string,
) {
  switch (mismatch) {
    case "other-device":
      return "Spotify is playing on another device. Refresh devices, choose where to listen, then press Play to retry.";
    case "unknown-device":
      return "Spotify reports playback on a device it cannot identify. Refresh devices and choose an available player before retrying.";
    case "other-track":
      return "Spotify played a different song than Rotation selected. Check Shuffle and Repeat in Spotify, then press Play to return to the selected track.";
    case "selected-paused":
      return `Spotify found the selected song on ${deviceName}, but it is paused. Press Play to try again.`;
    case "selected-idle":
      return `Spotify sees ${deviceName}, but it is idle. Start any song in Spotify there once, then press Play in Rotation to retry.`;
    case "no-playback":
      return `Spotify reports no active playback on ${deviceName}. Start any song in Spotify there once, then press Play in Rotation to retry.`;
    default:
      return `Spotify has not confirmed playback on ${deviceName}. Press Play to retry.`;
  }
}

function Picker({
  label,
  value,
  onChange,
  playlists,
  optional,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  playlists: Playlist[];
  optional?: boolean;
}) {
  const [search, setSearch] = useState("");
  const selected = playlists.find((p) => p.id === value);
  const matches = playlists.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="picker">
      <label htmlFor={label}>
        {label} <small>{optional ? "Optional" : "Required"}</small>
      </label>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search playlists"
        aria-label={`Search ${label.toLowerCase()} playlists`}
      />
      <select
        id={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {optional ? "None — remove only" : "Choose a playlist"}
        </option>
        {matches.map((p) => (
          <option value={p.id} key={p.id}>
            {p.name} · {owner(p)}
          </option>
        ))}
        {selected && !matches.some((p) => p.id === selected.id) && (
          <option value={selected.id}>
            {selected.name} · {owner(selected)}
          </option>
        )}
      </select>
      {selected && (
        <p className="field-help">
          {selected.name} · {owner(selected)}
        </p>
      )}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<"player" | "settings">("player");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistError, setPlaylistError] = useState("");
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [archiveId, setArchiveId] = useState("");
  const [rotation, setRotation] = useState<Rotation | null>(null);
  const [rotationError, setRotationError] = useState("");
  const [rotationLoading, setRotationLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [playerMessage, setPlayerMessage] = useState("");
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [macProbeMessage, setMacProbeMessage] = useState("");
  const [macProbeBusy, setMacProbeBusy] = useState(false);
  const [reauthorizationNeeded, setReauthorizationNeeded] = useState(false);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [playback, setPlayback] = useState<ConnectPlayback | null>(null);
  const [playingIntent, setPlayingIntent] = useState(false);
  const [pendingUri, setPendingUri] = useState("");
  const [position, setPosition] = useState(0);
  const [seekValue, setSeekValue] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [failure, setFailure] = useState<{
    itemKey: string;
    operationId?: string;
    partial: boolean;
    conflict: boolean;
    uncertain: boolean;
  } | null>(null);
  const deviceIdRef = useRef("");
  const requireDeviceSelectionRef = useRef(
    sessionStorage.getItem("rotation-reselect-device") === "yes",
  );
  const playingIntentRef = useRef(false);
  const pendingUriRef = useRef("");
  const unconfirmedUriRef = useRef("");
  const pendingSinceRef = useRef(0);
  const queuedThroughRef = useRef(-1);
  const refreshingQueueRef = useRef(false);
  const pollingRef = useRef(false);
  const nextPollAllowedRef = useRef(0);
  const lastObservedAtRef = useRef(0);
  const lastDeviceRefreshAtRef = useRef(0);
  const deviceRefreshInFlightRef = useRef(false);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  const command = useRef(false);
  const rotationRef = useRef<Rotation | null>(null);
  const positionRef = useRef(0);
  function setIntent(playing: boolean) {
    playingIntentRef.current = playing;
    setPlayingIntent(playing);
  }
  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);
  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#17231e" : "#f5f1e9");
  }, [theme]);
  function toggleTheme() {
    setTheme((value) => {
      const next = value === "light" ? "dark" : "light";
      localStorage.setItem("rotation-theme", next);
      return next;
    });
  }
  const loadSession = useCallback(async () => {
    try {
      const data = await api<Session>("/api/session");
      setSession(data);
      setCsrfToken(data.csrfToken);
      setSourceId(data.settings?.sourceId || "");
      setArchiveId(data.settings?.archiveId || "");
      if (data.authenticated && !data.settings?.sourceId) setPage("settings");
    } catch (e) {
      setNotice({ text: describeError(e), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, []);
  const loadPlaylists = useCallback(async () => {
    setPlaylistsLoading(true);
    setPlaylistError("");
    try {
      const data = await api<{ playlists: Playlist[] }>("/api/playlists");
      setPlaylists(data.playlists);
    } catch (e) {
      setPlaylistError(describeError(e));
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);
  const loadRotation = useCallback(async () => {
    setRotationLoading(true);
    setRotationError("");
    try {
      const existing = await api<Rotation | null>("/api/rotation");
      setRotation(
        existing ??
          (await api<Rotation>("/api/rotation/start", { method: "POST" })),
      );
    } catch (e) {
      setRotationError(describeError(e));
    } finally {
      setRotationLoading(false);
    }
  }, []);
  const restartRotation = useCallback(async () => {
    setRotationLoading(true);
    setRotationError("");
    try {
      setRotation(
        await api<Rotation>("/api/rotation/start", { method: "POST" }),
      );
      setPlayback(null);
      setPosition(0);
      setIntent(false);
      setPendingUri("");
      pendingUriRef.current = "";
      unconfirmedUriRef.current = "";
      queuedThroughRef.current = -1;
    } catch (e) {
      setRotationError(describeError(e));
    } finally {
      setRotationLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    if (session?.authenticated) void loadPlaylists();
  }, [session?.authenticated, loadPlaylists]);
  useEffect(() => {
    if (session?.authenticated && session.settings?.sourceId)
      void loadRotation();
  }, [session?.authenticated, loadRotation]);
  const loadDevices = useCallback(async () => {
    if (deviceRefreshInFlightRef.current) return;
    deviceRefreshInFlightRef.current = true;
    lastDeviceRefreshAtRef.current = Date.now();
    setDevicesLoading(true);
    setDeviceError("");
    setReauthorizationNeeded(false);
    try {
      const data = await api<{
        devices: ConnectDevice[];
        activeDeviceId: string | null;
      }>("/api/playback/devices", {
        signal: AbortSignal.timeout(10_000),
      });
      const available = data.devices.filter(
        (device) => device.id && !device.isRestricted,
      );
      const saved = sessionStorage.getItem("rotation-connect-device");
      const previous = deviceIdRef.current;
      const chosen = chooseConnectDevice(
        available,
        previous,
        saved,
        data.activeDeviceId,
        requireDeviceSelectionRef.current,
      );
      setDevices(data.devices);
      setActiveDeviceId(data.activeDeviceId);
      setDeviceId(chosen);
      deviceIdRef.current = chosen;
      if (chosen !== previous) {
        setIntent(false);
        setPlayback(null);
        setPosition(0);
        setPendingUri("");
        pendingUriRef.current = "";
        unconfirmedUriRef.current = "";
        queuedThroughRef.current = -1;
        setPlayerMessage(
          chosen
            ? `Spotify device found: ${available.find((device) => device.id === chosen)?.name}. Press Play to listen.`
            : previous
              ? "The selected Spotify device is no longer available. Choose another device or refresh devices."
              : "No available Spotify device yet. Open Spotify on a device, then refresh.",
        );
      }
    } catch (error) {
      setDeviceError(describeError(error));
      setReauthorizationNeeded(
        (error as ApiError).code === "reauthorization_required",
      );
    } finally {
      setDevicesLoading(false);
      deviceRefreshInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    if (session?.authenticated) void loadDevices();
  }, [session?.authenticated, loadDevices]);
  useEffect(() => {
    if (!playingIntent || !playback) return;
    const id = window.setInterval(
      () => setPosition((value) => Math.min(playback.durationMs, value + 1_000)),
      1_000,
    );
    return () => window.clearInterval(id);
  }, [playingIntent, playback?.durationMs]);
  const ordered = useMemo(() => {
    if (!rotation) return [];
    const byKey = new Map(rotation.items.map((item) => [item.key, item]));
    return rotation.order
      .map((key) => byKey.get(key))
      .filter((item): item is TrackItem => !!item);
  }, [rotation]);
  const current = ordered[rotation?.currentIndex ?? -1];
  useEffect(() => setMacProbeMessage(""), [current?.key]);
  const upcoming = ordered.slice(
    (rotation?.currentIndex ?? -1) + 1,
    (rotation?.currentIndex ?? -1) + 4,
  );
  const source = playlists.find((p) => p.id === session?.settings?.sourceId);
  const archive = playlists.find((p) => p.id === session?.settings?.archiveId);
  const hasArchive = !!session?.settings?.archiveId;
  const duplicate =
    !!current &&
    (rotation?.items.filter((item) => item.uri === current.uri).length ?? 0) >
      1;
  const selectedDevice = devices.find((device) => device.id === deviceId);
  const canPlay = !!selectedDevice && !selectedDevice.isRestricted;
  function selectDevice(id: string) {
    requireDeviceSelectionRef.current = !id;
    if (id) sessionStorage.removeItem("rotation-reselect-device");
    else sessionStorage.setItem("rotation-reselect-device", "yes");
    setDeviceId(id);
    deviceIdRef.current = id;
    if (id) sessionStorage.setItem("rotation-connect-device", id);
    else sessionStorage.removeItem("rotation-connect-device");
    setIntent(false);
    setPlayback(null);
    setPosition(0);
    setPendingUri("");
    pendingUriRef.current = "";
    unconfirmedUriRef.current = "";
    queuedThroughRef.current = -1;
    setPlayerMessage(
      id
        ? "Ready to play on the selected Spotify device."
        : "Choose a Spotify device to listen.",
    );
  }
  async function run(task: () => Promise<void>) {
    if (command.current) return;
    command.current = true;
    setBusy(true);
    if (page === "player")
      setPlayerMessage("Working with Spotify. Playback controls will return when it responds…");
    const waiting = window.setTimeout(() => {
      if (page === "player")
        setPlayerMessage("Waiting for Spotify to finish this action…");
    }, 8_000);
    try {
      await task();
    } catch (error) {
      setNotice({ text: describeError(error), kind: "error" });
      if (page === "player") setPlayerMessage(describeError(error));
    } finally {
      window.clearTimeout(waiting);
      command.current = false;
      setBusy(false);
    }
  }
  function expirePendingIfOverdue(startedAt = pendingSinceRef.current) {
    if (
      !pendingUriRef.current ||
      pendingSinceRef.current !== startedAt ||
      pendingPlaybackStatus(
        null,
        deviceIdRef.current,
        pendingUriRef.current,
        startedAt,
        Date.now(),
      ) !== "expired"
    )
      return false;
    unconfirmedUriRef.current = pendingUriRef.current;
    pendingUriRef.current = "";
    setPendingUri("");
    setIntent(false);
    setPlayback(null);
    setPosition(0);
    positionRef.current = 0;
    setPlayerMessage(
      "Spotify did not confirm playback on this device. Refresh devices or press Play to retry; check Spotify if audio started elsewhere.",
    );
    return true;
  }
  function markPending(item: TrackItem, startPosition = 0) {
    unconfirmedUriRef.current = "";
    pendingUriRef.current = item.uri;
    const startedAt = Date.now();
    pendingSinceRef.current = startedAt;
    setPendingUri(item.uri);
    setIntent(false);
    setPlayback({
      deviceId: deviceIdRef.current,
      uri: item.uri,
      positionMs: startPosition,
      durationMs: item.durationMs ?? 0,
      isPlaying: false,
    });
    setPosition(startPosition);
    positionRef.current = startPosition;
    setPlayerMessage(
      `Starting on ${selectedDevice?.name || "Spotify device"}… Next and Previous unlock when Spotify confirms playback.`,
    );
    window.setTimeout(() => void pollRef.current(), 1_500);
    window.setTimeout(() => expirePendingIfOverdue(startedAt), 20_100);
  }
  async function play(item: TrackItem, startPosition = 0) {
    if (!deviceIdRef.current)
      throw new Error("Choose a Spotify device, then try again.");
    const result = await api<{ ok: true; queuedThroughIndex: number }>(
      "/api/playback",
      {
        method: "PUT",
        signal: playbackTimeout(),
        body: JSON.stringify({
          deviceId: deviceIdRef.current,
          uri: item.uri,
          positionMs: startPosition,
        }),
      },
    );
    queuedThroughRef.current = result.queuedThroughIndex;
    markPending(item, startPosition);
  }
  async function togglePlayback() {
    if (!canPlay) return;
    if (playingIntent) {
      await run(async () => {
        await api("/api/playback/control", {
          method: "PUT",
          signal: playbackTimeout(),
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            action: "pause",
          }),
        });
        setIntent(false);
        setPlayback((previous) =>
          previous ? { ...previous, isPlaying: false } : previous,
        );
        setPlayerMessage(
          `Paused on ${selectedDevice?.name || "Spotify device"}.`,
        );
      });
    } else if (
      playback?.uri === current?.uri &&
      playback.deviceId === deviceIdRef.current &&
      !pendingUriRef.current
    ) {
      await run(async () => {
        await api("/api/playback/control", {
          method: "PUT",
          signal: playbackTimeout(),
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            action: "resume",
          }),
        });
        markPending(current!, positionRef.current);
      });
    } else await start();
  }
  async function start() {
    await run(async () => {
      if (!canPlay)
        throw new Error("Choose an available Spotify device first.");
      const updated =
        rotationRef.current ??
        (await api<Rotation>("/api/rotation/start", { method: "POST" }));
      setRotation(updated);
      const item = updated.items.find(
        (entry) => entry.key === updated.order[updated.currentIndex],
      );
      if (item) await play(item);
    });
  }
  function clearConnectAfterMacProbe() {
    // AppleScript can replace Spotify's active context. Require an explicit
    // Connect choice before commands use the saved Rotation order again.
    requireDeviceSelectionRef.current = true;
    sessionStorage.setItem("rotation-reselect-device", "yes");
    sessionStorage.removeItem("rotation-connect-device");
    deviceIdRef.current = "";
    setDeviceId("");
    queuedThroughRef.current = -1;
    pendingUriRef.current = "";
    unconfirmedUriRef.current = "";
    setPendingUri("");
    setIntent(false);
    setPlayback(null);
    setPosition(0);
    positionRef.current = 0;
    setSeekValue(null);
    setPlayerMessage(
      "The local Mac test may have changed Spotify playback. Choose a device and press Play to start the shuffled Rotation queue.",
    );
  }
  async function reloadRotationAfterMacProbe() {
    const latest = await api<Rotation | null>("/api/rotation", {
      signal: AbortSignal.timeout(10_000),
    });
    rotationRef.current = latest;
    setRotation(latest);
  }
  async function probeMacPlayback() {
    if (
      !current ||
      !session?.macLocalProbeAvailable ||
      command.current ||
      pendingUriRef.current
    )
      return;
    command.current = true;
    setBusy(true);
    setMacProbeBusy(true);
    setMacProbeMessage("");
    try {
      const result = await api<{
        accepted: boolean;
        state:
          | "expected_playing"
          | "expected_paused"
          | "other_track"
          | "idle"
          | "unavailable";
      }>("/api/playback/mac-probe", {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({ itemKey: current.key }),
      });
      const messages = {
        expected_playing:
          "Spotify on this Mac is playing the selected song. This test does not start the shuffled queue.",
        expected_paused:
          "Spotify loaded the selected song but paused. Press Play in Spotify to hear it.",
        other_track:
          "Spotify is playing a different song. The selected song was not confirmed.",
        idle: "Spotify reports no local playback. Open Spotify on this Mac and try again.",
        unavailable:
          "Spotify on this Mac is unavailable. Open the Spotify app and try again.",
      };
      if (result.accepted) {
        clearConnectAfterMacProbe();
        try {
          await reloadRotationAfterMacProbe();
        } catch (error) {
          setMacProbeMessage(
            `Local test completed, but Rotation could not refresh: ${describeError(error)} Reload the page before normal playback.`,
          );
          return;
        }
      }
      setMacProbeMessage(
        result.accepted
          ? `${messages[result.state]} Choose a device above and press Play to start normal Rotation playback.`
          : "Spotify on this Mac did not accept the playback test. Open Spotify and try again.",
      );
    } catch (error) {
      if (
        (error as Error).name === "TimeoutError" ||
        (error as Error).name === "AbortError"
      ) {
        clearConnectAfterMacProbe();
        try {
          await reloadRotationAfterMacProbe();
          setMacProbeMessage(
            "The local Mac test timed out, so playback may have changed. Choose a device and press Play to restart normal Rotation playback.",
          );
        } catch (refreshError) {
          setMacProbeMessage(
            `The local Mac test timed out and Rotation could not refresh: ${describeError(refreshError)} Reload the page before normal playback.`,
          );
        }
      } else setMacProbeMessage(describeError(error));
    } finally {
      command.current = false;
      setBusy(false);
      setMacProbeBusy(false);
    }
  }
  async function pauseAtEnd(removedUri?: string) {
    if (
      deviceIdRef.current &&
      (playingIntentRef.current || pendingUriRef.current)
    ) {
      await api("/api/playback/control", {
        method: "PUT",
        signal: playbackTimeout(),
        body: JSON.stringify({
          deviceId: deviceIdRef.current,
          action: "pause",
          uri: removedUri,
        }),
      });
    }
    setIntent(false);
    setPendingUri("");
    pendingUriRef.current = "";
    unconfirmedUriRef.current = "";
    setPlayback((previous) =>
      previous ? { ...previous, isPlaying: false } : previous,
    );
  }
  async function seekTo(nextPosition: number) {
    if (!deviceIdRef.current) throw new Error("Choose a Spotify device first.");
    await api("/api/playback/seek", {
      method: "PUT",
      signal: playbackTimeout(),
      body: JSON.stringify({
        deviceId: deviceIdRef.current,
        positionMs: nextPosition,
      }),
    });
    setPosition(nextPosition);
    positionRef.current = nextPosition;
    setSeekValue(null);
    void pollRef.current();
  }
  async function navigate(direction: "next" | "previous", automatic = false) {
    if (!navigationAvailable(pendingUriRef.current, command.current)) {
      if (!automatic && pendingUriRef.current)
        setPlayerMessage(
          "Wait for Spotify to confirm this track before moving to another. If it does not start, Play will return shortly.",
        );
      return;
    }
    await run(async () => {
      if (!deviceIdRef.current)
        throw new Error("Choose a Spotify device first.");
      if (direction === "previous" && positionRef.current > 3_000) {
        await seekTo(0);
        return;
      }
      // The server plays the new window before it persists the index. A failed
      // Spotify command leaves the app on its previous item.
      let updated: Rotation;
      try {
        updated = await api<Rotation>("/api/rotation/navigate", {
          method: "POST",
          signal: playbackTimeout(),
          body: JSON.stringify({ direction, deviceId: deviceIdRef.current }),
        });
      } catch (error) {
        if (
          (error as Error).name === "TimeoutError" ||
          (error as Error).name === "AbortError"
        ) {
          try {
            const latest = await api<Rotation | null>("/api/rotation", {
              signal: playbackTimeout(),
            });
            if (latest) {
              rotationRef.current = latest;
              setRotation(latest);
              queuedThroughRef.current = latest.queuedWindow?.endIndex ?? -1;
            }
          } catch {
            // The next visible playback poll can still recover the saved index.
          }
          window.setTimeout(() => void pollRef.current(), 0);
        }
        if (automatic) {
          setIntent(false);
          setPlayerMessage(
            "Spotify stopped at this track. Press Next or Play to continue.",
          );
        }
        throw error;
      }
      setRotation(updated);
      rotationRef.current = updated;
      const item = updated.items.find(
        (entry) => entry.key === updated.order[updated.currentIndex],
      );
      if (item) {
        queuedThroughRef.current = updated.queuedWindow?.endIndex ?? -1;
        markPending(item);
      } else {
        setIntent(false);
        setPlayback(null);
        setPosition(0);
        setPendingUri("");
        pendingUriRef.current = "";
        if (automatic)
          setNotice({
            text: "You reached the end of this rotation. Start again for a fresh order.",
            kind: "info",
          });
      }
    });
  }
  async function remove(withoutArchive = false) {
    if (!current) return;
    const key = current.key;
    setConfirm(false);
    await run(async () => {
      let updated: Rotation;
      try {
        const response = await api<
          Rotation | { rotation: Rotation; operationId: string }
        >("/api/rotation/remove", {
          method: "POST",
          body: JSON.stringify({
            itemKey: key,
            removeWithoutArchive: withoutArchive,
          }),
        });
        updated = resultRotation(response);
      } catch (e) {
        const error = e as ApiError;
        setFailure({
          itemKey: key,
          operationId: error.operationId,
          partial: error.code === "partial_failure" || !!error.partial,
          conflict:
            error.code === "duplicate_conflict" ||
            error.code === "playlist_changed",
          uncertain: error.code === "archive_uncertain",
        });
        throw e;
      }
      setRotation(updated);
      setFailure(null);
      setNotice({
        text:
          hasArchive && !withoutArchive
            ? "Removed from Rotation and added to history."
            : "Removed from Rotation.",
        kind: "ok",
      });
      const next = updated.items.find(
        (item) => item.key === updated.order[updated.currentIndex],
      );
      if (next && canPlay) {
        try {
          await play(next);
        } catch (error) {
          setIntent(false);
          setNotice({
            text: `Track removed, but the next track could not start: ${describeError(error)} Press Play to retry without repeating removal.`,
            kind: "error",
          });
        }
      } else {
        try {
          await pauseAtEnd(current.uri);
        } catch (error) {
          setIntent(false);
          setNotice({
            text: `Track removed, but Spotify could not pause: ${describeError(error)} Pause it in Spotify.`,
            kind: "error",
          });
        }
      }
    });
  }
  async function retry() {
    if (!failure?.operationId) return;
    await run(async () => {
      const removedUri = current?.uri;
      const response = await api<{ rotation: Rotation }>(
        "/api/rotation/retry",
        {
          method: "POST",
          body: JSON.stringify({ operationId: failure.operationId }),
        },
      );
      const updated = response.rotation;
      setRotation(updated);
      setFailure(null);
      setNotice({ text: "Removal completed.", kind: "ok" });
      const next = updated.items.find(
        (item) => item.key === updated.order[updated.currentIndex],
      );
      if (next && canPlay) {
        try {
          await play(next);
        } catch (error) {
          setIntent(false);
          setNotice({
            text: `Removal completed, but the next track could not start: ${describeError(error)} Press Play to retry.`,
            kind: "error",
          });
        }
      } else {
        try {
          await pauseAtEnd(removedUri);
        } catch (error) {
          setIntent(false);
          setNotice({
            text: `Removal completed, but Spotify could not pause: ${describeError(error)} Pause it in Spotify.`,
            kind: "error",
          });
        }
      }
    });
  }
  async function refreshPlaybackOnce() {
    if (
      !deviceIdRef.current ||
      command.current ||
      Date.now() < nextPollAllowedRef.current
    )
      return;
    const requestedDeviceId = deviceIdRef.current;
    let remote: ConnectPlayback;
    const observationGap = lastObservedAtRef.current
      ? Date.now() - lastObservedAtRef.current
      : 0;
    try {
      remote = await api<ConnectPlayback>("/api/playback/state", {
        signal: AbortSignal.timeout(10_000),
      });
      // A local Mac probe or a device change can begin while this GET waits.
      // Ignore its stale result before it can restore the old Connect queue.
      if (
        !playbackObservationStillRelevant(
          requestedDeviceId,
          deviceIdRef.current,
          command.current,
        )
      )
        return;
      lastObservedAtRef.current = Date.now();
    } catch (error) {
      if (
        !playbackObservationStillRelevant(
          requestedDeviceId,
          deviceIdRef.current,
          command.current,
        )
      )
        return;
      const apiError = error as ApiError;
      if (apiError.status === 429)
        nextPollAllowedRef.current =
          Date.now() + (apiError.retryAfter ?? 10) * 1_000;
      if (!expirePendingIfOverdue())
        setPlayerMessage(
          pendingUriRef.current
            ? `Still waiting for Spotify to confirm playback: ${describeError(error)}`
            : describeError(error),
        );
      return;
    }
    const active = rotationRef.current;
    const index = active?.currentIndex ?? -1;
    const currentItem = active?.items.find(
      (item) => item.key === active.order[index],
    );
    const nextItem = active?.items.find(
      (item) => item.key === active.order[index + 1],
    );
    if (!currentItem) return;

    if (pendingUriRef.current) {
      const pendingStatus = pendingPlaybackStatus(
        remote,
        deviceIdRef.current,
        pendingUriRef.current,
        pendingSinceRef.current,
        Date.now(),
      );
      if (pendingStatus === "confirmed") {
        pendingUriRef.current = "";
        unconfirmedUriRef.current = "";
        setPendingUri("");
        setPlayback(remote);
        setPosition(remote.positionMs);
        positionRef.current = remote.positionMs;
        setIntent(true);
        setPlayerMessage(
          `Playing on ${selectedDevice?.name || "Spotify device"}.`,
        );
        return;
      }
      if (pendingStatus === "waiting") return;
      const expectedUri = pendingUriRef.current;
      const mismatch = unconfirmedPlaybackMismatch(
        remote,
        deviceIdRef.current,
        expectedUri,
      );
      unconfirmedUriRef.current = expectedUri;
      pendingUriRef.current = "";
      setPendingUri("");
      if (mismatch !== "none") {
        setIntent(false);
        setPlayback(null);
        setPosition(0);
        positionRef.current = 0;
        setPlayerMessage(
          pendingRecoveryMessage(
            mismatch,
            selectedDevice?.name || "this device",
          ),
        );
        if (
          (mismatch === "other-device" || mismatch === "unknown-device") &&
          Date.now() - lastDeviceRefreshAtRef.current > 15_000
        )
          void loadDevices();
        return;
      }
    }

    if (unconfirmedUriRef.current) {
      const mismatch = unconfirmedPlaybackMismatch(
        remote,
        deviceIdRef.current,
        unconfirmedUriRef.current,
      );
      if (mismatch !== "none") {
        setIntent(false);
        setPlayback(null);
        setPosition(0);
        positionRef.current = 0;
        setPlayerMessage(
          pendingRecoveryMessage(
            mismatch,
            selectedDevice?.name || "this device",
          ),
        );
        return;
      }
      unconfirmedUriRef.current = "";
    }

    const transition = classifyRemotePlayback(
      remote,
      deviceIdRef.current,
      currentItem.uri,
      nextItem?.uri ?? null,
      positionRef.current,
      currentItem.durationMs ?? 0,
      playingIntentRef.current,
    );
    const byKey = new Map(active!.items.map((item) => [item.key, item.uri]));
    const orderedUris = active!.order.map((key) => byKey.get(key) ?? "");
    const savedWindow = active!.queuedWindow;
    const queuedThroughIndex =
      queuedThroughRef.current >= index
        ? queuedThroughRef.current
        : savedWindow?.deviceId === deviceIdRef.current &&
            savedWindow.startIndex <= index
          ? savedWindow.endIndex
          : -1;
    const forward =
      remote.deviceId === deviceIdRef.current
        ? findForwardMatch(
            orderedUris,
            index,
            queuedThroughIndex,
            remote.uri,
          )
        : { kind: "none" as const };
    if (forward.kind === "match" && remote.uri) {
      command.current = true;
      setBusy(true);
      setPlayerMessage("Catching up with Spotify playback…");
      try {
        const updated = await api<Rotation>("/api/rotation/sync", {
          method: "POST",
          signal: playbackTimeout(),
          body: JSON.stringify({
            targetIndex: forward.targetIndex,
            deviceId: deviceIdRef.current,
            uri: remote.uri,
            queuedThroughIndex,
          }),
        });
        rotationRef.current = updated;
        setRotation(updated);
        queuedThroughRef.current = queuedThroughIndex;
        setPlayback(remote);
        setPosition(remote.positionMs);
        positionRef.current = remote.positionMs;
        setIntent(remote.isPlaying);
        setActiveDeviceId(remote.deviceId);
        setPlayerMessage(
          `Caught up after ${updated.currentIndex - index} track${updated.currentIndex - index === 1 ? "" : "s"} advanced on ${selectedDevice?.name || "Spotify device"}.`,
        );
        // Recheck promptly so a refreshed queue can be scheduled near its edge.
        window.setTimeout(() => void pollRef.current(), 0);
      } catch (error) {
        let recovered = false;
        if (
          (error as Error).name === "TimeoutError" ||
          (error as Error).name === "AbortError"
        ) {
          try {
            const latest = await api<Rotation | null>("/api/rotation", {
              signal: playbackTimeout(),
            });
            if (latest) {
              rotationRef.current = latest;
              setRotation(latest);
              queuedThroughRef.current = latest.queuedWindow?.endIndex ?? -1;
              recovered = latest.currentIndex === forward.targetIndex;
            }
          } catch {
            // A later poll can still reconcile after the server responds.
          }
          window.setTimeout(() => void pollRef.current(), 0);
        }
        if (recovered) {
          setPlayback(remote);
          setPosition(remote.positionMs);
          positionRef.current = remote.positionMs;
          setIntent(remote.isPlaying);
          setPlayerMessage("Spotify playback and rotation are synchronized.");
          return;
        }
        setIntent(false);
        setPlayerMessage(
          `Spotify is ahead of this rotation, but it could not sync: ${describeError(error)} Press Play to return to this track.`,
        );
      } finally {
        command.current = false;
        setBusy(false);
      }
      return;
    }
    if (
      forward.kind === "ambiguous" &&
      (transition === "other-track" ||
        (transition === "current-playing" &&
          observationGap > 15_000 &&
          remote.positionMs + 10_000 < positionRef.current))
    ) {
      setIntent(false);
      setPlayback(remote);
      setPosition(remote.positionMs);
      positionRef.current = remote.positionMs;
      setPlayerMessage(
        "Spotify is playing a repeated track, so its place in the rotation is unclear. Press Play to return to the selected track.",
      );
      return;
    }
    if (transition === "current-playing") {
      setPlayback(remote);
      setPosition(remote.positionMs);
      positionRef.current = remote.positionMs;
      setIntent(true);
      setActiveDeviceId(remote.deviceId);
      setPlayerMessage(
        `Playing on ${selectedDevice?.name || "Spotify device"}.`,
      );
      if (queuedThroughRef.current < index && queuedThroughIndex >= index)
        queuedThroughRef.current = queuedThroughIndex;
      if (
        nextItem &&
        queuedThroughRef.current >= index &&
        queuedThroughRef.current < active!.order.length - 1 &&
        index >= Math.max(0, queuedThroughRef.current - 2) &&
        !refreshingQueueRef.current
      ) {
        refreshingQueueRef.current = true;
        try {
          const result = await api<{ queuedThroughIndex: number }>(
            "/api/playback",
            {
              method: "PUT",
              signal: playbackTimeout(),
              body: JSON.stringify({
                deviceId: deviceIdRef.current,
                uri: currentItem.uri,
                positionMs: remote.positionMs,
              }),
            },
          );
          queuedThroughRef.current = result.queuedThroughIndex;
        } catch (error) {
          setPlayerMessage(
            `Could not refresh the upcoming queue: ${describeError(error)}`,
          );
        } finally {
          refreshingQueueRef.current = false;
        }
      }
    } else if (transition === "current-paused") {
      setPlayback(remote);
      setPosition(remote.positionMs);
      positionRef.current = remote.positionMs;
      setIntent(false);
      setPlayerMessage(
        `Paused on ${selectedDevice?.name || "Spotify device"}.`,
      );
    } else if (transition === "expected-next") {
      if (nextItem?.uri !== currentItem.uri || queuedThroughIndex < index + 1) {
        setIntent(false);
        setPlayback(remote);
        setPosition(remote.positionMs);
        positionRef.current = remote.positionMs;
        setPlayerMessage(
          "Spotify advanced, but the saved queue cannot confirm its place. Press Play to return to the selected track.",
        );
        return;
      }
      // An adjacent duplicate has the same URI. A near-end backward position
      // jump proves exactly one step, although URI-only server sync cannot.
      if (command.current) return;
      command.current = true;
      setBusy(true);
      setPlayerMessage("Syncing to the next repeated track…");
      try {
        const updated = await api<Rotation>("/api/rotation/navigate", {
          method: "POST",
          signal: playbackTimeout(),
          body: JSON.stringify({ direction: "next" }),
        });
        const selected = updated.items.find(
          (item) => item.key === updated.order[updated.currentIndex],
        );
        if (selected?.uri !== remote.uri)
          throw new Error(
            "Spotify moved to a track outside the saved rotation. Choose Play to return.",
          );
        setRotation(updated);
        rotationRef.current = updated;
        setPlayback(remote);
        setPosition(remote.positionMs);
        positionRef.current = remote.positionMs;
        setIntent(remote.isPlaying);
        setPlayerMessage(
          `Playing on ${selectedDevice?.name || "Spotify device"}.`,
        );
      } catch (error) {
        setIntent(false);
        setNotice({ text: describeError(error), kind: "error" });
        setPlayerMessage(
          "Spotify advanced, but rotation could not sync. Press Play to return to your rotation.",
        );
      } finally {
        command.current = false;
        setBusy(false);
      }
    } else if (transition === "ended") {
      await navigate("next", true);
    } else {
      setIntent(false);
      setPlayback(null);
      setPosition(0);
      positionRef.current = 0;
      setPlayerMessage(
        transition === "other-device"
          ? "Playback moved to another Spotify device. Refresh devices, choose where to listen, then press Play."
          : transition === "other-track"
            ? "Spotify continued to a track outside this rotation. Pause it in Spotify, or press Play to return to your rotation."
            : "No playback is active on the selected device. Press Play to start listening.",
      );
      if (
        transition === "other-device" &&
        Date.now() - lastDeviceRefreshAtRef.current > 15_000
      )
        void loadDevices();
    }
  }
  async function refreshPlayback() {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      await refreshPlaybackOnce();
    } finally {
      pollingRef.current = false;
    }
  }
  pollRef.current = refreshPlayback;
  function askRemove() {
    const key = `rotation-confirmed:${session?.settings?.archiveId || "none"}`;
    if (sessionStorage.getItem(key) === "yes") void remove();
    else setConfirm(true);
  }
  function confirmRemove() {
    if (dontAsk)
      sessionStorage.setItem(
        `rotation-confirmed:${session?.settings?.archiveId || "none"}`,
        "yes",
      );
    void remove();
  }
  async function save() {
    if (!sourceId || sourceId === archiveId) return;
    await run(async () => {
      const result = await api<{
        settings: { sourceId: string; archiveId: string | null };
      }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ sourceId, archiveId: archiveId || null }),
      });
      setSession((previous) =>
        previous ? { ...previous, settings: result.settings } : previous,
      );
      setRotation(null);
      setFailure(null);
      setPage("player");
      await restartRotation();
      setNotice({ text: "Playlist settings saved.", kind: "ok" });
    });
  }
  async function logout() {
    await run(async () => {
      await api("/auth/logout", { method: "POST" });
      setRotation(null);
      setPlaylists([]);
      setDevices([]);
      setDeviceId("");
      deviceIdRef.current = "";
      setIntent(false);
      setPlayback(null);
      setCsrfToken();
      if (session?.desktop) await loadSession();
      else setSession({ authenticated: false });
      setNotice({ text: "Disconnected from Spotify.", kind: "info" });
    });
  }
  async function quitDesktop() {
    await run(async () => {
      await api("/api/desktop/quit", { method: "POST" });
      setNotice({
        text: "rotation is closing. You can close this tab.",
        kind: "info",
      });
    });
  }
  const duration = playback?.durationMs || current?.durationMs || 0;
  const progress = seekValue ?? position;
  useEffect(() => {
    if (!session?.authenticated || page !== "player") return;
    const poll = (waking = false) => {
      expirePendingIfOverdue();
      if (document.visibilityState !== "visible") return;
      const gap = lastObservedAtRef.current
        ? Date.now() - lastObservedAtRef.current
        : 0;
      const shouldRefreshDevices =
        (!deviceIdRef.current || (waking && gap > 20_000)) &&
        Date.now() - lastDeviceRefreshAtRef.current >
          (waking ? 5_000 : 30_000);
      if (shouldRefreshDevices) {
        void loadDevices().then(() => void pollRef.current());
      } else if (deviceIdRef.current) {
        if (waking && gap > 20_000)
          setPlayerMessage("Checking Spotify playback after your return…");
        void pollRef.current();
      }
    };
    poll();
    const interval = window.setInterval(
      () => poll(),
      !deviceId ? 30_000 : pendingUri ? 3_000 : playingIntent ? 5_000 : 15_000,
    );
    const onWake = () => poll(true);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [session?.authenticated, deviceId, page, playingIntent, pendingUri, loadDevices]);
  return (
    <div className="app">
      <header className="header wrap">
        <button
          className="wordmark"
          onClick={() => setPage("player")}
          aria-label="rotation home"
        >
          rotation<span>.</span>
        </button>
        <div className="header-actions">
          {session?.authenticated && (
            <span className="account-pill">
              <i />
              {session.account?.name ||
                session.account?.display_name ||
                session.account?.id ||
                "Spotify connected"}
            </span>
          )}
          <button
            className="theme-button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
            {theme === "light" ? "Dark" : "Light"}
          </button>
          {session?.desktop && (
            <button
              className="quit-button"
              onClick={() => void quitDesktop()}
              disabled={busy}
              title="Stop rotation on this computer"
            >
              Quit
            </button>
          )}
        </div>
      </header>
      {notice && (
        <div
          className={`notice ${notice.kind}`}
          role="status"
          aria-live="polite"
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}
      <main className="wrap">
        {loading ? (
          <div className="center-state">
            <div className="loader" />
            <p>Getting your listening space ready…</p>
          </div>
        ) : !session?.authenticated ? (
          <section className="signin">
            <div className="brand-symbol">♪</div>
            <p className="eyebrow">A quieter way to listen</p>
            <h1>Your playlist, with room to breathe.</h1>
            <p className="lead">
              Listen through your rotation and clear out tracks as you go.
            </p>
            <a className="spotify-button" href="/auth/start">
              Continue with Spotify
            </a>
            <p className="signin-detail">
              Connect to read and manage your playlists and control an available
              Spotify device. Spotify Premium is needed for playback.
            </p>
            <p className="privacy">
              Your Spotify password stays with Spotify. Connection tokens stay
              in your local app data; no music is stored here.
            </p>
            {session?.error && (
              <p className="inline-error" role="alert">
                {session.error} <a href="/auth/start">Try again</a>
              </p>
            )}
          </section>
        ) : (
          <>
            <nav className="subnav" aria-label="Main navigation">
              <button
                className={page === "player" ? "active" : ""}
                onClick={() => setPage("player")}
              >
                Player
              </button>
              <button
                className={page === "settings" ? "active" : ""}
                onClick={() => setPage("settings")}
              >
                Settings
              </button>
            </nav>
            {page === "settings" ? (
              <section className="settings">
                <p className="eyebrow">Make it yours</p>
                <h1>Set up your listening mix.</h1>
                <p className="lead small">
                  Choose where you listen from and where removed songs go.
                </p>
                {session.settings?.sourceId && (
                  <div className="info-box">
                    Changing playlists reloads your rotation and may move
                    playback to a different track.
                  </div>
                )}
                <div className="settings-card">
                  {playlistsLoading && (
                    <p className="muted">Loading playlists…</p>
                  )}
                  {playlistError && (
                    <div className="inline-error" role="alert">
                      {playlistError}{" "}
                      <button
                        className="text-button"
                        onClick={() => void loadPlaylists()}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {!playlistsLoading &&
                    !playlistError &&
                    playlists.length === 0 && (
                      <div className="empty-mini">
                        <h2>No playlists found</h2>
                        <p>
                          Create or follow a playlist in Spotify, then refresh.
                          Editing needs ownership or collaboration access.
                        </p>
                        <button
                          className="secondary-button"
                          onClick={() => void loadPlaylists()}
                        >
                          Refresh playlists
                        </button>
                      </div>
                    )}
                  {playlists.length > 0 && (
                    <div className="settings-grid">
                      <Picker
                        label="Play from"
                        value={sourceId}
                        onChange={setSourceId}
                        playlists={playlists}
                      />
                      <Picker
                        label="Send removed tracks to"
                        value={archiveId}
                        onChange={setArchiveId}
                        playlists={playlists}
                        optional
                      />
                    </div>
                  )}
                  {sourceId && archiveId === sourceId && (
                    <p className="inline-error" role="alert">
                      Choose a different history playlist, or select None.
                    </p>
                  )}
                  {playlists.length > 0 && (
                    <div className="settings-actions">
                      <button
                        className="primary-button"
                        onClick={() => void save()}
                        disabled={busy || !sourceId || sourceId === archiveId}
                      >
                        {busy ? "Saving…" : "Save settings"}
                      </button>
                      {session.settings?.sourceId && (
                        <button
                          className="secondary-button"
                          onClick={() => setPage("player")}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className="disconnect-button"
                  onClick={() => void logout()}
                  disabled={busy}
                >
                  Disconnect Spotify
                </button>
              </section>
            ) : (
              <section className="player-page">
                <div className="hero">
                  <p className="eyebrow">Your listening journal</p>
                  <h1>Good things, on repeat.</h1>
                  <p className="lead small">
                    Your handpicked mix, played in a fresh order.
                  </p>
                </div>
                <div className="config-row">
                  <button
                    className="config-chip"
                    onClick={() => setPage("settings")}
                  >
                    <span>Play from</span>
                    <strong>{source?.name || "Selected playlist"}</strong>
                    <span aria-hidden="true">↗</span>
                  </button>
                  <button
                    className="config-chip"
                    onClick={() => setPage("settings")}
                  >
                    <span>Send removed to</span>
                    <strong>
                      {hasArchive
                        ? archive?.name || "Selected history"
                        : "None"}
                    </strong>
                    <span aria-hidden="true">↗</span>
                  </button>
                </div>
                <div className="device-card">
                  <div className="device-card-copy">
                    <p className="eyebrow">Listen on Spotify</p>
                    <label htmlFor="connect-device">Playback device</label>
                    <p>
                      Choose where Spotify should play your rotation. Audio
                      plays on that device, not in this browser.
                    </p>
                  </div>
                  <div className="device-controls">
                    <select
                      id="connect-device"
                      value={deviceId}
                      onChange={(event) => selectDevice(event.target.value)}
                      disabled={devicesLoading || busy}
                    >
                      <option value="">Choose an available device</option>
                      {devices.map((device, index) => (
                        <option
                          key={device.id || `restricted-${index}`}
                          value={device.id || ""}
                          disabled={!device.id || device.isRestricted}
                        >
                          {device.name} · {device.type}
                          {device.id === activeDeviceId ? " · Active" : ""}
                          {device.isRestricted || !device.id
                            ? " · Unavailable"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary-button"
                      onClick={() => void loadDevices()}
                      disabled={devicesLoading || busy}
                    >
                      {devicesLoading ? "Refreshing…" : "Refresh devices"}
                    </button>
                  </div>
                  {deviceError && (
                    <p className="inline-error" role="alert">
                      {deviceError}{" "}
                      {reauthorizationNeeded && (
                        <a href="/auth/start">Reconnect Spotify</a>
                      )}
                    </p>
                  )}
                  {!devicesLoading && devices.length === 0 && !deviceError && (
                    <p className="device-help">
                      No Spotify devices found. Open Spotify on your phone,
                      computer, or speaker, then refresh. Some devices may not
                      appear in Spotify Connect.
                    </p>
                  )}
                  {devices.length > 0 && !deviceId && (
                    <p className="device-help">
                      Select an available device to enable playback controls.
                    </p>
                  )}
                  {session.macLocalProbeAvailable && current && (
                    <div className="device-help">
                      <p>
                        Mac playback test: play this selected song in Spotify on
                        this Mac. This does not start the shuffled queue.
                      </p>
                      <button
                        className="secondary-button"
                        onClick={() => void probeMacPlayback()}
                        disabled={busy || !!pendingUri}
                      >
                        {macProbeBusy ? "Testing local Mac playback…" : "Try local Mac playback"}
                      </button>
                      {macProbeMessage && (
                        <p role="status" aria-live="polite">
                          {macProbeMessage}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                {!session.settings?.sourceId ? (
                  <div className="empty-state">
                    <h2>Let’s set your rotation.</h2>
                    <p>Choose a source playlist to begin.</p>
                    <button
                      className="primary-button"
                      onClick={() => setPage("settings")}
                    >
                      Choose playlists
                    </button>
                  </div>
                ) : rotationLoading ? (
                  <div className="center-state">
                    <div className="loader" />
                    <p>Shuffling your rotation…</p>
                  </div>
                ) : rotationError ? (
                  <div className="empty-state">
                    <h2>We couldn’t load your rotation.</h2>
                    <p>{rotationError}</p>
                    <button
                      className="secondary-button"
                      onClick={() => void loadRotation()}
                    >
                      Try again
                    </button>
                  </div>
                ) : !current ? (
                  <div className="empty-state">
                    <div className="empty-icon">♪</div>
                    <h2>
                      {rotation?.items.length
                        ? "Your rotation is clear."
                        : "Your playlist is empty."}
                    </h2>
                    <p>
                      {rotation?.items.length
                        ? "You listened through this session. Start again for a fresh order."
                        : "Add tracks in Spotify, then refresh."}
                    </p>
                    <button
                      className="primary-button"
                      onClick={() => void restartRotation()}
                    >
                      {rotation?.items.length
                        ? "Start again"
                        : "Refresh playlist"}
                    </button>
                  </div>
                ) : (
                  <div className="player-layout">
                    <article className="player-card">
                      <div className="artwork">
                        {current.imageUrl ? (
                          <a
                            href={
                              current.spotifyUrl || "https://open.spotify.com/"
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${current.name} in Spotify`}
                          >
                            <img
                              src={current.imageUrl}
                              alt={`${current.album || current.name} artwork`}
                            />
                          </a>
                        ) : (
                          <div className="art-placeholder">
                            rotation <span>♪</span>
                          </div>
                        )}
                      </div>
                      <div className="track-panel">
                        <p className="eyebrow now-label">
                          ▮▮▮ &nbsp;{" "}
                          {playingIntent
                            ? "Now playing"
                            : pendingUri
                              ? "Starting"
                              : "Selected track"}{" "}
                          · shuffled
                        </p>
                        <h2>
                          {current.spotifyUrl ? (
                            <a
                              href={current.spotifyUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {current.name}
                            </a>
                          ) : (
                            current.name
                          )}
                        </h2>
                        <p className="artist">{artist(current)}</p>
                        <p className="album">{current.album || "Spotify"}</p>
                        <p className="device-context">
                          Output: {selectedDevice?.name || "No device selected"}
                        </p>
                        <div className="transport">
                          <button
                            aria-label="Previous track"
                            onClick={() => void navigate("previous")}
                            disabled={!canPlay || !navigationAvailable(pendingUri, busy)}
                          >
                            ↶
                          </button>
                          <button
                            className="play-button"
                            aria-label={playingIntent ? "Pause" : "Play"}
                            onClick={() => void togglePlayback()}
                            disabled={busy || !canPlay || !!pendingUri}
                          >
                            {playingIntent ? "Ⅱ" : "▶"}
                          </button>
                          <button
                            aria-label="Next track"
                            onClick={() => void navigate("next")}
                            disabled={!canPlay || !navigationAvailable(pendingUri, busy)}
                          >
                            ↷
                          </button>
                        </div>
                        <div className="progress">
                          <input
                            type="range"
                            min="0"
                            max={Math.max(1, duration)}
                            value={Math.min(duration, progress)}
                            onChange={(e) =>
                              setSeekValue(Number(e.target.value))
                            }
                            onPointerUp={(event) => {
                              if (seekValue !== null)
                                void run(() =>
                                  seekTo(Number(event.currentTarget.value)),
                                );
                            }}
                            onKeyUp={(event) => {
                              if (seekValue !== null)
                                void run(() =>
                                  seekTo(Number(event.currentTarget.value)),
                                );
                            }}
                            disabled={
                              !canPlay ||
                              !duration ||
                              playback?.uri !== current.uri ||
                              !!pendingUri ||
                              busy
                            }
                            aria-label="Seek within track"
                            style={
                              {
                                "--progress": `${duration ? (progress / duration) * 100 : 0}%`,
                              } as CSSProperties
                            }
                          />
                          <div className="time-row">
                            <span>{formatTime(progress)}</span>
                            <span>{formatTime(duration)}</span>
                          </div>
                        </div>
                        <div
                          className="player-status"
                          role="status"
                          aria-live="polite"
                        >
                          {playerMessage ||
                            (canPlay
                              ? `Ready on ${selectedDevice?.name}. Press Play to listen.`
                              : "Choose a Spotify device to listen.")}
                        </div>
                        {canPlay && !playingIntent && !pendingUri && (
                          <button
                            className="secondary-button start-button"
                            onClick={() => void start()}
                            disabled={busy}
                          >
                            Play on {selectedDevice?.name}
                          </button>
                        )}
                        <div className="remove-area">
                          <button
                            className="remove-button"
                            onClick={askRemove}
                            disabled={busy || !!failure || duplicate}
                            aria-label={`Remove and skip ${current.name}${hasArchive ? ", sending it to history" : ", without archiving"}`}
                          >
                            <span aria-hidden="true">×</span> Remove and skip
                          </button>
                          <p>
                            {duplicate
                              ? "This track appears more than once in the playlist. Spotify cannot identify this exact copy safely, so removal is unavailable."
                              : hasArchive
                                ? `Removes this item from ${source?.name || "Rotation"} and sends it to ${archive?.name || "history"}.`
                                : `Removes this item from ${source?.name || "Rotation"}. Nothing is archived.`}
                          </p>
                        </div>
                        <a
                          className="spotify-attribution"
                          href={
                            current.spotifyUrl || "https://open.spotify.com/"
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Listen on Spotify ↗
                        </a>
                      </div>
                    </article>
                    {failure && (
                      <div className="recovery" role="alert">
                        <h3>Removal needs attention</h3>
                        <p>
                          {failure.conflict
                            ? "The playlist changed or this duplicate track cannot be identified safely. Refresh the playlist before trying again."
                            : failure.uncertain
                              ? "Spotify may have added this track to history, but did not confirm it. Check the history playlist in Spotify. You can keep the track or remove it without adding to history again."
                              : failure.partial
                                ? "Added to history, but still in Rotation. Retry will not add it to history twice."
                                : "Could not add the track to history. It remains in Rotation."}
                        </p>
                        <div className="recovery-actions">
                          {failure.operationId &&
                            !failure.conflict &&
                            !failure.uncertain && (
                              <button
                                className="primary-button"
                                onClick={() => void retry()}
                                disabled={busy}
                              >
                                Retry removal
                              </button>
                            )}
                          {!failure.partial && !failure.conflict && (
                            <button
                              className="secondary-button"
                              onClick={() => {
                                setFailure(null);
                                void remove(true);
                              }}
                              disabled={busy}
                            >
                              Remove without archiving
                            </button>
                          )}
                          {failure.conflict && (
                            <button
                              className="secondary-button"
                              onClick={() => {
                                setFailure(null);
                                void loadRotation();
                              }}
                            >
                              Refresh playlist
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() => setFailure(null)}
                          >
                            Keep track
                          </button>
                        </div>
                      </div>
                    )}
                    <section className="upcoming">
                      <div className="section-heading">
                        <div>
                          <p className="eyebrow">A little ahead</p>
                          <h2>Up next</h2>
                        </div>
                        <span>
                          {Math.max(
                            0,
                            ordered.length - (rotation?.currentIndex ?? 0) - 1,
                          )}{" "}
                          left in this rotation
                        </span>
                      </div>
                      {upcoming.length ? (
                        <ol>
                          {upcoming.map((item, i) => (
                            <li key={item.key}>
                              <span className="up-number">
                                {String(i + 1).padStart(2, "0")}
                              </span>
                              <div>
                                <strong>{item.name}</strong>
                                <span>{artist(item)}</span>
                              </div>
                              <time>{formatTime(item.durationMs)}</time>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="muted">
                          This is the last track in your current order.
                        </p>
                      )}
                    </section>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
      {confirm && current && (
        <div
          className="modal-backdrop"
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirm(false);
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirm(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
          >
            <p className="eyebrow">One small check</p>
            <h2 id="confirm-title">Remove this track?</h2>
            <p id="confirm-description">
              “{current.name}” will be removed from{" "}
              {source?.name || "your source playlist"}
              {hasArchive
                ? ` and added to ${archive?.name || "your history playlist"}`
                : ""}
              . Playback moves after removal succeeds.
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={dontAsk}
                onChange={(e) => setDontAsk(e.target.checked)}
              />{" "}
              Don’t ask again for this history setting during this session
            </label>
            <div className="modal-actions">
              <button
                className="secondary-button"
                autoFocus
                onClick={() => setConfirm(false)}
              >
                Cancel
              </button>
              <button className="remove-button" onClick={confirmRemove}>
                Remove and skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
