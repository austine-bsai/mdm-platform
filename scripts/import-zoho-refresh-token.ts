// One-shot: import a Zoho Self Client JSON (or an already-issued refresh token)
// into zoho_connections for a specific enterprise. Skips the OAuth consent flow.
//
// Run:
//   deno task zoho-import <admin-email> [accounts-server]
//
// Credential sources, in order of preference:
//   1. ZOHO_IMPORT_* env vars (useful for one-off runs with inline vars)
//   2. The newest backend/self_client*.json file (the JSON Zoho's api-console lets you
//      download when generating a code — contains client_id, client_secret, code, scope)
//   3. ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_CLIENT_CODE from .env

import { db, run, runMaybe } from "../backend/lib/db.ts";
import { encryptSecret } from "../backend/lib/crypto.ts";
import { apiBaseFor, exchangeCode, normaliseAccountsServer } from "../backend/zoho/client.ts";

type SelfClientFile = {
  client_id?: string;
  client_secret?: string;
  code?: string;
  scope?: string[] | string;
  expiry_time?: number;
};

async function newestSelfClientJson(): Promise<{ path: string; data: SelfClientFile } | null> {
  const dir = new URL("../backend/", import.meta.url).pathname;
  const matches: { path: string; mtime: number }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && /^self_client.*\.json$/i.test(entry.name)) {
      const full = `${dir}${entry.name}`;
      const stat = await Deno.stat(full);
      matches.push({ path: full, mtime: stat.mtime?.getTime() ?? 0 });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  const data = JSON.parse(await Deno.readTextFile(matches[0].path)) as SelfClientFile;
  return { path: matches[0].path, data };
}

const DEFAULT_SCOPES = [
  "MDMOnDemand.MDMInventory.ALL",
  "MDMOnDemand.MDMDeviceMgmt.ALL",
  "MDMOnDemand.MDMUser.ALL",
];

function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v) {
    if (!required) return "";
    console.error(`Missing env var ${name}. Set it in .env or export it before running.`);
    Deno.exit(1);
  }
  return v;
}

const [emailArg, dcArg] = Deno.args;
if (!emailArg) {
  console.error("Usage: deno run ... scripts/import-zoho-refresh-token.ts <admin-email> [accounts-server]");
  Deno.exit(1);
}
const email = emailArg.trim().toLowerCase();
const accountsServer = normaliseAccountsServer(dcArg ?? "https://accounts.zoho.com");
const apiBase = apiBaseFor(accountsServer);
const jsonFile = await newestSelfClientJson();
if (jsonFile) {
  const ageMs = (jsonFile.data.expiry_time ?? 0) - Date.now();
  const status = ageMs > 0 ? `expires in ${Math.round(ageMs / 60_000)} min` : `expired ${Math.round(-ageMs / 60_000)} min ago`;
  console.log(`Found ${jsonFile.path.split("/").pop()} (${status})`);
  if (ageMs <= 0 && !Deno.env.get("ZOHO_IMPORT_REFRESH_TOKEN")) {
    console.error(`\nCode has expired. Generate a new one:`);
    console.error(`  1. api-console.zoho.com → your Self Client → Generate Code`);
    console.error(`     scopes: MDMOnDemand.MDMInventory.ALL,MDMOnDemand.MDMDeviceMgmt.ALL,MDMOnDemand.MDMUser.ALL`);
    console.error(`  2. Click the download icon to save the new self_client.json`);
    console.error(`  3. Move it into backend/, then re-run: deno task zoho-import ${emailArg}`);
    console.error(`\nNote: if the enterprise is already connected (zoho_connections row exists),`);
    console.error(`      you do NOT need to re-import. Refresh tokens don't expire.`);
    Deno.exit(1);
  }
}

const admin = await runMaybe<{ id: string; enterprise_id: string }>(
  db().from("admins").select("id, enterprise_id").eq("email", email).maybeSingle(),
);
if (!admin) {
  console.error(`No admin found for email ${email}. Register the enterprise first.`);
  Deno.exit(1);
}

const existing = await runMaybe<{ status: string; refresh_token_enc: string | null }>(
  db().from("zoho_connections").select("status, refresh_token_enc").eq("enterprise_id", admin.enterprise_id).maybeSingle(),
);
if (existing?.status === "connected" && existing.refresh_token_enc && !Deno.env.get("ZOHO_IMPORT_FORCE")) {
  console.log(`Enterprise ${admin.enterprise_id} is already connected to Zoho. Refresh tokens don't expire.`);
  console.log(`Nothing to do. To force a re-import anyway, re-run with ZOHO_IMPORT_FORCE=1.`);
  Deno.exit(0);
}

const clientId = env("ZOHO_IMPORT_CLIENT_ID", false) || jsonFile?.data.client_id || env("ZOHO_CLIENT_ID");
const clientSecret = env("ZOHO_IMPORT_CLIENT_SECRET", false) || jsonFile?.data.client_secret || env("ZOHO_CLIENT_SECRET");
let refreshToken = env("ZOHO_IMPORT_REFRESH_TOKEN", false);
let grantedScopes: string[] = DEFAULT_SCOPES;

// Self Client codes are single-use, ~10 min TTL. If present, exchange for a fresh refresh token.
const importCode = env("ZOHO_IMPORT_CODE", false) || jsonFile?.data.code || env("ZOHO_CLIENT_CODE", false);
if (!refreshToken && !importCode) {
  console.error("No credentials found. Place a self_client*.json from Zoho api-console in backend/, or set ZOHO_CLIENT_CODE in .env.");
  Deno.exit(1);
}
if (importCode) {
  console.log(`Exchanging Self Client code at ${accountsServer}…`);
  const tokens = await exchangeCode({ accountsServer, code: importCode, clientId, clientSecret });
  refreshToken = tokens.refreshToken;
  grantedScopes = tokens.scope ? tokens.scope.split(/[ ,]+/).filter(Boolean) : DEFAULT_SCOPES;
  console.log(`  granted scopes: ${grantedScopes.join(", ") || "(none reported)"}`);
}

await run(
  db().from("zoho_connections").upsert({
    enterprise_id: admin.enterprise_id,
    status: "connected",
    accounts_server: accountsServer,
    api_base: apiBase,
    client_id: clientId,
    client_secret_enc: await encryptSecret(clientSecret),
    refresh_token_enc: await encryptSecret(refreshToken),
    access_token_enc: null,
    access_token_expires_at: null,
    scopes: grantedScopes,
    zoho_account_email: null,
    last_error: null,
    connected_by: admin.id,
    connected_at: new Date().toISOString(),
  }, { onConflict: "enterprise_id" }),
);

console.log(`Imported Zoho refresh token for ${email}`);
console.log(`  enterprise_id : ${admin.enterprise_id}`);
console.log(`  accounts      : ${accountsServer}`);
console.log(`  api base      : ${apiBase}`);
console.log(`Next: click Settings → Test connection in the browser.`);
