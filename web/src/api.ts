export type Playlist = {
  id: string;
  name: string;
  owner?: string | { display_name?: string; id?: string };
  images?: { url: string }[];
  collaborative?: boolean;
  public?: boolean;
};
export type Settings = { sourceId: string | null; archiveId: string | null };
export type Session = {
  authenticated: boolean;
  desktop?: boolean;
  account?: {
    display_name?: string;
    name?: string;
    id?: string;
    images?: { url: string }[];
  };
  settings?: Settings | null;
  csrfToken?: string;
  error?: string;
};
export type TrackItem = {
  key: string;
  uri: string;
  name: string;
  artists: string[] | string;
  album?: string;
  durationMs?: number;
  imageUrl?: string | null;
  spotifyUrl?: string | null;
};
export type Rotation = {
  items: TrackItem[];
  order: string[];
  currentIndex: number;
  snapshotId?: string;
  source?: Playlist | string | null;
  archive?: Playlist | string | null;
  queuedWindow?: { startIndex: number; endIndex: number; deviceId: string };
  playbackConfirmed?: boolean;
};
export type ConnectDevice = {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent?: number | null;
};
export type ConnectPlayback = {
  deviceId: string | null;
  uri: string | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
};
export type PlaybackLogEntry = {
  id: string;
  at: number;
  method: string;
  endpoint: string;
  status: number | null;
  elapsedMs: number;
  errorCode?: string;
  retryAfter?: number;
  reason?: string;
  outcome?: "accepted" | "confirmed";
};
export type PlaybackLogs = {
  buildId: string | null;
  cooldownUntil: number | null;
  entries: PlaybackLogEntry[];
};
export type ApiError = Error & {
  status?: number;
  operationId?: string;
  code?: string;
  retryAfter?: number;
  partial?: boolean;
  spotifyStatus?: number;
  reason?: string;
};

let csrfToken = "";
export function setCsrfToken(value?: string) {
  csrfToken = value ?? "";
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = options.method?.toUpperCase() ?? "GET";
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...(options.body != null ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ??
            body.message ??
            "Something went wrong. Please try again."),
    ) as ApiError;
    error.status = response.status;
    error.operationId = body.operationId ?? body.error?.operationId;
    error.code = body.code ?? body.error?.code;
    error.retryAfter = Number(response.headers.get("Retry-After")) || undefined;
    error.partial = Boolean(body.partial ?? body.error?.partial);
    error.spotifyStatus = body.spotifyStatus ?? body.error?.spotifyStatus;
    error.reason = body.reason ?? body.error?.reason;
    throw error;
  }
  return body as T;
}

export function describeError(error: unknown) {
  const e = error as ApiError;
  if (e?.name === "TimeoutError" || e?.name === "AbortError")
    return "Spotify took too long to respond. Refresh playback, then try again.";
  if (e?.code === "reauthorization_required")
    return "Spotify needs updated playback permission. Reconnect your account to continue.";
  if (e?.code === "playback_cooldown")
    return `Rotation is waiting before another Spotify command. Try again${e.retryAfter ? ` in about ${e.retryAfter} seconds` : " shortly"}.`;
  if (e?.reason && e.message) return e.message;
  if (e?.status === 401)
    return "Your Spotify connection expired. Please sign in again.";
  if (e?.status === 403)
    return "Spotify denied this action. Check playlist edit access or reconnect your account.";
  if (e?.status === 429)
    return `Spotify is limiting requests. Please wait${e.retryAfter ? ` about ${e.retryAfter} seconds` : " a moment"} and retry.`;
  return e?.message || "Something went wrong. Please try again.";
}
