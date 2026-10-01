import type { FastifyRequest } from "fastify";
import {
  randomBytes,
  createHmac,
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
import { join } from "node:path";
import { dataDir, key } from "./config.js";
import type { Store, Session } from "./types.js";

export const store: Store = {};
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
    Object.assign(store, unseal(readFileSync(file, "utf8")));
  } catch {
    throw new Error("Could not decrypt session store; check SESSION_SECRET");
  }
}
export function save() {
  const temp = file + ".tmp";
  writeFileSync(temp, seal(store), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
export function sign(value: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}
function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function sessionFrom(req: FastifyRequest): Session | null {
  const raw = req.cookies.rotation_session;
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig || !equal(sign(id), sig)) return null;
  return store.session?.id === id ? store.session : null;
}
