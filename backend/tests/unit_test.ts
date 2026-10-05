// Unit tests that need no database or network:  deno task test
import assert from "node:assert/strict";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
Deno.env.set("ENCRYPTION_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
Deno.env.set("HASH_PEPPER", "unit-test-pepper");

const { buildKioskPayload, buildPasscodePayload, buildRestrictionsPayload } = await import("../zoho/payloads.ts");
const { decryptSecret, encryptSecret, hmacHex, randomDigits } = await import("../lib/crypto.ts");
const { toSafeHtml } = await import("../services/announcements.ts");
const { backoffMs } = await import("../services/events.ts");
const { apiBaseFor, normaliseAccountsServer } = await import("../zoho/client.ts");
const { DEVICE_ACTIONS } = await import("../services/commands.ts");

Deno.test("restrictions map allow/restrict to the guide's numeric values", () => {
  const p = buildRestrictionsPayload({ allow_factory_reset: "restrict", allow_camera: "restrict", allow_usb_debug: "allow" });
  assert.deepEqual(p, { allow_factory_reset: 0, allow_camera: 2, allow_usb_debug: 1 });
  assert.throws(() => buildRestrictionsPayload({ allow_teleport: "restrict" }));
  assert.throws(() => buildRestrictionsPayload({}));
});

Deno.test("kiosk payload encodes allowed_apps as a JSON string", () => {
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: "42", packageName: "com.acme.pos" }] });
  assert.equal(p.kiosk_mode, 0);
  assert.equal(JSON.parse(p.allowed_apps as string)["42"].IDENTIFIER, "com.acme.pos");
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [] }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [{ appId: "1", packageName: "bad name!" }] }));
});

Deno.test("passcode payload validates the wipe threshold", () => {
  assert.equal(buildPasscodePayload({ maxFailedAttempts: 8 }).max_failed_attempts, 8);
  assert.equal(buildPasscodePayload({ maxFailedAttempts: -1 }).max_failed_attempts, -1);
  assert.throws(() => buildPasscodePayload({ maxFailedAttempts: 2 }));
});

Deno.test("secrets round-trip through AES-GCM and never appear in ciphertext", async () => {
  const blob = await encryptSecret("1000.refresh.token");
  assert.ok(blob.startsWith("v1:") && !blob.includes("refresh"));
  assert.equal(await decryptSecret(blob), "1000.refresh.token");
  assert.notEqual(await encryptSecret("x"), await encryptSecret("x")); // random IV
});

Deno.test("OTP helpers", async () => {
  const code = randomDigits(6);
  assert.match(code, /^\d{6}$/);
  assert.equal(await hmacHex("a"), await hmacHex("a"));
  assert.notEqual(await hmacHex("a"), await hmacHex("b"));
});

Deno.test("announcement text is escaped before it becomes device HTML", () => {
  assert.equal(toSafeHtml("<script>x</script>\nline"), "<p>&lt;script&gt;x&lt;/script&gt;<br>line</p>");
});

Deno.test("backoff grows and is capped", () => {
  assert.ok(backoffMs(1) < backoffMs(4));
  assert.ok(backoffMs(30) <= 30 * 60_000 * 1.2);
});

Deno.test("only known Zoho data centres are accepted", () => {
  assert.equal(normaliseAccountsServer("https://accounts.zoho.eu"), "https://accounts.zoho.eu");
  assert.equal(apiBaseFor("https://accounts.zoho.eu"), "https://mdm.manageengine.eu/api/v1/mdm");
  assert.throws(() => normaliseAccountsServer("https://evil.example.com"));
});

Deno.test("destructive actions need confirmation and the owner role", () => {
  assert.equal(DEVICE_ACTIONS.complete_wipe.confirm, true);
  assert.equal(DEVICE_ACTIONS.complete_wipe.minRole, "owner");
  assert.equal(DEVICE_ACTIONS.lock.confirm, false);
});

// ------------------------------------------------------------ monitoring
const { isWorkingTime } = await import("../services/monitoring.ts");
const { distanceM, evaluateFences } = await import("../services/locations.ts");
const { evaluateDataUse, evaluateSecurity } = await import("../services/security-scan.ts");

Deno.test("working hours are evaluated in the enterprise timezone", () => {
  const st = { work_start: "08:00", work_end: "18:00", work_days: [1, 2, 3, 4, 5], timezone: "Africa/Dar_es_Salaam" };
  assert.equal(isWorkingTime(st, new Date("2026-10-01T06:30:00Z")), true); // Thu 09:30 EAT
  assert.equal(isWorkingTime(st, new Date("2026-10-01T04:30:00Z")), false); // Thu 07:30 EAT
  assert.equal(isWorkingTime(st, new Date("2026-10-03T08:00:00Z")), false); // Saturday
  assert.equal(isWorkingTime({ ...st, work_start: "22:00", work_end: "06:00" }, new Date("2026-10-01T00:00:00Z")), true); // night shift 03:00
});

Deno.test("geofence maths", () => {
  assert.ok(Math.abs(distanceM(-6.8161, 39.2803, -6.7661, 39.2803) - 5560) < 30);
  const fence = { id: "f", enterprise_id: "e", group_id: null, name: "Office", kind: "allowed" as const, latitude: -6.8161, longitude: 39.2803, radius_m: 1000, active_hours_only: true, enabled: true };
  assert.equal(evaluateFences({ latitude: -6.8161, longitude: 39.2803 }, [fence], true).outsideAllowed, false);
  assert.equal(evaluateFences({ latitude: -6.7661, longitude: 39.2803 }, [fence], true).outsideAllowed, true);
  assert.equal(evaluateFences({ latitude: -6.7661, longitude: 39.2803 }, [fence], false).outsideAllowed, false); // after hours
});

Deno.test("security conditions", () => {
  const now = new Date();
  const c = evaluateSecurity({ security: { device_rooted: true, passcode_present: false }, lastContactAt: new Date(now.getTime() - 50 * 3600_000), offlineHours: 48, now });
  assert.equal(c.rooted, true);
  assert.equal(c.passcodeMissing, true);
  assert.equal(c.offline, true);
});

Deno.test("data spike needs a baseline and ignores idle periods", () => {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  let snap = { data_total: 1000, data_rate_baseline: null as number | null, data_samples: 0, captured_at: hourAgo };
  for (let i = 1; i <= 4; i++) {
    const r = evaluateDataUse(snap, 1000 + i * 100, 3);
    assert.equal(r.spike, false);
    snap = { data_total: 1000 + i * 100, data_rate_baseline: r.baseline, data_samples: r.samples, captured_at: hourAgo };
  }
  assert.equal(evaluateDataUse(snap, snap.data_total, 3).spike, false); // idle
  assert.equal(evaluateDataUse(snap, snap.data_total + 5000, 3).spike, true);
});
