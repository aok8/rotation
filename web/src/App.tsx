import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  api,
  describeError,
  setCsrfToken,
  type ApiError,
  type Playlist,
  type Rotation,
  type Session,
  type TrackItem,
} from "./api";
import {
  loadSpotifySdk,
  type PlaybackState,
  type SpotifyPlayer,
} from "./spotify-sdk";
import { hasLocalTrackEnded, reconcileSdkState } from "./playback-state";

type Notice = { text: string; kind: "ok" | "error" | "info" } | null;
type Phase =
  "connecting" | "ready" | "playing" | "paused" | "premium" | "error";
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
  const [phase, setPhase] = useState<Phase>("connecting");
  const [playerMessage, setPlayerMessage] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [playingIntent, setPlayingIntent] = useState(false);
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
  const player = useRef<SpotifyPlayer | null>(null);
  const deviceIdRef = useRef("");
  const playingIntentRef = useRef(false);
  const desiredUriRef = useRef("");
  const command = useRef(false);
  const rotationRef = useRef<Rotation | null>(null);
  const positionRef = useRef(0);
  const ended = useRef(false);
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
  useEffect(() => {
    if (!session?.authenticated) return;
    let cancelled = false;
    let instance: SpotifyPlayer | null = null;
    void loadSpotifySdk()
      .then(() => {
        if (cancelled || !window.Spotify) return;
        instance = new window.Spotify.Player({
          name: "rotation browser player",
          volume: 0.8,
          getOAuthToken: (callback) => {
            void api<{ accessToken: string }>("/api/token")
              .then((data) => callback(data.accessToken))
              .catch((e) => {
                setIntent(false);
                setPhase("error");
                setPlayerMessage(describeError(e));
              });
          },
        });
        player.current = instance;
        instance.addListener(
          "ready",
          ({ device_id }: { device_id: string }) => {
            setDeviceId(device_id);
            if (!playingIntentRef.current) setPhase("ready");
            setPlayerMessage("");
          },
        );
        instance.addListener("not_ready", () => {
          setDeviceId("");
          setIntent(false);
          setPhase("connecting");
          setPlayerMessage("The player disconnected. Try reconnecting.");
        });
        instance.addListener(
          "player_state_changed",
          (state: PlaybackState | null) => {
            if (!state) return;
            const active = rotationRef.current;
            const currentKey = active?.order[active.currentIndex];
            const currentItem = active?.items.find(
              (item) => item.key === currentKey,
            );
            const next = reconcileSdkState(state, {
              desiredUri: desiredUriRef.current,
              playingIntent: playingIntentRef.current,
              position: positionRef.current,
              expectedDuration: currentItem?.durationMs ?? 0,
            });
            if (!next) return;
            setPlayback(next.playback);
            setPosition(next.position);
            positionRef.current = next.position;
            if (next.phase) setPhase(next.phase);
            if (
              next.ended &&
              !ended.current &&
              rotationRef.current &&
              !command.current
            ) {
              ended.current = true;
              setIntent(false);
              void navigate("next", true);
            } else if (!next.ended) ended.current = false;
          },
        );
        instance.addListener("account_error", () => {
          setIntent(false);
          setPhase("premium");
          setPlayerMessage(
            "Spotify Premium is required for browser playback. Your playlist settings remain available.",
          );
        });
        for (const event of [
          "initialization_error",
          "authentication_error",
          "playback_error",
        ])
          instance.addListener(event, ({ message }: { message: string }) => {
            setIntent(false);
            setPhase("error");
            setPlayerMessage(
              message || "Spotify playback is unavailable. Try reconnecting.",
            );
          });
        setPhase("connecting");
        void instance.connect().then((ok) => {
          if (!ok && !cancelled) {
            setIntent(false);
            setPhase("error");
            setPlayerMessage("The Spotify browser player could not connect.");
          }
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setIntent(false);
          setPhase("error");
          setPlayerMessage(describeError(e));
        }
      });
    return () => {
      cancelled = true;
      instance?.disconnect();
      if (player.current === instance) player.current = null;
    };
    // Only reconnect the SDK after authentication changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated]);
  useEffect(() => {
    if (!playingIntent || !playback) return;
    const id = setInterval(
      () => setPosition((value) => Math.min(playback.duration, value + 250)),
      250,
    );
    return () => clearInterval(id);
  }, [playingIntent, playback?.duration]);
  const ordered = useMemo(() => {
    if (!rotation) return [];
    const byKey = new Map(rotation.items.map((item) => [item.key, item]));
    return rotation.order
      .map((key) => byKey.get(key))
      .filter((item): item is TrackItem => !!item);
  }, [rotation]);
  const current = ordered[rotation?.currentIndex ?? -1];
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
  const canPlay = !!deviceId && phase !== "premium";
  async function run(task: () => Promise<void>) {
    if (command.current) return;
    command.current = true;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setNotice({ text: describeError(e), kind: "error" });
    } finally {
      command.current = false;
      setBusy(false);
    }
  }
  async function play(item: TrackItem) {
    if (!deviceIdRef.current)
      throw new Error("The browser player is connecting. Try again shortly.");
    const previousUri = desiredUriRef.current;
    desiredUriRef.current = item.uri;
    try {
      await api("/api/playback", {
        method: "PUT",
        body: JSON.stringify({ deviceId: deviceIdRef.current, uri: item.uri }),
      });
    } catch (error) {
      desiredUriRef.current = previousUri;
      throw error;
    }
    setIntent(true);
    ended.current = false;
    setPlayback({
      paused: false,
      position: 0,
      duration: item.durationMs ?? 0,
      track_window: { current_track: { uri: item.uri } },
    });
    setPosition(0);
    setPhase("playing");
  }
  async function togglePlayback() {
    if (playingIntent) {
      await run(async () => {
        if (!deviceIdRef.current)
          throw new Error("The Spotify player is not ready.");
        await api("/api/playback/control", {
          method: "PUT",
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            action: "pause",
          }),
        });
        setIntent(false);
        setPlayback((previous) =>
          previous ? { ...previous, paused: true } : previous,
        );
        setPhase("paused");
      });
    } else if (
      playback?.track_window?.current_track?.uri === current?.uri &&
      deviceIdRef.current
    ) {
      await run(async () => {
        await api("/api/playback/control", {
          method: "PUT",
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            action: "resume",
          }),
        });
        desiredUriRef.current = current!.uri;
        setIntent(true);
        setPlayback((previous) =>
          previous ? { ...previous, paused: false } : previous,
        );
        setPhase("playing");
      });
    } else await start();
  }
  async function start() {
    await run(async () => {
      if (!player.current) throw new Error("The Spotify player is loading.");
      await player.current.activateElement();
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
  async function navigate(direction: "next" | "previous", automatic = false) {
    await run(async () => {
      if (direction === "previous" && position > 3000 && player.current) {
        await player.current.seek(0);
        setPosition(0);
        return;
      }
      const updated = await api<Rotation>("/api/rotation/navigate", {
        method: "POST",
        body: JSON.stringify({ direction }),
      });
      setRotation(updated);
      const item = updated.items.find(
        (entry) => entry.key === updated.order[updated.currentIndex],
      );
      if (item) await play(item);
      else if (automatic) {
        setIntent(false);
        setNotice({
          text: "You reached the end of this rotation. Start again for a fresh order.",
          kind: "info",
        });
        await player.current?.pause();
      }
    });
  }
  async function remove(withoutArchive = false) {
    if (!current) return;
    const key = current.key;
    setConfirm(false);
    await run(async () => {
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
        const updated = resultRotation(response);
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
        if (next && canPlay) await play(next);
        else await player.current?.pause();
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
    });
  }
  async function retry() {
    if (!failure?.operationId) return;
    await run(async () => {
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
      if (next && canPlay) await play(next);
    });
  }
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
      player.current?.disconnect();
      setRotation(null);
      setPlaylists([]);
      setCsrfToken();
      if (session?.desktop) await loadSession();
      else setSession({ authenticated: false });
      setNotice({ text: "Disconnected from Spotify.", kind: "info" });
    });
  }
  async function quitDesktop() {
    await run(async () => {
      await api("/api/desktop/quit", { method: "POST" });
      setNotice({ text: "rotation is closing. You can close this tab.", kind: "info" });
    });
  }
  const duration = playback?.duration || current?.durationMs || 0;
  const progress = seekValue ?? position;
  useEffect(() => {
    if (
      !hasLocalTrackEnded(playingIntent, !!current, position, duration) ||
      ended.current ||
      command.current
    )
      return;
    ended.current = true;
    setIntent(false);
    void navigate("next", true);
  }, [playingIntent, current, duration, position]);
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
              Connect to read and manage your playlists and play music in this
              browser. Spotify Premium is needed for playback.
            </p>
            <p className="privacy">
              Your credentials stay with Spotify. Tokens stay on your
              self-hosted server; no music is stored here.
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
                          ▮▮▮ &nbsp; Now playing · shuffled
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
                        <div className="transport">
                          <button
                            aria-label="Previous track"
                            onClick={() => void navigate("previous")}
                            disabled={busy || !canPlay}
                          >
                            ↶
                          </button>
                          <button
                            className="play-button"
                            aria-label={playingIntent ? "Pause" : "Play"}
                            onClick={() => void togglePlayback()}
                            disabled={busy || phase === "premium"}
                          >
                            {playingIntent ? "Ⅱ" : "▶"}
                          </button>
                          <button
                            aria-label="Next track"
                            onClick={() => void navigate("next")}
                            disabled={busy || !canPlay}
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
                            onPointerUp={() => {
                              if (seekValue !== null) {
                                void player.current?.seek(seekValue);
                                setPosition(seekValue);
                                setSeekValue(null);
                              }
                            }}
                            onKeyUp={() => {
                              if (seekValue !== null) {
                                void player.current?.seek(seekValue);
                                setPosition(seekValue);
                                setSeekValue(null);
                              }
                            }}
                            disabled={!canPlay || !duration}
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
                          {phase === "connecting"
                            ? "Connecting Spotify player…"
                            : phase === "premium" || phase === "error"
                              ? playerMessage
                              : phase === "ready"
                                ? "Ready. Start listening when you are ready."
                                : ""}
                        </div>
                        {["ready", "connecting", "error"].includes(phase) && (
                          <button
                            className="secondary-button start-button"
                            onClick={() => void start()}
                            disabled={busy || !deviceId}
                          >
                            Start listening
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
