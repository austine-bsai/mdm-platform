// Fetch Zoho device detail: summary, profiles, recent command.
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/inspect-device.ts <localDeviceId>
import { db, run } from "../backend/lib/db.ts";
import * as zoho from "../backend/zoho/api.ts";

const id = Deno.args[0];
if (!id) {
  console.error("usage: deno run ... scripts/inspect-device.ts <localDeviceId>");
  Deno.exit(2);
}
const d = await run<{ id: string; enterprise_id: string; device_name: string; zoho_device_id: string; owned_by: number | null }>(
  db().from("devices").select("id, enterprise_id, device_name, zoho_device_id, owned_by").eq("id", id).single(),
);
console.log(`Device ${d.device_name} (local ${d.id}, zoho ${d.zoho_device_id}, owned_by=${d.owned_by})\n`);

console.log("-- Zoho device detail --");
console.log(JSON.stringify(await zoho.getDevice(d.enterprise_id, d.zoho_device_id), null, 2));

console.log("\n-- Zoho device profiles --");
console.log(JSON.stringify(await zoho.listDeviceProfiles(d.enterprise_id, d.zoho_device_id), null, 2));

console.log("\n-- Zoho device summary --");
try {
  console.log(JSON.stringify(await zoho.getDeviceSummary(d.enterprise_id, d.zoho_device_id), null, 2));
} catch (e) {
  console.log("summary error:", String(e));
}

console.log("\n-- Recent command --");
try {
  console.log(JSON.stringify(await zoho.getRecentCommand(d.enterprise_id, d.zoho_device_id), null, 2));
} catch (e) {
  console.log("recent error:", String(e));
}
