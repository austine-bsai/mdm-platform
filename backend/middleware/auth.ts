// Session cookie auth, role checks, CSRF guard and a small in-memory rate limiter.
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { fail } from "../lib/errors.ts";
import { getSession, type Role, type Session } from "../services/auth.ts";
import { roleAtLeast } from "../services/commands.ts";

export const SESSION_COOKIE = "mdm_session";
export const CSRF_HEADER = "x-mdm-request"; // custom header: browsers can't send it cross-site without CORS

export type AppEnv = { Variables: { session: Session; requestId: string } };

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await getSession(token) : null;
  if (!session) fail("AUTH_REQUIRED");
  c.set("session", session);
  await next();
};

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roleAtLeast(c.get("session").role, min)) fail("AUTH_FORBIDDEN", `Needs the ${min} role`);
    await next();
  };
}

/** Every state-changing /api request must carry the custom header (CSRF defence in depth with SameSite=Strict). */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
    fail("AUTH_FORBIDDEN", "Missing request header");
  }
  await next();
};

export function clientIp(c: Context): string | null {
  const raw = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? c.req.header("x-real-ip");
  const ip = raw?.trim();
  if (!ip) return null;
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(opts: { windowMs: number; max: number; name: string }): MiddlewareHandler {
  return async (c, next) => {
    const key = `${opts.name}:${clientIp(c) ?? "unknown"}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    else if (++b.count > opts.max) fail("RATE_LIMITED");
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    await next();
  };
}

/** Idempotency-Key header (optional). Clients send one per user action so retries never repeat it. */
export function idempotencyKey(c: Context): string | null {
  const k = c.req.header("idempotency-key");
  if (!k) return null;
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(k)) fail("VALIDATION_FAILED", "Invalid Idempotency-Key header");
  return k;
}
