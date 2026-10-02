import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  baseOrigin,
  desktopControlToken,
  desktopMode,
  idPattern,
} from "./config.js";
import { AppError, requireSession, requireCsrf, id, object } from "./errors.js";
import { sessionFrom, save } from "./store.js";
import {
  allPlaylists,
  selected,
  loadItems,
  spotify,
  refresh,
} from "./spotify.js";
import {
  current,
  rotation,
  shuffle,
  liveUnique,
  prune,
  removeCore,
} from "./rotation.js";
import type { Operation } from "./types.js";

let busy = false;
export function registerApiRoutes(app: FastifyInstance) {
  app.get("/api/session", async (req) => {
    const s = sessionFrom(req);
    return s
      ? {
          authenticated: true,
          account: s.user,
          settings: s.settings || null,
          csrfToken: s.csrf,
          ...(desktopMode ? { desktop: true } : {}),
        }
      : desktopMode
        ? {
            authenticated: false,
            desktop: true,
            csrfToken: desktopControlToken,
          }
        : { authenticated: false };
  });
  if (desktopMode) {
    app.post("/api/desktop/quit", async (req) => {
      const s = sessionFrom(req);
      if (
        req.headers.origin !== baseOrigin ||
        req.headers["x-csrf-token"] !== (s?.csrf || desktopControlToken)
      )
        throw new AppError("csrf", "Refresh the page and try again.", 403);
      process.send?.({ type: "quit" });
      return { ok: true };
    });
  }
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
  app.put("/api/playback/control", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    const b = object(req.body);
    if (
      typeof b.deviceId !== "string" ||
      !idPattern.test(b.deviceId) ||
      (b.action !== "pause" && b.action !== "resume")
    )
      throw new AppError(
        "invalid_playback",
        "Choose pause or resume for a connected player.",
      );
    const command = b.action === "pause" ? "pause" : "play";
    await spotify(
      s,
      `/me/player/${command}?device_id=${encodeURIComponent(b.deviceId)}`,
      { method: "PUT" },
    );
    return { ok: true };
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
}
