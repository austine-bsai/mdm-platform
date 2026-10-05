import { Hono } from "hono";
import { db, run } from "../lib/db.ts";
import { isUuid, readJson, uuidParam } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import { cancelEvent, retryEvent } from "../services/events.ts";
import { type Resource, syncEnterprise } from "../services/sync.ts";
import { eventResponse, intQuery, publicEvent } from "./helpers.ts";

const EVENT_COLUMNS =
  "id, category, action, state, error_code, error_message, attempts, max_attempts, params, response, action_time, sent_at, completed_at, next_attempt_at, device_id, group_id, profile_id, announcement_id, admins(email), devices(device_name), groups(name), profiles(name)";
const STATES = ["awaiting_confirmation", "requested", "sent", "acknowledged", "succeeded", "failed", "dead", "cancelled"];
const CATEGORIES = ["command", "group", "profile", "announcement", "sync", "auth", "zoho"];

export function eventRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  // Logs & history with filters + keyset pagination (?before=<iso time>)
  r.get("/", async (c) => {
    const s = c.get("session");
    let q = db().from("events").select(EVENT_COLUMNS).eq("enterprise_id", s.enterpriseId)
      .order("action_time", { ascending: false }).limit(intQuery(c.req.query("limit"), 100, 500));
    const state = c.req.query("state");
    const category = c.req.query("category");
    const deviceId = c.req.query("device_id");
    const before = c.req.query("before");
    if (state && STATES.includes(state)) q = q.eq("state", state);
    if (category && CATEGORIES.includes(category)) q = q.eq("category", category);
    if (deviceId && isUuid(deviceId)) q = q.eq("device_id", deviceId);
    if (before && !Number.isNaN(Date.parse(before))) q = q.lt("action_time", new Date(before).toISOString());
    return c.json({ data: await run(q) });
  });

  // Failure backlog: retries exhausted
  r.get("/backlog", async (c) => {
    const s = c.get("session");
    const data = await run(
      db().from("events").select(EVENT_COLUMNS).eq("enterprise_id", s.enterpriseId).in("state", ["dead", "failed"])
        .order("action_time", { ascending: false }).limit(200),
    );
    return c.json({ data });
  });

  r.get("/:id", async (c) => {
    const s = c.get("session");
    const data = await run(
      db().from("events").select(EVENT_COLUMNS).eq("enterprise_id", s.enterpriseId).eq("id", uuidParam(c.req.param("id"))).single(),
    );
    return c.json({ data });
  });

  r.post("/:id/retry", requireRole("admin"), async (c) => {
    const ev = await retryEvent(c.get("session").enterpriseId, uuidParam(c.req.param("id")));
    return eventResponse(c, ev);
  });

  r.post("/:id/cancel", requireRole("admin"), async (c) => {
    const ev = await cancelEvent(c.get("session").enterpriseId, uuidParam(c.req.param("id")));
    return c.json({ data: publicEvent(ev) });
  });

  return r;
}

export function overviewRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/overview", async (c) => {
    const eid = c.get("session").enterpriseId;
    return c.json({ data: await run(db().rpc("enterprise_overview", { p_enterprise: eid })) });
  });

  r.get("/sync-runs", async (c) => {
    const data = await run(
      db().from("sync_runs").select("*").eq("enterprise_id", c.get("session").enterpriseId)
        .order("started_at", { ascending: false }).limit(50),
    );
    return c.json({ data });
  });

  r.post("/sync", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw).catch(() => ({} as Record<string, unknown>));
    // device_details is opt-in (per-device Zoho fan-out) — admin requests it explicitly.
    const allowed: Resource[] = [
      "users", "devices", "groups", "profiles",
      "apps", "announcements", "compliance", "device_details",
    ];
    const resources = Array.isArray(b.resources) ? (b.resources as string[]).filter((x): x is Resource => allowed.includes(x as Resource)) : allowed;
    const s = c.get("session");
    return c.json({ data: await syncEnterprise(s.enterpriseId, resources.length ? resources : allowed, s.adminId) });
  });

  return r;
}
