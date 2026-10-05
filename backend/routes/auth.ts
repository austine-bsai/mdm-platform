import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { getConfig } from "../config.ts";
import { email, oneOf, readJson, str } from "../lib/validate.ts";
import { type AppEnv, clientIp, rateLimit, requireRole, requireSession, SESSION_COOKIE } from "../middleware/auth.ts";
import { hasPasswordSet, inviteAdmin, listAdmins, loginWithPassword, logout, registerEnterprise, requestLoginOtp, resetPasswordWithOtp, setOwnPassword, verifyOtp } from "../services/auth.ts";

export function authRoutes() {
  const r = new Hono<AppEnv>();
  const strict = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 20 });

  r.post("/register", strict, async (c) => {
    const b = await readJson(c.req.raw);
    const password = str(b, "password", { required: false, max: 200 });
    const { hasPassword } = await registerEnterprise({
      enterpriseName: str(b, "enterpriseName", { max: 120 }),
      fullName: str(b, "fullName", { max: 120 }),
      email: email(b),
      ip: clientIp(c),
      password: password || null,
    });
    const message = hasPassword
      ? "Enterprise created. You can sign in with your password."
      : "Enterprise created. Check your email for the sign-in code.";
    return c.json({ data: { message, hasPassword } }, 201);
  });

  r.post("/otp", strict, async (c) => {
    const b = await readJson(c.req.raw);
    await requestLoginOtp(email(b), clientIp(c));
    return c.json({ data: { message: "If the email is registered, a code is on its way." } });
  });

  r.post("/verify", strict, async (c) => {
    const b = await readJson(c.req.raw);
    const code = str(b, "code", { max: 6, min: 6 });
    const { token, expiresAt } = await verifyOtp({ email: email(b), code, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: getConfig().cookieSecure,
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });
    return c.json({ data: { ok: true } });
  });

  r.post("/password-login", strict, async (c) => {
    const b = await readJson(c.req.raw);
    const { token, expiresAt } = await loginWithPassword({
      email: email(b),
      password: str(b, "password", { max: 200 }),
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: getConfig().cookieSecure,
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });
    return c.json({ data: { ok: true } });
  });

  r.post("/has-password", strict, async (c) => {
    const b = await readJson(c.req.raw);
    return c.json({ data: { hasPassword: await hasPasswordSet(email(b)) } });
  });

  r.post("/reset-password", strict, async (c) => {
    const b = await readJson(c.req.raw);
    const { token, expiresAt } = await resetPasswordWithOtp({
      email: email(b),
      code: str(b, "code", { max: 6, min: 6 }),
      newPassword: str(b, "newPassword", { max: 200 }),
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: getConfig().cookieSecure,
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });
    return c.json({ data: { ok: true } });
  });

  r.post("/password", requireSession, async (c) => {
    const b = await readJson(c.req.raw);
    const s = c.get("session");
    await setOwnPassword(
      s.adminId,
      s.enterpriseId,
      str(b, "newPassword", { max: 200 }),
      str(b, "currentPassword", { required: false, max: 200 }) || null,
    );
    return c.json({ data: { ok: true } });
  });

  r.post("/logout", requireSession, async (c) => {
    await logout(c.get("session").sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ data: { ok: true } });
  });

  r.get("/me", requireSession, (c) => {
    const { sessionId: _s, ...me } = c.get("session");
    return c.json({ data: me });
  });

  return r;
}

export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);
  r.get("/", requireRole("admin"), async (c) => c.json({ data: await listAdmins(c.get("session").enterpriseId) }));
  r.post("/", requireRole("owner"), async (c) => {
    const b = await readJson(c.req.raw);
    const admin = await inviteAdmin(
      c.get("session"),
      email(b),
      str(b, "fullName", { max: 120 }),
      oneOf(b, "role", ["admin", "viewer"] as const, "admin"),
    );
    return c.json({ data: { id: admin.id, email: admin.email, role: admin.role } }, 201);
  });
  return r;
}
