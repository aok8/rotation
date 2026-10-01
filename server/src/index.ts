import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";

const env = process.env;
const clientId = env.SPOTIFY_CLIENT_ID || "";
const clientSecret = env.SPOTIFY_CLIENT_SECRET || "";
const redirectUri = env.SPOTIFY_REDIRECT_URI || "";
const appBaseUrl = env.APP_BASE_URL || "http://127.0.0.1:3000";
const sessionSecret = env.SESSION_SECRET || "";
const dataDir = resolve(env.DATA_DIR || "./data");
const port = Number(env.PORT || 3000);
if (sessionSecret.length < 32)
  throw new Error("SESSION_SECRET must contain at least 32 characters");
if (!clientId || !clientSecret || !redirectUri)
  throw new Error("Spotify OAuth environment variables are required");
const baseOrigin = new URL(appBaseUrl).origin;
const secureCookie = new URL(appBaseUrl).protocol === "https:";
const key = createHash("sha256").update(sessionSecret).digest();
const idPattern = /^[A-Za-z0-9]{10,64}$/;
const uriPattern = /^spotify:track:[A-Za-z0-9]+$/;
const scopes = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-modify-playback-state",
  "streaming",
].join(" ");

interface Track {
  key: string;
  uri: string;
  name: string;
  artists: string;
  album: string;
  durationMs: number;
  imageUrl: string | null;
  spotifyUrl: string | null;
  position: number;
}
interface Rotation {
  items: Track[];
  order: string[];
  currentIndex: number;
  snapshotId: string;
  source: Playlist;
  archive: Playlist | null;
}
interface Playlist {
  id: string;
  name: string;
  owner: string;
  images?: { url: string }[];
  collaborative?: boolean;
  public?: boolean | null;
  snapshotId?: string;
}
interface Operation {
  id: string;
  at: number;
  sourceId: string;
  archiveId: string | null;
  uri: string;
  itemKey: string;
  snapshotId: string;
  status: "pending" | "archive_uncertain" | "archived" | "failed" | "complete";
  error?: string;
}
interface Session {
  id: string;
  csrf: string;
  user: { id: string; name: string };
  tokens: { access: string; refresh: string; expiresAt: number };
  settings?: { sourceId: string; archiveId: string | null };
  rotation?: Rotation;
  operations: Operation[];
}
interface Store {
  session?: Session;
}
let store: Store = {};
let busy = false;
let pendingAuth = new Map<string, { verifier: string; expires: number }>();
const file = join(dataDir, "session.enc");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function unseal(raw: string): Store {
  const buf = Buffer.from(raw, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(buf.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}
if (existsSync(file)) {
  try {
    store = unseal(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Could not decrypt session store; check SESSION_SECRET");
  }
}
function save() {
  const temp = file + ".tmp";
  writeFileSync(temp, seal(store), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
function sign(value: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}
function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sessionFrom(req: FastifyRequest): Session | null {
  const raw = req.cookies.rotation_session;
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig || !equal(sign(id), sig)) return null;
  return store.session?.id === id ? store.session : null;
}
class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public operationId?: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
function requireSession(req: FastifyRequest): Session {
  const s = sessionFrom(req);
  if (!s)
    throw new AppError("unauthenticated", "Connect Spotify to continue.", 401);
  return s;
}
function requireCsrf(req: FastifyRequest, s: Session) {
  const origin = req.headers.origin;
  if (origin && origin !== baseOrigin)
    throw new AppError("invalid_origin", "Request origin is not allowed.", 403);
  if (req.headers["x-csrf-token"] !== s.csrf)
    throw new AppError("csrf", "Refresh the page and try again.", 403);
}
function id(value: unknown) {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new AppError("invalid_id", "Choose a valid Spotify playlist.", 400);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_request", "Invalid request body.");
  return value as Record<string, unknown>;
}
async function spotify(
  s: Session,
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<any> {
  if (s.tokens.expiresAt < Date.now() + 60_000) await refresh(s);
  const send = () =>
    fetch("https://api.spotify.com/v1" + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${s.tokens.access}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(12000),
    });
  let response = await send();
  if (response.status === 401 && retry) {
    await refresh(s);
    response = await send();
  }
  if (response.status === 429) {
    const seconds = Math.min(
      120,
      Math.max(1, Number(response.headers.get("retry-after") || 1)),
    );
    throw new AppError(
      "rate_limited",
      `Spotify is busy. Retry in ${seconds} seconds.`,
      429,
      undefined,
      seconds,
    );
  }
  if (!response.ok) {
    const code =
      response.status === 403
        ? "spotify_forbidden"
        : response.status === 401
          ? "spotify_auth"
          : "spotify_error";
    throw new AppError(
      code,
      response.status === 403
        ? "Spotify does not allow this playlist or playback action."
        : `Spotify request failed (${response.status}).`,
      response.status >= 500 ? 502 : response.status,
    );
  }
  return response.status === 204 ? {} : response.json();
}
async function refresh(s: Session) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.tokens.refresh,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new AppError(
      "spotify_auth",
      "Spotify connection expired. Please sign in again.",
      401,
    );
  const t = (await response.json()) as any;
  s.tokens.access = t.access_token;
  s.tokens.refresh = t.refresh_token || s.tokens.refresh;
  s.tokens.expiresAt = Date.now() + t.expires_in * 1000;
  save();
}
async function allPlaylists(s: Session): Promise<Playlist[]> {
  const result: Playlist[] = [];
  for (let offset = 0; offset < 5000; offset += 50) {
    const p = await spotify(s, `/me/playlists?limit=50&offset=${offset}`);
    for (const x of p.items || [])
      if (x?.id && x?.name)
        result.push({
          id: x.id,
          name: x.name,
          owner: x.owner?.display_name || x.owner?.id || "Unknown",
          images: x.images || [],
          collaborative: x.collaborative,
          public: x.public,
        });
    if (!p.next) break;
  }
  return result;
}
async function selected(s: Session, pid: string) {
  const list = await allPlaylists(s);
  const p = list.find((x) => x.id === pid);
  if (!p)
    throw new AppError(
      "playlist_unavailable",
      "Playlist is not available to this account.",
      403,
    );
  return p;
}
async function loadItems(s: Session, pid: string) {
  const p = await spotify(s, `/playlists/${pid}`);
  const raw: any[] = [];
  for (let offset = 0; offset < 10000; offset += 50) {
    const page = await spotify(
      s,
      `/playlists/${pid}/items?limit=50&offset=${offset}`,
    );
    raw.push(...(page.items || []));
    if (!page.next) break;
  }
  const uriCounts = new Map<string, number>();
  for (const entry of raw) {
    const uri = entry?.item?.uri;
    if (typeof uri === "string")
      uriCounts.set(uri, (uriCounts.get(uri) || 0) + 1);
  }
  const items: Track[] = [];
  raw.forEach((entry, position) => {
    const x = entry?.item;
    if (
      entry?.is_local ||
      x?.type !== "track" ||
      typeof x.uri !== "string" ||
      !uriPattern.test(x.uri) ||
      x.is_playable === false ||
      x.restrictions
    )
      return;
    items.push({
      key: `${position}:${x.uri}`,
      uri: x.uri,
      name: x.name || "Untitled",
      artists:
        (x.artists || [])
          .map((a: any) => a.name)
          .filter(Boolean)
          .join(", ") || "Unknown artist",
      album: x.album?.name || "",
      durationMs: Number(x.duration_ms) || 0,
      imageUrl: x.album?.images?.[0]?.url || null,
      spotifyUrl: x.external_urls?.spotify || null,
      position,
    });
  });
  return { items, snapshotId: p.snapshot_id as string, uriCounts };
}
function shuffle(keys: string[]) {
  for (let i = keys.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE() % (i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}
function current(r: Rotation) {
  return r.items.find((x) => x.key === r.order[r.currentIndex]);
}
function rotation(s: Session) {
  if (!s.rotation)
    throw new AppError("no_rotation", "Start a listening session first.", 409);
  return s.rotation;
}
function advance(r: Rotation) {
  r.order.splice(r.currentIndex, 1);
  if (r.currentIndex >= r.order.length) r.currentIndex = r.order.length;
}
function prune(s: Session) {
  s.operations = s.operations
    .filter((x) => x.at > Date.now() - 30 * 86400000)
    .slice(-100);
}
async function liveUnique(s: Session, r: Rotation, item: Track) {
  const live = await loadItems(s, r.source.id);
  if (live.snapshotId !== r.snapshotId)
    throw new AppError(
      "playlist_changed",
      "The source playlist changed. Reload before removing this item.",
      409,
    );
  const copies = live.items.filter((x) => x.uri === item.uri);
  if (live.uriCounts.get(item.uri) !== 1)
    throw new AppError(
      "duplicate_conflict",
      "This track appears more than once in the source playlist. Spotify cannot select one copy safely for removal.",
      409,
    );
  if (!copies[0] || copies[0].position !== item.position)
    throw new AppError(
      "playlist_changed",
      "The source playlist changed. Reload before removing this item.",
      409,
    );
  return live;
}
async function removeCore(s: Session, op: Operation, r: Rotation, item: Track) {
  await liveUnique(s, r, item);
  const result = await spotify(s, `/playlists/${op.sourceId}/items`, {
    method: "DELETE",
    body: JSON.stringify({
      items: [{ uri: op.uri }],
      snapshot_id: op.snapshotId,
    }),
  });
  op.status = "complete";
  r.snapshotId = result.snapshot_id || r.snapshotId;
  r.items = r.items.filter((x) => x.key !== item.key);
  for (const remaining of r.items)
    if (remaining.position > item.position) remaining.position--;
  advance(r);
  prune(s);
  save();
  return r;
}
const app = Fastify({
  disableRequestLogging: true,
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-csrf-token",
      "res.headers.set-cookie",
    ],
    level: env.LOG_LEVEL || "info",
  },
  bodyLimit: 32_768,
});
await app.register(cookie);
app.addHook("onSend", async (_req, reply, payload) => {
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY")
    .header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://sdk.scdn.co; connect-src 'self' https://api.spotify.com https://*.spotify.com wss://*.spotify.com; img-src 'self' https://i.scdn.co https://mosaic.scdn.co data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src blob: https://*.scdn.co https://*.spotify.com; frame-src https://sdk.scdn.co https://*.spotify.com; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
  return payload;
});
app.setErrorHandler((error, _req, reply) => {
  const e =
    error instanceof AppError
      ? error
      : new AppError(
          "server_error",
          "Something went wrong. Please try again.",
          500,
        );
  if (!(error instanceof AppError)) app.log.error(error);
  if (e.retryAfter) reply.header("Retry-After", String(e.retryAfter));
  reply.code(e.status).send({
    error: {
      code: e.code,
      message: e.message,
      ...(e.operationId ? { operationId: e.operationId } : {}),
    },
  });
});
const mutationTimes: number[] = [];
app.addHook("onRequest", async (req) => {
  if (req.method === "GET" || req.method === "HEAD") return;
  const now = Date.now();
  while (mutationTimes.length && mutationTimes[0] < now - 60000)
    mutationTimes.shift();
  if (mutationTimes.length >= 120)
    throw new AppError(
      "rate_limited",
      "Too many actions. Please wait a minute.",
      429,
    );
  mutationTimes.push(now);
});
app.get("/health", async () => ({ ok: true }));
const loginAttempts: number[] = [];
app.get("/auth/start", async (_req, reply) => {
  const now = Date.now();
  while (loginAttempts[0] < now - 60000) loginAttempts.shift();
  if (loginAttempts.length >= 10)
    throw new AppError(
      "rate_limited",
      "Please wait before signing in again.",
      429,
    );
  loginAttempts.push(now);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pendingAuth.set(state, { verifier, expires: now + 10 * 60000 });
  reply.setCookie("rotation_oauth", state, {
    path: "/auth/callback",
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    maxAge: 600,
  });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  reply.redirect(`https://accounts.spotify.com/authorize?${query}`);
});
app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  "/auth/callback",
  async (req, reply) => {
    if (req.query.error)
      throw new AppError("spotify_auth", "Spotify sign-in was cancelled.", 400);
    const entry = pendingAuth.get(req.query.state || "");
    if (
      req.cookies.rotation_oauth !== req.query.state ||
      !entry ||
      entry.expires < Date.now() ||
      !req.query.code
    )
      throw new AppError(
        "oauth_state",
        "Sign-in expired. Please start again.",
        400,
      );
    pendingAuth.delete(req.query.state || "");
    reply.clearCookie("rotation_oauth", { path: "/auth/callback" });
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: redirectUri,
        code_verifier: entry.verifier,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new AppError(
        "spotify_auth",
        "Spotify sign-in failed. Please try again.",
        401,
      );
    const t = (await response.json()) as any;
    const s: Session = {
      id: randomBytes(32).toString("base64url"),
      csrf: randomBytes(32).toString("base64url"),
      user: { id: "", name: "" },
      tokens: {
        access: t.access_token,
        refresh: t.refresh_token,
        expiresAt: Date.now() + t.expires_in * 1000,
      },
      operations: [],
    };
    const me = await spotify(s, "/me");
    s.user = { id: me.id, name: me.display_name || me.id };
    store.session = s;
    save();
    reply.setCookie("rotation_session", `${s.id}.${sign(s.id)}`, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      maxAge: 30 * 86400,
    });
    reply.redirect("/");
  },
);
app.post("/auth/logout", async (req, reply) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  store = {};
  save();
  reply.clearCookie("rotation_session", { path: "/" });
  return { ok: true };
});
app.get("/api/session", async (req) => {
  const s = sessionFrom(req);
  return s
    ? {
        authenticated: true,
        account: s.user,
        settings: s.settings || null,
        csrfToken: s.csrf,
      }
    : { authenticated: false };
});
app.get("/api/playlists", async (req) => ({
  playlists: await allPlaylists(requireSession(req)),
}));
app.put("/api/settings", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "A playlist change is already in progress.",
      409,
    );
  const b = object(req.body);
  const sourceId = id(b.sourceId);
  const archiveId = b.archiveId === null ? null : id(b.archiveId);
  if (sourceId === archiveId)
    throw new AppError("same_playlist", "Source and archive must differ.");
  await selected(s, sourceId);
  if (archiveId) await selected(s, archiveId);
  s.settings = { sourceId, archiveId };
  s.rotation = undefined;
  save();
  return { settings: s.settings };
});
app.get("/api/rotation", async (req) => {
  const s = requireSession(req);
  return s.rotation || null;
});
app.post("/api/rotation/start", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "A playlist change is already in progress.",
      409,
    );
  if (!s.settings)
    throw new AppError(
      "setup_required",
      "Choose a source playlist first.",
      409,
    );
  const source = await selected(s, s.settings.sourceId);
  const archive = s.settings.archiveId
    ? await selected(s, s.settings.archiveId)
    : null;
  const loaded = await loadItems(s, source.id);
  const order = shuffle(loaded.items.map((x) => x.key));
  const oldRotation = s.rotation;
  if (
    oldRotation &&
    order.length > 1 &&
    order[0] === oldRotation.order[oldRotation.currentIndex]
  ) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  s.rotation = {
    items: loaded.items,
    order,
    currentIndex: 0,
    snapshotId: loaded.snapshotId,
    source,
    archive,
  };
  save();
  return s.rotation;
});
app.post("/api/rotation/navigate", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "A playlist change is already in progress.",
      409,
    );
  const b = object(req.body);
  const r = rotation(s);
  if (b.direction === "next")
    r.currentIndex = Math.min(r.currentIndex + 1, r.order.length);
  else if (b.direction === "previous")
    r.currentIndex = Math.max(0, r.currentIndex - 1);
  else throw new AppError("invalid_direction", "Choose previous or next.");
  save();
  return r;
});
app.post("/api/rotation/remove", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  const b = object(req.body);
  const r = rotation(s);
  const item = current(r);
  if (!item || b.itemKey !== item.key)
    throw new AppError(
      "item_changed",
      "The active item changed. Refresh the player.",
      409,
    );
  if (
    b.removeWithoutArchive !== undefined &&
    typeof b.removeWithoutArchive !== "boolean"
  )
    throw new AppError("invalid_request", "Invalid archive choice.");
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "A playlist change is already in progress.",
      409,
    );
  const prior = s.operations.find(
    (x) =>
      x.itemKey === item.key &&
      x.sourceId === r.source.id &&
      (x.status === "archived" || x.status === "archive_uncertain"),
  );
  if (prior && !b.removeWithoutArchive) {
    if (prior.status === "archived")
      throw new AppError(
        "partial_failure",
        "Added to history, but still in Rotation. Retry source removal.",
        409,
        prior.id,
      );
    throw new AppError(
      "archive_uncertain",
      "Spotify did not confirm whether history was updated. Check that playlist before trying again, or choose remove without archiving.",
      409,
      prior.id,
    );
  }
  busy = true;
  const op: Operation = {
    id: randomBytes(16).toString("hex"),
    at: Date.now(),
    sourceId: r.source.id,
    archiveId: b.removeWithoutArchive ? null : r.archive?.id || null,
    uri: item.uri,
    itemKey: item.key,
    snapshotId: r.snapshotId,
    status: "pending",
  };
  try {
    await liveUnique(s, r, item);
    s.operations.push(op);
    prune(s);
    save();
    if (op.archiveId) {
      op.status = "archive_uncertain";
      save();
      await spotify(s, `/playlists/${op.archiveId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: [item.uri] }),
      });
      op.status = "archived";
      save();
    }
    const result = await removeCore(s, op, r, item);
    return { rotation: result, operationId: op.id };
  } catch (e) {
    if (
      op.status === "pending" ||
      (op.status === "archive_uncertain" &&
        e instanceof AppError &&
        [400, 401, 403, 429].includes(e.status))
    )
      op.status = "failed";
    op.error = e instanceof AppError ? e.code : "server_error";
    save();
    if (op.status === "archive_uncertain")
      throw new AppError(
        "archive_uncertain",
        "Spotify did not confirm whether history was updated. Check that playlist before trying again, or choose remove without archiving.",
        409,
        op.id,
      );
    if (op.status === "archived")
      throw new AppError(
        "partial_failure",
        "Added to history, but still in Rotation. Retry source removal.",
        409,
        op.id,
      );
    throw e;
  } finally {
    busy = false;
  }
});
app.post("/api/rotation/retry", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  const b = object(req.body);
  const op = s.operations.find((x) => x.id === b.operationId);
  if (!op || op.status !== "archived")
    throw new AppError(
      "operation_unavailable",
      "No recoverable operation was found.",
      404,
    );
  const r = rotation(s);
  const item = current(r);
  if (!item || item.key !== op.itemKey || r.source.id !== op.sourceId)
    throw new AppError(
      "item_changed",
      "Reload the source playlist before retrying.",
      409,
    );
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "A playlist change is already in progress.",
      409,
    );
  busy = true;
  try {
    return { rotation: await removeCore(s, op, r, item), operationId: op.id };
  } finally {
    busy = false;
  }
});
app.get("/api/token", async (req) => {
  const s = requireSession(req);
  if (s.tokens.expiresAt < Date.now() + 60_000) await refresh(s);
  return { accessToken: s.tokens.access };
});
app.put("/api/playback", async (req) => {
  const s = requireSession(req);
  requireCsrf(req, s);
  const b = object(req.body);
  const r = rotation(s);
  const item = current(r);
  if (
    !item ||
    b.uri !== item.uri ||
    typeof b.deviceId !== "string" ||
    !idPattern.test(b.deviceId)
  )
    throw new AppError(
      "invalid_playback",
      "Choose the active track and a connected player.",
    );
  await spotify(
    s,
    `/me/player/play?device_id=${encodeURIComponent(b.deviceId)}`,
    { method: "PUT", body: JSON.stringify({ uris: [item.uri] }) },
  );
  return { ok: true };
});
const webDist = resolve(env.WEB_DIST_DIR || "../web/dist");
if (existsSync(webDist)) {
  await app.register(staticPlugin, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/auth/"))
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Route not found." } });
    return reply.sendFile("index.html");
  });
}
await app.listen({ host: "0.0.0.0", port });
export { app };
