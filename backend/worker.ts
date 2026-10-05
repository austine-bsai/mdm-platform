// Background worker:
//   * retries queued operations (backlog with exponential backoff -> "dead" after max attempts)
//   * polls sent device commands until the device acknowledges / finishes
//   * expires unconfirmed destructive commands
//   * periodic Zoho -> Supabase sync per connected enterprise
//   * monitoring: security scan, location polling + geofences, admin-activity checks, location purge
// Run separately with `deno task worker`, or inline with RUN_WORKER_INLINE=true.
import { getConfig } from "./config.ts";
import { db, run } from "./lib/db.ts";
import { toAppError } from "./lib/errors.ts";
import { log } from "./lib/log.ts";
import { claimDue, processEvent, updateEvent } from "./services/events.ts";
import { pollCommandStatus } from "./services/commands.ts";
import { syncEnterprise } from "./services/sync.ts";
import { checkAdminActivity, getSettings } from "./services/monitoring.ts";
import { scanEnterprise } from "./services/security-scan.ts";
import { pollEnterpriseLocations } from "./services/locations.ts";
import "./services/groups.ts";
import "./services/profiles.ts";
import "./services/announcements.ts";

let ticking = false;
let lastSync = 0;
let lastPurge = 0;

export async function tick(): Promise<void> {
  if (ticking) return; // never overlap
  ticking = true;
  try {
    const { data: expired } = await db().rpc("expire_unconfirmed_events");
    if (expired) log("info", "worker.expired_confirmations", { count: expired });

    for (const ev of await claimDue(["requested"], 20)) await processEvent(ev);

    for (const ev of await claimDue(["sent", "acknowledged"], 20)) {
      if (ev.category !== "command") {
        await updateEvent(ev.id, { locked_until: null, next_attempt_at: new Date(Date.now() + 365 * 86400_000).toISOString() });
        continue;
      }
      try {
        await pollCommandStatus(ev);
      } catch (e) {
        const err = toAppError(e);
        log("warn", "worker.poll_failed", { event_id: ev.id, code: err.code });
        await updateEvent(ev.id, { locked_until: null, next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() });
      }
    }

    const cfg = getConfig();
    if (Date.now() - lastSync > cfg.syncIntervalMinutes * 60_000) {
      lastSync = Date.now();
      const conns = await run<{ enterprise_id: string }[]>(
        db().from("zoho_connections").select("enterprise_id").eq("status", "connected"),
      );
      for (const c of conns) await syncEnterprise(c.enterprise_id);
    }
    await monitoringTick(cfg.syncIntervalMinutes);
  } catch (e) {
    log("error", "worker.tick_failed", { error: String(e) });
  } finally {
    ticking = false;
  }
}

/** Per enterprise: security scan every sync interval, location poll on its own interval, admin checks each tick. */
export async function monitoringTick(scanEveryMinutes: number) {
  const conns = await run<{ enterprise_id: string }[]>(
    db().from("zoho_connections").select("enterprise_id").eq("status", "connected"),
  );
  for (const { enterprise_id: eid } of conns) {
    try {
      const st = await getSettings(eid);
      const due = (iso: string | null, minutes: number) => !iso || Date.now() - Date.parse(iso) > minutes * 60_000;
      if (due(st.last_security_scan_at, scanEveryMinutes)) await scanEnterprise(eid);
      if (st.location_tracking_enabled && due(st.last_location_poll_at, st.location_interval_minutes)) {
        await pollEnterpriseLocations(eid);
      }
      await checkAdminActivity(eid);
    } catch (e) {
      log("warn", "worker.monitoring_failed", { enterprise_id: eid, code: toAppError(e).code });
    }
  }
  if (Date.now() - lastPurge > 6 * 3600_000) {
    lastPurge = Date.now();
    const { data } = await db().rpc("purge_old_locations");
    if (data) log("info", "worker.locations_purged", { count: data });
  }
}

export function startWorker() {
  const cfg = getConfig();
  log("info", "worker.started", { every_s: cfg.workerIntervalSeconds });
  tick();
  return setInterval(tick, cfg.workerIntervalSeconds * 1000);
}

if (import.meta.main) startWorker();
