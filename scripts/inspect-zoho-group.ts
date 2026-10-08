// Dump the live Zoho state for one group + its profiles + each profile's payloads.
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/inspect-zoho-group.ts <localGroupId>
import { db, run } from "../backend/lib/db.ts";
import * as zoho from "../backend/zoho/api.ts";

const localGroupId = Deno.args[0];
if (!localGroupId) {
  console.error("usage: deno run ... scripts/inspect-zoho-group.ts <localGroupId>");
  Deno.exit(2);
}

const g = await run<{ id: string; name: string; enterprise_id: string; zoho_group_id: string | null }>(
  db().from("groups").select("id, name, enterprise_id, zoho_group_id").eq("id", localGroupId).single(),
);
if (!g.zoho_group_id) {
  console.error(`Group ${g.name} has no zoho_group_id yet.`);
  Deno.exit(1);
}

console.log(`\n=== Group ${g.name} (local ${g.id}, zoho ${g.zoho_group_id}) ===`);

const zGroup = await zoho.getGroup(g.enterprise_id, g.zoho_group_id);
console.log("\n-- Zoho group record --");
console.log(JSON.stringify(zGroup, null, 2));

const members = await zoho.listGroupMembers(g.enterprise_id, g.zoho_group_id);
console.log(`\n-- Zoho group members (${members.length}) --`);
console.log(JSON.stringify(members, null, 2));

let zProfiles: unknown = null;
try {
  zProfiles = await zoho.listGroupProfiles(g.enterprise_id, g.zoho_group_id);
} catch (e) {
  zProfiles = { error: String(e), code: (e as { code?: string }).code };
}
console.log("\n-- Zoho group's profiles (GET /groups/{id}/profiles) --");
console.log(JSON.stringify(zProfiles, null, 2));

// Walk each profile in Zoho and dump its payloads
const localProfiles = await run<{ id: string; name: string; zoho_profile_id: string | null }[]>(
  db().from("profile_groups").select("profile_id, profiles(id, name, zoho_profile_id)")
    .eq("group_id", g.id)
    // deno-lint-ignore no-explicit-any
    .then((r: any) => ({ ...r, data: (r.data ?? []).map((row: any) => row.profiles) })),
);

for (const p of localProfiles) {
  if (!p.zoho_profile_id) {
    console.log(`\n-- Profile ${p.name} (${p.id}): no zoho_profile_id --`);
    continue;
  }
  console.log(`\n-- Profile ${p.name} (local ${p.id}, zoho ${p.zoho_profile_id}) --`);
  const detail = await zoho.getProfile(g.enterprise_id, p.zoho_profile_id);
  console.log("profile detail:", JSON.stringify(detail, null, 2));
  const payloads = await zoho.listPayloads(g.enterprise_id, p.zoho_profile_id);
  console.log("payloads:", JSON.stringify(payloads, null, 2));
}

Deno.exit(0);
