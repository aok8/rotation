export interface Track {
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
export interface Rotation {
  items: Track[];
  order: string[];
  currentIndex: number;
  snapshotId: string;
  source: Playlist;
  archive: Playlist | null;
}
export interface Playlist {
  id: string;
  name: string;
  owner: string;
  images?: { url: string }[];
  collaborative?: boolean;
  public?: boolean | null;
  snapshotId?: string;
}
export interface Operation {
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
export interface Session {
  id: string;
  csrf: string;
  user: { id: string; name: string };
  tokens: { access: string; refresh: string; expiresAt: number };
  settings?: { sourceId: string; archiveId: string | null };
  rotation?: Rotation;
  operations: Operation[];
}
export interface Store {
  session?: Session;
}
