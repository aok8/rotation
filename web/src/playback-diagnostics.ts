import type { PlaybackLogs } from "./api";

export function safePlaybackDiagnostics(logs: PlaybackLogs) {
  return {
    buildId: logs.buildId,
    cooldownUntil: logs.cooldownUntil,
    entries: logs.entries.map((entry) => ({
      id: entry.id,
      at: entry.at,
      method: entry.method,
      endpoint: entry.endpoint.split("?", 1)[0],
      status: entry.status,
      elapsedMs: entry.elapsedMs,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.retryAfter ? { retryAfter: entry.retryAfter } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
    })),
  };
}
