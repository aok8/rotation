import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  baseOrigin,
  desktopControlToken,
  desktopBuildId,
  desktopMode,
  macLocalProbeAvailable,
  uriPattern,
} from "./config.js";
import { AppError, requireSession, requireCsrf, id, object } from "./errors.js";
import { sessionFrom, save } from "./store.js";
import { allPlaylists, selected, loadItems, spotify } from "./spotify.js";
import {
  deviceId,
  deviceParameter,
  devices,
  playbackDiagnostic,
  playbackState,
  requireCurrentPlayback,
  requireDevice,
  playWindow,
  playbackCommand,
} from "./playback.js";
import {
  current,
  rotation,
  shuffle,
  liveUnique,
  prune,
  removeCore,
} from "./rotation.js";
import type { Operation } from "./types.js";
import { probeMacRotationTrack } from "./mac-local.js";

let busy = false;
async function withPlaybackLock<T>(task: () => Promise<T>): Promise<T> {
  if (busy)
    throw new AppError(
      "operation_in_progress",
      "Wait for the current Spotify or playlist action to finish.",
      409,
    );
  busy = true;
  try {
    return await task();
  } finally {
    busy = false;
  }
}
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
          ...(desktopMode && desktopBuildId ? { desktopBuildId } : {}),
          ...(macLocalProbeAvailable ? { macLocalProbeAvailable: true } : {}),
        }
      : desktopMode
        ? {
            authenticated: false,
            desktop: true,
            csrfToken: desktopControlToken,
            ...(desktopBuildId ? { desktopBuildId } : {}),
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
    return withPlaybackLock(async () => {
      const b = object(req.body);
      const r = rotation(s);
      const startingIndex = r.currentIndex;
      let nextIndex: number;
      if (b.direction === "next")
        nextIndex = Math.min(r.currentIndex + 1, r.order.length);
      else if (b.direction === "previous")
        nextIndex = Math.max(0, r.currentIndex - 1);
      else throw new AppError("invalid_direction", "Choose previous or next.");
      if (b.deviceId !== undefined) {
        const selectedDevice = deviceId(b.deviceId);
        if (nextIndex < r.order.length) {
          await playWindow(s, r, nextIndex, selectedDevice);
        } else {
          await requireDevice(s, selectedDevice);
          const state = await playbackState(s);
          const previousItem = current(r);
          if (
            state.deviceId === selectedDevice &&
            state.uri === previousItem?.uri
          )
            await playbackCommand(
              s,
              `/me/player/pause${deviceParameter(selectedDevice)}`,
            );
          else if (state.uri || state.isPlaying)
            throw new AppError(
              "playback_mismatch",
              "Spotify is playing something else. Refresh playback.",
              409,
            );
        }
      }
      if (s.rotation !== r || r.currentIndex !== startingIndex)
        throw new AppError(
          "item_changed",
          "Rotation changed while navigating. Refresh playback.",
          409,
        );
      r.currentIndex = nextIndex;
      if (nextIndex >= r.order.length) r.queuedWindow = undefined;
      save();
      return r;
    });
  });
  app.post("/api/rotation/sync", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    return withPlaybackLock(async () => {
      const b = object(req.body);
      const r = rotation(s);
      const selectedDevice = deviceId(b.deviceId);
      const target = b.targetIndex;
      const suppliedEnd = b.queuedThroughIndex;
      const window = r.queuedWindow;
      if (
        !Number.isInteger(target) ||
        !Number.isInteger(suppliedEnd) ||
        typeof b.uri !== "string" ||
        !uriPattern.test(b.uri) ||
        !window ||
        window.deviceId !== selectedDevice ||
        window.endIndex !== suppliedEnd ||
        (target as number) <= r.currentIndex ||
        (target as number) < window.startIndex ||
        (target as number) > window.endIndex ||
        (target as number) >= r.order.length
      )
        throw new AppError(
          "sync_unavailable",
          "Playback moved outside the saved queue. Press Play to return.",
          409,
        );
      const byKey = new Map(r.items.map((item) => [item.key, item]));
      const expectedKey = r.order[target as number];
      const expectedUri = byKey.get(expectedKey)?.uri;
      const candidates = r.order
        .slice(r.currentIndex, window.endIndex + 1)
        .map((key) => byKey.get(key)?.uri);
      if (
        expectedUri !== b.uri ||
        candidates.some((uri) => !uri) ||
        candidates.filter((uri) => uri === b.uri).length !== 1
      )
        throw new AppError(
          "sync_ambiguous",
          "Spotify's track cannot be matched uniquely to the queue. Press Play to return.",
          409,
        );
      const startingIndex = r.currentIndex;
      await requireDevice(s, selectedDevice);
      await requireCurrentPlayback(s, selectedDevice, b.uri);
      if (
        s.rotation !== r ||
        r.currentIndex !== startingIndex ||
        r.order[target as number] !== expectedKey ||
        r.queuedWindow !== window
      )
        throw new AppError(
          "item_changed",
          "Rotation changed while syncing. Refresh playback.",
          409,
        );
      r.currentIndex = target as number;
      save();
      return r;
    });
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
      result.queuedWindow = undefined;
      save();
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
      const result = await removeCore(s, op, r, item);
      result.queuedWindow = undefined;
      save();
      return { rotation: result, operationId: op.id };
    } finally {
      busy = false;
    }
  });
  app.get("/api/playback/devices", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return devices(requireSession(req));
  });
  app.get("/api/playback/state", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return playbackState(requireSession(req));
  });
  app.get("/api/playback/diagnostic", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return playbackDiagnostic(requireSession(req));
  });
  app.post("/api/playback/mac-probe", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    if (!macLocalProbeAvailable)
      throw new AppError(
        "mac_local_unavailable",
        "This playback test is available only in the packaged Mac app.",
        404,
      );
    if (busy)
      throw new AppError(
        "operation_in_progress",
        "A playlist change is already in progress.",
        409,
      );
    const b = object(req.body);
    const r = rotation(s);
    const item = current(r);
    if (!item || b.itemKey !== item.key)
      throw new AppError(
        "item_changed",
        "The selected song changed. Refresh the player.",
        409,
      );
    busy = true;
    try {
      return await probeMacRotationTrack(r, item.uri);
    } finally {
      busy = false;
    }
  });
  app.put("/api/playback/seek", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    return withPlaybackLock(async () => {
      const b = object(req.body);
      const selectedDevice = deviceId(b.deviceId);
      const r = rotation(s);
      const item = current(r);
      if (
        !item ||
        !Number.isInteger(b.positionMs) ||
        (b.positionMs as number) < 0 ||
        (b.positionMs as number) >= item.durationMs
      )
        throw new AppError(
          "invalid_playback",
          "Choose a position within the active track.",
        );
      await requireDevice(s, selectedDevice);
      await requireCurrentPlayback(s, selectedDevice, item.uri);
      await playbackCommand(
        s,
        `/me/player/seek?position_ms=${b.positionMs}${deviceParameter(selectedDevice, "&")}`,
      );
      return { ok: true };
    });
  });
  app.put("/api/playback/control", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    return withPlaybackLock(async () => {
      const b = object(req.body);
      const selectedDevice = deviceId(b.deviceId);
      if (b.action !== "pause" && b.action !== "resume")
        throw new AppError(
          "invalid_playback",
          "Choose pause or resume for a connected player.",
        );
      const r = rotation(s);
      const item = current(r);
      let expectedUri = item?.uri;
      if (b.uri !== undefined) {
        if (
          b.action !== "pause" ||
          typeof b.uri !== "string" ||
          !uriPattern.test(b.uri)
        )
          throw new AppError("invalid_playback", "Choose a Rotation track.");
        const recentRemoval = s.operations.some(
          (op) =>
            op.status === "complete" &&
            op.sourceId === r.source.id &&
            op.uri === b.uri &&
            op.at > Date.now() - 10 * 60_000,
        );
        if (!recentRemoval)
          throw new AppError(
            "playback_mismatch",
            "This track was not just removed from Rotation.",
            409,
          );
        expectedUri = b.uri;
      }
      if (!expectedUri)
        throw new AppError("item_changed", "Choose a Rotation track.", 409);
      await requireDevice(s, selectedDevice);
      await requireCurrentPlayback(s, selectedDevice, expectedUri);
      const command = b.action === "pause" ? "pause" : "play";
      await playbackCommand(
        s,
        `/me/player/${command}${deviceParameter(selectedDevice)}`,
      );
      return { ok: true };
    });
  });
  app.put("/api/playback", async (req) => {
    const s = requireSession(req);
    requireCsrf(req, s);
    return withPlaybackLock(async () => {
      const b = object(req.body);
      const r = rotation(s);
      const item = current(r);
      const selectedDevice = deviceId(b.deviceId);
      if (!item || b.uri !== item.uri)
        throw new AppError(
          "invalid_playback",
          "Choose the active track and a connected player.",
        );
      if (
        b.positionMs !== undefined &&
        (!Number.isInteger(b.positionMs) ||
          (b.positionMs as number) < 0 ||
          (b.positionMs as number) >= item.durationMs)
      )
        throw new AppError(
          "invalid_playback",
          "Choose a position within the active track.",
        );
      return playWindow(
        s,
        r,
        r.currentIndex,
        selectedDevice,
        b.positionMs as number | undefined,
      );
    });
  });
}
