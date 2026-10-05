import { Hono } from "hono";
import { fail } from "../lib/errors.ts";
import { isUuid, readJson, str, uuidParam } from "../lib/validate.ts";
import { type AppEnv, requireRole, requireSession } from "../middleware/auth.ts";
import {
  acknowledgeAlert,
  checkAdminActivity,
  getRules,
  getSettings,
  listAlerts,
  resolveAlertManually,
  type Severity,
  updateRule,
  updateSettings,
} from "../services/monitoring.ts";
import { scanEnterprise } from "../services/security-scan.ts";
import {
  createGeofence,
  deleteGeofence,
  deviceHistory,
  latestLocations,
  listGeofences,
  pollEnterpriseLocations,
  setGeofenceEnabled,
} from "../services/locations.ts";
import { listCompliancePolicies } from "../zoho/api.ts";
import { intQuery } from "./helpers.ts";

export function monitoringRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/settings", async (c) => c.json({ data: await getSettings(c.get("session").enterpriseId) }));
  r.put("/settings", requireRole("owner"), async (c) => c.json({ data: await updateSettings(c.get("session"), await readJson(c.req.raw)) }));

  r.get("/rules", async (c) => c.json({ data: await getRules(c.get("session").enterpriseId) }));
  r.put("/rules/:key", requireRole("owner"), async (c) => {
    const b = await readJson(c.req.raw);
    const severity = b.severity as Severity | undefined;
    if (severity !== undefined && !["info", "warning", "critical"].includes(severity)) fail("VALIDATION_FAILED", "Invalid severity");
    const autoAction = b.autoAction === undefined ? undefined : (b.autoAction === null || b.autoAction === "" ? null : String(b.autoAction));
    return c.json({
      data: await updateRule(c.get("session"), c.req.param("key"), {
        enabled: b.enabled === undefined ? undefined : Boolean(b.enabled),
        severity,
        autoAction: autoAction as "lock" | "enable_lost_mode" | "remote_alarm" | null | undefined,
      }),
    });
  });

  // Run detectors now instead of waiting for the worker.
  r.post("/scan", requireRole("admin"), async (c) => {
    const eid = c.get("session").enterpriseId;
    const security = await scanEnterprise(eid);
    const locations = await pollEnterpriseLocations(eid, { force: true });
    await checkAdminActivity(eid);
    return c.json({ data: { security, locations } });
  });

  // Fence policies configured directly in Zoho (read-only view).
  r.get("/zoho-compliance", requireRole("admin"), async (c) => c.json({ data: await listCompliancePolicies(c.get("session").enterpriseId) }));
  return r;
}

export function alertRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);
  r.get("/", async (c) => {
    const deviceId = c.req.query("device_id");
    return c.json({
      data: await listAlerts(c.get("session").enterpriseId, {
        status: c.req.query("status") ?? "active",
        severity: c.req.query("severity"),
        deviceId: deviceId && isUuid(deviceId) ? deviceId : undefined,
        limit: intQuery(c.req.query("limit"), 200, 500),
      }),
    });
  });
  r.post("/:id/acknowledge", requireRole("admin"), async (c) =>
    c.json({ data: await acknowledgeAlert(c.get("session"), uuidParam(c.req.param("id"))) }));
  r.post("/:id/resolve", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw).catch(() => ({} as Record<string, unknown>));
    return c.json({ data: await resolveAlertManually(c.get("session"), uuidParam(c.req.param("id")), str(b, "note", { required: false, max: 500 })) });
  });
  return r;
}

export function locationRoutes() {
  const r = new Hono<AppEnv>();
  // Location is personal data: admin role minimum; every read is audited in the service.
  r.use("*", requireSession, requireRole("admin"));
  r.get("/latest", async (c) => c.json({ data: await latestLocations(c.get("session")) }));
  r.get("/device/:id", async (c) =>
    c.json({ data: await deviceHistory(c.get("session"), uuidParam(c.req.param("id")), intQuery(c.req.query("hours"), 24, 24 * 30)) }));

  r.get("/geofences", async (c) => c.json({ data: await listGeofences(c.get("session").enterpriseId) }));
  r.post("/geofences", async (c) => c.json({ data: await createGeofence(c.get("session"), await readJson(c.req.raw)) }, 201));
  r.patch("/geofences/:id", async (c) => {
    const b = await readJson(c.req.raw);
    return c.json({ data: await setGeofenceEnabled(c.get("session"), uuidParam(c.req.param("id")), Boolean(b.enabled)) });
  });
  r.delete("/geofences/:id", async (c) => {
    await deleteGeofence(c.get("session"), uuidParam(c.req.param("id")));
    return c.json({ data: { ok: true } });
  });
  return r;
}
