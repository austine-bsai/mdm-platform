// Fetch a single payload item's actual field values from Zoho.
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/inspect-payload-item.ts <enterpriseId> <zohoProfileId> <payloadName> <payloadItemId>
import { zohoRequest } from "../backend/zoho/client.ts";
const [eid, pid, name, item] = Deno.args;
const body = await zohoRequest<Record<string, unknown>>(eid, {
  path: `/profiles/${pid}/payloads/${name}/payloaditems/${item}`,
});
console.log(JSON.stringify(body, null, 2));
