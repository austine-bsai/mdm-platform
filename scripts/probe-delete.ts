import { zohoRequest } from "../backend/zoho/client.ts";
import * as zoho from "../backend/zoho/api.ts";
const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";
const PID = "247008000000129202";

// Find which groups it's associated to by scanning each group's profiles.
const groups = await zoho.listGroups(EID);
const hits: string[] = [];
for (const g of groups) {
  if (!g.group_id) continue;
  const list = await zoho.listGroupProfiles(EID, g.group_id);
  if ((list ?? []).some((x: unknown) => String((x as Record<string, unknown>)?.profile_id ?? x) === PID)) {
    hits.push(String(g.group_id));
    console.log(`  → in group ${g.name} (${g.group_id})`);
  }
}
if (!hits.length) console.log("  not in any group — strange, Zoho says assoc_groups=1");

// Disassociate from each
for (const gid of hits) {
  console.log(`\nDisassociate from ${gid}`);
  try {
    const r = await zohoRequest<unknown>(EID, { method: "DELETE", path: `/groups/${gid}/profiles`, body: { profile_ids: [PID] } });
    console.log("  OK:", JSON.stringify(r).slice(0, 200));
  } catch (e) { console.log("  ERR:", String(e).slice(0, 200)); }
}

// Now try delete again
console.log("\nDELETE /profiles after disassociating");
try {
  const r = await zohoRequest<unknown>(EID, { method: "DELETE", path: "/profiles", body: { profile_ids: [PID] } });
  console.log("  OK:", JSON.stringify(r).slice(0, 200));
} catch (e) { console.log("  ERR:", String(e).slice(0, 300)); }

const after = await zohoRequest<Record<string, unknown>>(EID, { path: `/profiles/${PID}` }).catch((e) => ({ error: String(e) }));
console.log("after:", JSON.stringify({ profile_status: after.profile_status, is_moved_to_trash: after.is_moved_to_trash, error: after.error }));
