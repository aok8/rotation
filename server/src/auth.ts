import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import {
  clientId,
  clientSecret,
  redirectUri,
  scopes,
  secureCookie,
} from "./config.js";
import { AppError, requireSession, requireCsrf } from "./errors.js";
import { spotify } from "./spotify.js";
import { store, save, sign } from "./store.js";
import type { Session } from "./types.js";

const pendingAuth = new Map<string, { verifier: string; expires: number }>();
const loginAttempts: number[] = [];

export function registerAuthRoutes(app: FastifyInstance) {
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
        throw new AppError(
          "spotify_auth",
          "Spotify sign-in was cancelled.",
          400,
        );
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
    delete store.session;
    save();
    reply.clearCookie("rotation_session", { path: "/" });
    return { ok: true };
  });
}
