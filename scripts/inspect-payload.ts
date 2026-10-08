// Fetch a single payload body from Zoho.
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/inspect-payload.ts <enterpriseId> <zohoProfileId> <payloadName>
import { zohoRequest } from "../backend/zoho/client.ts";

const [eid, pid, name] = Deno.args;
if (!eid || !pid || !name) {
  console.error("usage: deno run ... scripts/inspect-payload.ts <enterpriseId> <zohoProfileId> <payloadName>");
  Deno.exit(2);
}
const body = await zohoRequest<Record<string, unknown>>(eid, { path: `/profiles/${pid}/payloads/${name}` });
console.log(JSON.stringify(body, null, 2));
