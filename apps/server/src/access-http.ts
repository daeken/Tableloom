import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccessError, AccessStore } from "./access.js";
import type { SessionGrant } from "./access.js";

const COOKIE = "tableloom_session";
export function sessionToken(cookie: string | undefined): string {
  const matches = (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  // Fail closed when a browser sends ambiguous duplicate cookies.
  return matches.length === 1 ? matches[0]!.slice(COOKIE.length + 1) : "";
}

export function expectedOrigin(
  request: FastifyRequest,
  configured?: string,
): string {
  return (
    configured ??
    new URL(`${request.protocol}://${request.headers.host}`).origin
  );
}
export function sameOrigin(
  request: FastifyRequest,
  configured?: string,
): boolean {
  try {
    const origin = request.headers.origin;
    return Boolean(
      origin &&
      new URL(origin).origin === origin &&
      origin === expectedOrigin(request, configured),
    );
  } catch {
    return false;
  }
}

export function registerAccessRoutes(
  app: FastifyInstance,
  access: AccessStore,
  options: {
    publicOrigin?: string;
    secureCookies: boolean;
    now: () => number;
    disconnect: (token: string) => void;
  },
) {
  const attempts = new Map<string, { started: number; count: number }>();
  const guarded = new Set([
    "/api/access/setup",
    "/api/access/recover",
    "/api/access/join",
  ]);
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url?.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !sameOrigin(request, options.publicOrigin)
    ) {
      return reply
        .code(403)
        .send({ error: "Open this action from your Tableloom server." });
    }
    if (
      request.method === "POST" &&
      guarded.has(request.routeOptions.url ?? "")
    ) {
      const now = options.now();
      for (const [ip, bucket] of attempts)
        if (now - bucket.started >= 300000) attempts.delete(ip);
      if (!attempts.has(request.ip) && attempts.size >= 1024)
        return reply
          .code(429)
          .send({ error: "Please try again in a few minutes." });
      const bucket = attempts.get(request.ip) ?? { started: now, count: 0 };
      attempts.set(request.ip, bucket);
      if (++bucket.count > 20)
        return reply.code(429).header("Retry-After", "300").send({
          error:
            "Too many sign-in attempts. Please try again in a few minutes.",
        });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) {
      const status =
        error.code === "host_required" || error.code === "host_removal"
          ? 403
          : error.code === "sign_in_required" || error.code === "invalid_key"
            ? 401
            : error.code === "setup_complete"
              ? 409
              : 400;
      return reply.code(status).send({ error: error.message });
    }
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Check the name, key, or invitation code and try again.",
      });
    const parsed = z
      .object({ statusCode: z.number().int().min(400).max(599) })
      .safeParse(error);
    const status = parsed.success ? parsed.data.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "Request failed");
    return reply.code(status).send({
      error:
        status >= 500
          ? "The server could not complete this request."
          : "The request is invalid.",
    });
  });

  const status = (request: FastifyRequest) => ({
    setupRequired: access.setupRequired,
    member: access.authenticate(sessionToken(request.headers.cookie)),
  });
  const setSession = (grant: SessionGrant) =>
    `${COOKIE}=${grant.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((grant.expiresAt - options.now()) / 1000))}${options.secureCookies ? "; Secure" : ""}`;
  const name = z.string().trim().min(1).max(32);
  const key = z.string().min(32).max(512);

  app.get("/api/access", async (request) => status(request));
  app.post("/api/access/setup", async (request, reply) => {
    const body = z.object({ name, key }).parse(request.body);
    const grant = access.setupHost(body.key, body.name);
    reply.header("Set-Cookie", setSession(grant));
    return { setupRequired: false, member: grant.member };
  });
  app.post("/api/access/recover", async (request, reply) => {
    const body = z.object({ key }).parse(request.body);
    const grant = access.recoverHost(body.key);
    reply.header("Set-Cookie", setSession(grant));
    return { setupRequired: false, member: grant.member };
  });
  app.post("/api/access/join", async (request, reply) => {
    const body = z
      .object({ name, code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(request.body);
    const grant = access.redeemInvitation(body.code, body.name);
    reply.header("Set-Cookie", setSession(grant));
    return { setupRequired: false, member: grant.member };
  });
  app.post("/api/access/logout", async (request, reply) => {
    const token = sessionToken(request.headers.cookie);
    access.revokeSession(token);
    options.disconnect(token);
    reply.header(
      "Set-Cookie",
      `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${options.secureCookies ? "; Secure" : ""}`,
    );
    return { setupRequired: access.setupRequired, member: null };
  });
  app.post("/api/access/invitations", async (request) =>
    access.createInvitation(sessionToken(request.headers.cookie)),
  );
}
