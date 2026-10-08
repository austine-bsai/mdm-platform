import * as zoho from "../backend/zoho/api.ts";
const EID = "4509b6e6-6a8b-4c6c-9ce2-a162cb646705";

console.log("=== Zoho app repository ===");
const repo = await zoho.listApps(EID);
console.log(`${repo.length} app(s)`);
for (const a of repo) console.log(`  ${a.app_name ?? "?"} · ${a.bundle_identifier ?? a.identifier ?? "?"} · app_id=${a.app_id}`);

console.log("\n=== Zoho blacklist repository ===");
const bl = await zoho.listBlacklistApps(EID) as { apps?: Array<Record<string, unknown>> };
const blApps = bl.apps ?? [];
console.log(`${blApps.length} app(s)`);
for (const a of blApps) console.log(`  ${a.appname ?? "?"} · ${a.identifier ?? "?"} · appgroupid=${a.appgroupid}`);

console.log("\n=== Installed apps per device ===");
for (const zid of ["247008000000130084", "247008000000130243", "247008000000137004"]) {
  try {
    const resp = await zoho.listDeviceApps(EID, zid) as { installed_apps?: Array<Record<string, unknown>> };
    const list = resp.installed_apps ?? [];
    console.log(`\n  ${zid}: ${list.length} app(s)`);
    for (const a of list.slice(0, 20)) console.log(`    ${a.app_name ?? "?"} · ${a.identifier ?? "?"} · v${a.app_version ?? "?"}`);
    if (list.length > 20) console.log(`    … + ${list.length - 20} more`);
  } catch (e) {
    console.log(`  ${zid}: ERROR ${String(e).slice(0, 100)}`);
  }
}
