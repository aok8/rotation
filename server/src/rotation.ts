import { randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import { loadItems, spotify } from "./spotify.js";
import { save } from "./store.js";
import type { Rotation, Session, Operation, Track } from "./types.js";

export function shuffle(keys: string[]) {
  for (let i = keys.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE() % (i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}
export function current(r: Rotation) {
  return r.items.find((x) => x.key === r.order[r.currentIndex]);
}
export function rotation(s: Session) {
  if (!s.rotation)
    throw new AppError("no_rotation", "Start a listening session first.", 409);
  return s.rotation;
}
function advance(r: Rotation) {
  r.order.splice(r.currentIndex, 1);
  if (r.currentIndex >= r.order.length) r.currentIndex = r.order.length;
}
export function prune(s: Session) {
  s.operations = s.operations
    .filter((x) => x.at > Date.now() - 30 * 86400000)
    .slice(-100);
}
export async function liveUnique(s: Session, r: Rotation, item: Track) {
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
export async function removeCore(
  s: Session,
  op: Operation,
  r: Rotation,
  item: Track,
) {
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
