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
};
export type ApiError = Error & {
  status?: number;
  operationId?: string;
  code?: string;
  retryAfter?: number;
  partial?: boolean;
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
    throw error;
  }
  return body as T;
}

export function describeError(error: unknown) {
  const e = error as ApiError;
  if (e?.status === 401)
    return "Your Spotify connection expired. Please sign in again.";
  if (e?.status === 403)
    return "Spotify denied this action. Check playlist edit access or reconnect your account.";
  if (e?.status === 429)
    return `Spotify is limiting requests. Please wait${e.retryAfter ? ` about ${e.retryAfter} seconds` : " a moment"} and retry.`;
  return e?.message || "Something went wrong. Please try again.";
}
