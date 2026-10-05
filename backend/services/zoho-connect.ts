// Connecting an enterprise's existing Zoho / ManageEngine MDM account.
//
// Zoho has no public API to create a Zoho organisation or its directory admin, so onboarding is:
//   1. enterprise registers here (local account + OTP login)
//   2. its Zoho admin clicks "Connect Zoho" and consents (OAuth, server-based client), or
//      pastes a self-client code (fallback)
//   3. refresh token is stored AES-GCM encrypted; everything else uses short-lived access tokens.
import { getConfig } from "../config.ts";
import { db, run, runMaybe } from "../lib/db.ts";
import { encryptSecret, randomToken, decryptSecret } from "../lib/crypto.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { apiBaseFor, exchangeCode, forgetConnection, normaliseAccountsServer, zohoRequest } from "../zoho/client.ts";
import type { Session } from "./auth.ts";
import { recordAudit } from "./events.ts";

export async function connectionStatus(eid: string) {
  const row = await runMaybe<Record<string, unknown>>(
    db().from("zoho_connections")
      .select("status, accounts_server, api_base, scopes, zoho_account_email, last_error, connected_at, client_id")
      .eq("enterprise_id", eid).maybeSingle(),
  );
  if (!row) return { status: "pending" };
  return { ...row, mode: row.client_id ? "self_client" : "oauth", client_id: undefined };
}

/** Step 1 of OAuth: returns the Zoho consent URL. */
export async function startOAuth(s: Session): Promise<{ url: string }> {
  const cfg = getConfig();
  if (!cfg.zohoClientId) fail("ZOHO_NOT_CONNECTED", "Set ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET (server-based client) or use the self-client option");
  const state = randomToken(24);
  await run(
    db().from("oauth_states").insert({
      state,
      enterprise_id: s.enterpriseId,
      admin_id: s.adminId,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  );
  const url = new URL("https://accounts.zoho.com/oauth/v2/auth");
  url.search = new URLSearchParams({
    scope: cfg.zohoScopes,
    client_id: cfg.zohoClientId,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    redirect_uri: cfg.zohoRedirectUri,
    state,
  }).toString();
  return { url: url.toString() };
}

/** Step 2 of OAuth: Zoho redirects back with ?code&state&accounts-server. */
export async function finishOAuth(params: { code: string | null; state: string | null; accountsServer: string | null; error: string | null }) {
  const cfg = getConfig();
  if (params.error) fail("ZOHO_OAUTH_FAILED", `Zoho returned: ${params.error}`);
  if (!params.code || !params.state) fail("ZOHO_OAUTH_FAILED", "Missing code or state");

  const st = await runMaybe<{ enterprise_id: string; admin_id: string; expires_at: string }>(
    db().from("oauth_states").select("*").eq("state", params.state).maybeSingle(),
  );
  await db().from("oauth_states").delete().eq("state", params.state); // single use
  if (!st || Date.parse(st.expires_at) < Date.now()) fail("ZOHO_OAUTH_FAILED", "Sign-in link expired; start again");

  const accountsServer = normaliseAccountsServer(params.accountsServer);
  const tokens = await exchangeCode({
    accountsServer,
    code: params.code,
    clientId: cfg.zohoClientId,
    clientSecret: cfg.zohoClientSecret,
    redirectUri: cfg.zohoRedirectUri,
  });
  await saveTokens(st.enterprise_id, st.admin_id, accountsServer, tokens, null);
  return st.enterprise_id;
}

/** Fallback: enterprise pastes its own self-client id/secret and a generated code. */
export async function connectSelfClient(s: Session, input: {
  clientId: string;
  clientSecret: string;
  code: string;
  accountsServer: string;
}) {
  const accountsServer = normaliseAccountsServer(input.accountsServer);
  const tokens = await exchangeCode({ accountsServer, code: input.code, clientId: input.clientId, clientSecret: input.clientSecret });
  await saveTokens(s.enterpriseId, s.adminId, accountsServer, tokens, { clientId: input.clientId, clientSecret: input.clientSecret });
}

async function saveTokens(
  eid: string,
  adminId: string,
  accountsServer: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope: string },
  selfClient: { clientId: string; clientSecret: string } | null,
) {
  await run(
    db().from("zoho_connections").upsert({
      enterprise_id: eid,
      status: "connected",
      accounts_server: accountsServer,
      api_base: apiBaseFor(accountsServer),
      client_id: selfClient?.clientId ?? null,
      client_secret_enc: selfClient ? await encryptSecret(selfClient.clientSecret) : null,
      refresh_token_enc: await encryptSecret(tokens.refreshToken),
      access_token_enc: await encryptSecret(tokens.accessToken),
      access_token_expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      scopes: tokens.scope ? tokens.scope.split(/[ ,]+/).filter(Boolean) : [],
      last_error: null,
      connected_by: adminId,
      connected_at: new Date().toISOString(),
    }, { onConflict: "enterprise_id" }),
  );
  forgetConnection(eid);
  await recordAudit({ enterpriseId: eid, adminId, category: "zoho", action: "zoho.connected", params: { accounts_server: accountsServer, mode: selfClient ? "self_client" : "oauth" } });
}

export async function testConnection(eid: string) {
  const data = await zohoRequest<Record<string, unknown>>(eid, { path: "/devices", query: { limit: 1 } });
  const total = (data?.metadata as { total_record_count?: number } | undefined)?.total_record_count;
  return { ok: true, devices_visible: total ?? null };
}

export async function disconnect(s: Session) {
  const conn = await runMaybe<{ accounts_server: string; refresh_token_enc: string | null }>(
    db().from("zoho_connections").select("accounts_server, refresh_token_enc").eq("enterprise_id", s.enterpriseId).maybeSingle(),
  );
  if (conn?.refresh_token_enc) {
    try {
      const token = await decryptSecret(conn.refresh_token_enc);
      await fetch(`${conn.accounts_server}/oauth/v2/token/revoke?token=${encodeURIComponent(token)}`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log("warn", "zoho.revoke_failed", { error: String(e) });
    }
  }
  await run(
    db().from("zoho_connections").update({
      status: "revoked",
      refresh_token_enc: null,
      access_token_enc: null,
      client_secret_enc: null,
      access_token_expires_at: null,
    }).eq("enterprise_id", s.enterpriseId),
  );
  forgetConnection(s.enterpriseId);
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "zoho", action: "zoho.disconnected" });
}
