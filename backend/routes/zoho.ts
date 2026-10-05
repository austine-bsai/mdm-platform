import { Hono } from "hono";
import { getConfig } from "../config.ts";
import { toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { readJson, str } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import {
  connectionStatus,
  connectSelfClient,
  disconnect,
  finishOAuth,
  startOAuth,
  testConnection,
} from "../services/zoho-connect.ts";

export function zohoRoutes() {
  const r = new Hono<AppEnv>();

  // Public: Zoho redirects the browser here (cross-site, so no session cookie — the state row identifies the enterprise).
  r.get("/callback", async (c) => {
    const appUrl = getConfig().appUrl;
    try {
      await finishOAuth({
        code: c.req.query("code") ?? null,
        state: c.req.query("state") ?? null,
        accountsServer: c.req.query("accounts-server") ?? null,
        error: c.req.query("error") ?? null,
      });
      return c.redirect(`${appUrl}/#/settings?zoho=connected`);
    } catch (e) {
      const err = toAppError(e);
      log("warn", "zoho.callback_failed", { code: err.code });
      return c.redirect(`${appUrl}/#/settings?zoho=error&code=${encodeURIComponent(err.code)}`);
    }
  });

  r.use("*", requireSession);
  r.get("/status", async (c) => c.json({ data: await connectionStatus(c.get("session").enterpriseId) }));
  r.post("/connect", requireRole("owner"), async (c) => c.json({ data: await startOAuth(c.get("session")) }));
  r.post("/self-client", requireRole("owner"), async (c) => {
    const b = await readJson(c.req.raw);
    await connectSelfClient(c.get("session"), {
      clientId: str(b, "clientId", { max: 200 }),
      clientSecret: str(b, "clientSecret", { max: 200 }),
      code: str(b, "code", { max: 300 }),
      accountsServer: str(b, "accountsServer", { required: false, max: 100 }) || "https://accounts.zoho.com",
    });
    return c.json({ data: await connectionStatus(c.get("session").enterpriseId) });
  });
  r.post("/test", requireRole("admin"), async (c) => c.json({ data: await testConnection(c.get("session").enterpriseId) }));
  r.post("/disconnect", requireRole("owner"), async (c) => {
    await disconnect(c.get("session"));
    return c.json({ data: { ok: true } });
  });
  return r;
}
