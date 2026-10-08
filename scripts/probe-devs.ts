import * as zoho from "../backend/zoho/api.ts";
const all = await zoho.listDevices("4509b6e6-6a8b-4c6c-9ce2-a162cb646705");
console.log("count:", all.length);
console.log("\nFirst device, all keys:", Object.keys(all[0] ?? {}).sort());
console.log("\nFirst device full dump:");
console.log(JSON.stringify(all[0], null, 2));
