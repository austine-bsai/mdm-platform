// One-shot: run selected sync resources for an enterprise.
// Run:
//   deno run --allow-net --allow-env --allow-read --env-file=.env scripts/run-sync.ts <enterpriseId> [resources...]
import { syncEnterprise, type Resource } from "../backend/services/sync.ts";

const [eid, ...rest] = Deno.args;
if (!eid) {
  console.error("usage: deno run ... scripts/run-sync.ts <enterpriseId> [resources...]");
  Deno.exit(2);
}
const resources = (rest.length ? rest : ["profiles"]) as Resource[];
console.log(`Syncing ${resources.join(",")} for enterprise ${eid}...`);
const summary = await syncEnterprise(eid, resources);
console.log(JSON.stringify(summary, null, 2));
Deno.exit(0);
