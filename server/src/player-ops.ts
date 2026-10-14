import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { desktopBuildId } from "./config.js";
import { AppError } from "./errors.js";
import type { Session } from "./types.js";

export type PlayerLogEntry = {
  id: string;
  at: number;
  method: string;
  endpoint: string;
  status: number | null;
  elapsedMs: number;
  errorCode?: string;
  reason?: string;
  retryAfter?: number;
  outcome?: "accepted" | "confirmed";
};
type Context = { id: string; signal: AbortSignal };
const context = new AsyncLocalStorage<Context>();
const entries = new Map<string, PlayerLogEntry[]>();
const cooldowns = new Map<string, number>();

export function currentPlayerOperation() { return context.getStore(); }
export function recordPlayerCall(s: Session, entry: PlayerLogEntry) {
  const list = entries.get(s.id) || [];
  list.push(entry);
  if (list.length > 50) list.splice(0, list.length - 50);
  entries.set(s.id, list);
}
export function recordPlayerConfirmation(s: Session) {
  const op = currentPlayerOperation();
  if (!op) return;
  const list = entries.get(s.id);
  const actualRead = list?.findLast((entry) => entry.id === op.id &&
    entry.method === "GET" && entry.endpoint === "/me/player" && entry.status === 200);
  if (actualRead) actualRead.outcome = "confirmed";
}
export function playerLogs(s: Session) {
  const until = cooldowns.get(s.id) || 0;
  return {
    buildId: desktopBuildId,
    cooldownUntil: until > Date.now() ? until : null,
    entries: [...(entries.get(s.id) || [])],
  };
}
export function setPlayerCooldown(s: Session, seconds: number) {
  cooldowns.set(s.id, Math.max(cooldowns.get(s.id) || 0, Date.now() + seconds * 1000));
}
export function assertPlayerReady(s: Session) {
  const until = cooldowns.get(s.id) || 0;
  if (until > Date.now()) {
    const seconds = Math.ceil((until - Date.now()) / 1000);
    throw new AppError("playback_cooldown", `Wait ${seconds} seconds before another Spotify playback request.`, 429, undefined, seconds);
  }
}
export function resetPlayerSession(s: Session) {
  entries.delete(s.id);
  cooldowns.delete(s.id);
}
export async function runPlayerOperation<T>(s: Session, task: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  assertPlayerReady(s);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await context.run({ id: randomBytes(8).toString("hex"), signal: controller.signal }, task);
  } catch (error) {
    if (controller.signal.aborted) {
      setPlayerCooldown(s, 10);
      throw new AppError("playback_timeout", "Spotify did not finish the command in 10 seconds. Wait before trying again.", 504, undefined, 10);
    }
    if (error instanceof AppError) {
      if (error.code === "rate_limited") setPlayerCooldown(s, error.retryAfter || 1);
      else if (error.status >= 500) setPlayerCooldown(s, 10);
    } else {
      setPlayerCooldown(s, 10);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
