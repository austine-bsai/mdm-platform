import * as zoho from "../backend/zoho/api.ts";
const apps = await zoho.listApps("4509b6e6-6a8b-4c6c-9ce2-a162cb646705");
console.log(`Zoho app repository has ${apps.length} app(s).`);
for (const a of apps) {
  console.log(`  app_id=${a.app_id}  name=${a.app_name ?? "?"}  platform_type=${a.platform_type}  pkg=${a.bundle_identifier ?? a.identifier ?? "(none)"}`);
}
