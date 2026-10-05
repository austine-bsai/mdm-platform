// Location history + geofencing. Off by default; only corporate devices; optional
// working-hours-only collection; points purged after the retention period.
import { db, run } from "../lib/db.ts";
import { fail, toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import * as zoho from "../zoho/api.ts";
import type { Session } from "./auth.ts";
import { recordAudit } from "./events.ts";
import { type EffectiveRule, getRules, getSettings, isWorkingTime, type MonitoringSettings, raiseAlert, resolveAlert } from "./monitoring.ts";

export type Geofence = {
  id: string;
  enterprise_id: string;
  group_id: string | null;
  name: string;
  kind: "allowed" | "restricted";
  latitude: number;
  longitude: number;
  radius_m: number;
  active_hours_only: boolean;
  enabled: boolean;
};

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Pure geofence decision (unit-tested). */
export function evaluateFences(point: { latitude: number; longitude: number }, fences: Geofence[], working: boolean) {
  const active = fences.filter((f) => f.enabled && (!f.active_hours_only || working));
  const allowed = active.filter((f) => f.kind === "allowed");
  const withDist = (f: Geofence) => ({ fence: f, distance: distanceM(point.latitude, point.longitude, f.latitude, f.longitude) });
  const allowedD = allowed.map(withDist);
  const insideAllowed = allowedD.some((x) => x.distance <= x.fence.radius_m);
  const nearest = allowedD.sort((a, b) => a.distance - b.distance)[0];
  return {
    checkedAllowed: allowed.length > 0,
    outsideAllowed: allowed.length > 0 && !insideAllowed,
    nearestAllowed: nearest ? { name: nearest.fence.name, distance_m: Math.round(nearest.distance - nearest.fence.radius_m) } : null,
    restrictedHits: active.filter((f) => f.kind === "restricted").map(withDist).map((x) => ({ fence: x.fence, inside: x.distance <= x.fence.radius_m })),
  };
}

// ---------------------------------------------------------------- polling
type Dev = { id: string; zoho_device_id: string; device_name: string | null; owned_by: number | null };

export async function pollEnterpriseLocations(eid: string, opts: { force?: boolean } = {}) {
  const st = await getSettings(eid);
  if (!st.location_tracking_enabled) return { skipped: "tracking disabled" };
  const working = isWorkingTime(st);
  if (st.working_hours_only && !working && !opts.force) return { skipped: "outside working hours" };

  // Personal (work-profile) devices are never tracked.
  const devices = (await run<Dev[]>(
    db().from("devices").select("id, zoho_device_id, device_name, owned_by").eq("enterprise_id", eid).eq("is_removed", false),
  )).filter((d) => d.owned_by !== 2);
  const fences = await run<Geofence[]>(db().from("geofences").select("*").eq("enterprise_id", eid).eq("enabled", true));
  const memberships = await run<{ group_id: string; device_id: string }[]>(
    db().from("group_devices").select("group_id, device_id").in("device_id", devices.map((d) => d.id).concat(["00000000-0000-0000-0000-000000000000"])),
  );
  const groupsOf = new Map<string, Set<string>>();
  for (const m of memberships) (groupsOf.get(m.device_id) ?? groupsOf.set(m.device_id, new Set()).get(m.device_id)!).add(m.group_id);
  const rules = await getRules(eid);

  let stored = 0;
  for (let i = 0; i < devices.length; i += 4) {
    await Promise.all(devices.slice(i, i + 4).map(async (d) => {
      try {
        stored += await pollDevice(eid, d, st, fences, groupsOf.get(d.id) ?? new Set(), working, rules);
      } catch (e) {
        log("warn", "location.poll_failed", { device_id: d.id, code: toAppError(e).code });
      }
    }));
  }
  await db().from("monitoring_settings").update({ last_location_poll_at: new Date().toISOString() }).eq("enterprise_id", eid);
  return { devices: devices.length, stored };
}

async function pollDevice(
  eid: string,
  d: Dev,
  st: MonitoringSettings,
  fences: Geofence[],
  groups: Set<string>,
  working: boolean,
  rules: EffectiveRule[],
): Promise<number> {
  const raw = await zoho.getDeviceLocations(eid, d.zoho_device_id);
  const minTime = Date.now() - st.location_retention_days * 86400_000;
  const rows = raw
    .map((l) => ({ lat: Number(l.latitude), lon: Number(l.longitude), t: Number(l.located_time ?? l.added_time) }))
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180 && l.t > minTime)
    .map((l) => ({ enterprise_id: eid, device_id: d.id, latitude: l.lat, longitude: l.lon, located_at: new Date(l.t).toISOString() }));
  if (rows.length) {
    await run(db().from("device_locations").upsert(rows, { onConflict: "device_id,located_at", ignoreDuplicates: true }));
  }

  // Geofences use the newest point, if it is fresh (< 6 h).
  const latest = rows.sort((a, b) => Date.parse(b.located_at) - Date.parse(a.located_at))[0];
  if (!latest || Date.now() - Date.parse(latest.located_at) > 6 * 3600_000) return rows.length;
  const applicable = fences.filter((f) => !f.group_id || groups.has(f.group_id));
  if (!applicable.length) return rows.length;

  const r = evaluateFences(latest, applicable, working);
  const name = d.device_name ?? String(d.zoho_device_id);
  const exitKey = `geofence_exit:${d.id}`;
  if (r.outsideAllowed) {
    await raiseAlert({
      enterpriseId: eid,
      ruleKey: "geofence_exit",
      dedupeKey: exitKey,
      deviceId: d.id,
      title: `${name} is outside its allowed area${r.nearestAllowed ? ` (${r.nearestAllowed.distance_m} m from ${r.nearestAllowed.name})` : ""}`,
      details: { latitude: latest.latitude, longitude: latest.longitude, located_at: latest.located_at, nearest: r.nearestAllowed },
    }, rules);
  } else if (r.checkedAllowed) {
    await resolveAlert(eid, exitKey, "Back inside an allowed area");
  }
  for (const hit of r.restrictedHits) {
    const key = `geofence_restricted:${d.id}:${hit.fence.id}`;
    if (hit.inside) {
      await raiseAlert({
        enterpriseId: eid,
        ruleKey: "geofence_restricted",
        dedupeKey: key,
        deviceId: d.id,
        geofenceId: hit.fence.id,
        title: `${name} entered restricted area "${hit.fence.name}"`,
        details: { latitude: latest.latitude, longitude: latest.longitude, located_at: latest.located_at },
      }, rules);
    } else {
      await resolveAlert(eid, key, "Left the restricted area");
    }
  }
  return rows.length;
}

