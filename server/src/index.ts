import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, port } from "./config.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./auth.js";
import { registerApiRoutes } from "./routes.js";

const app = Fastify({
  logController: new LogController({ disableRequestLogging: true }),
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
registerAuthRoutes(app);
registerApiRoutes(app);
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
