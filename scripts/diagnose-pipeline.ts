// End-to-end pipeline check for a device in Zoho:
//   - compares the two "duplicate" devices to see which is actually live
//   - prints last contact time, management/enrollment hints
//   - prints the device's current profile list and application status
//   - checks whether Zoho's /profiles/{id}/publish was followed by an update push
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/diagnose-pipeline.ts
import { db, run } from "../backend/lib/db.ts";
import * as zoho from "../backend/zoho/api.ts";

const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const devs = await run<{ id: string; device_name: string; zoho_device_id: string; added_at: string; is_removed: boolean }[]>(
  db().from("devices").select("id, device_name, zoho_device_id, added_at, is_removed").eq("enterprise_id", EID).ilike("device_name", "%Austine%"),
);
console.log(`Found ${devs.length} matching device(s) in local DB`);

type ZohoDevRecord = Record<string, unknown> & { last_contact_time?: string; agent_version?: string; is_supervised?: boolean; owned_by?: string; management_type?: unknown; profile_owner?: unknown; manage_type?: unknown; admin_type?: unknown; enrollment_type?: unknown };

for (const d of devs) {
  console.log(`\n==== ${d.device_name}  (local ${d.id}, zoho ${d.zoho_device_id}, is_removed=${d.is_removed}) ====`);
  try {
    const detail = await zoho.getDevice(EID, d.zoho_device_id) as ZohoDevRecord;
    const lastContactMs = Number(detail.last_contact_time ?? 0);
    const ageMinutes = lastContactMs ? Math.round((Date.now() - lastContactMs) / 60000) : null;
    console.log(JSON.stringify({
      last_contact: lastContactMs ? new Date(lastContactMs).toISOString() : null,
      age_minutes: ageMinutes,
      agent_version: detail.agent_version,
      is_supervised: detail.is_supervised,
      owned_by: detail.owned_by,
      // Any field with "manage"/"owner"/"enroll"/"admin" in its name
      management_hints: Object.fromEntries(Object.entries(detail).filter(([k]) => /manage|owner|enroll|admin|supervis/i.test(k))),
    }, null, 2));
    const profiles = await zoho.listDeviceProfiles(EID, d.zoho_device_id);
    console.log(`-- device has ${profiles.length} profile(s) applied in Zoho --`);
    for (const p of profiles) {
      const prof = p as Record<string, unknown>;
      console.log(`  ${prof.profile_name}: status=${prof.status} remarks="${prof.remarks}" applied=${prof.applied_time ? new Date(Number(prof.applied_time)).toISOString() : "never"}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${String(e)}`);
  }
}

console.log("\n==== ITdept group's current profiles (Zoho side) ====");
const g = await run<{ zoho_group_id: string }>(
  db().from("groups").select("zoho_group_id").eq("id", "63557c20-26b4-43fb-a631-408bc5f87fb8").single(),
);
const list = await zoho.listGroupProfiles(EID, g.zoho_group_id);
console.log(JSON.stringify(list, null, 2));