// --------------------------------------------------------------- read APIs
export async function latestLocations(s: Session) {
  const st = await getSettings(s.enterpriseId);
  const points = await run<{ device_id: string; latitude: number; longitude: number; located_at: string }[]>(
    db().rpc("latest_device_locations", { p_enterprise: s.enterpriseId }),
  );
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "command", action: "location.viewed_map", params: { points: points.length } });
  return { tracking: st.location_tracking_enabled, retention_days: st.location_retention_days, points };
}

export async function deviceHistory(s: Session, deviceId: string, hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const points = await run(
    db().from("device_locations").select("latitude, longitude, located_at").eq("enterprise_id", s.enterpriseId)
      .eq("device_id", deviceId).gte("located_at", since).order("located_at", { ascending: false }).limit(2000),
  );
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "command", action: "location.viewed_history", deviceId, params: { hours } });
  return points;
}

// -------------------------------------------------------------- geofences
export async function listGeofences(eid: string) {
  return await run(db().from("geofences").select("*, groups(id, name)").eq("enterprise_id", eid).order("created_at"));
}

export async function createGeofence(s: Session, b: Record<string, unknown>) {
  const lat = Number(b.latitude);
  const lon = Number(b.longitude);
  const radius = Number(b.radiusM);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) fail("VALIDATION_FAILED", "Latitude/longitude out of range");
  if (!Number.isInteger(radius) || radius < 50 || radius > 50000) fail("VALIDATION_FAILED", "radiusM must be 50–50000");
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 100) fail("VALIDATION_FAILED", "name is required");
  const kind = b.kind === "restricted" ? "restricted" : "allowed";
  let groupId: string | null = null;
  if (b.groupId) {
    groupId = String(b.groupId);
    await run(db().from("groups").select("id").eq("enterprise_id", s.enterpriseId).eq("id", groupId).single());
  }
  const row = await run(
    db().from("geofences").insert({
      enterprise_id: s.enterpriseId,
      group_id: groupId,
      name,
      kind,
      latitude: lat,
      longitude: lon,
      radius_m: radius,
      active_hours_only: b.activeHoursOnly !== false,
      created_by: s.adminId,
    }).select("*").single(),
  );
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "zoho", action: "geofence.created", params: { name, kind, radius } });
  return row;
}

export async function setGeofenceEnabled(s: Session, id: string, enabled: boolean) {
  return await run(db().from("geofences").update({ enabled }).eq("enterprise_id", s.enterpriseId).eq("id", id).select("*").single());
}

export async function deleteGeofence(s: Session, id: string) {
  await run(db().from("geofences").select("id").eq("enterprise_id", s.enterpriseId).eq("id", id).single());
  await run(db().from("geofences").delete().eq("id", id));
  await db().from("alerts").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Geofence deleted" })
    .eq("geofence_id", id).neq("status", "resolved");
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "zoho", action: "geofence.deleted", params: { id } });
}
