import type { FastifyRequest } from "fastify";
import { baseOrigin, idPattern } from "./config.js";
import { sessionFrom } from "./store.js";
import type { Session } from "./types.js";

export class AppError extends Error {
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
export function requireSession(req: FastifyRequest): Session {
  const s = sessionFrom(req);
  if (!s)
    throw new AppError("unauthenticated", "Connect Spotify to continue.", 401);
  return s;
}
export function requireCsrf(req: FastifyRequest, s: Session) {
  const origin = req.headers.origin;
  if (origin && origin !== baseOrigin)
    throw new AppError("invalid_origin", "Request origin is not allowed.", 403);
  if (req.headers["x-csrf-token"] !== s.csrf)
    throw new AppError("csrf", "Refresh the page and try again.", 403);
}
export function id(value: unknown) {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new AppError("invalid_id", "Choose a valid Spotify playlist.", 400);
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_request", "Invalid request body.");
  return value as Record<string, unknown>;
}
