// Profile payload builders for Android, based on the field tables in MDM_Dev_Guide.pdf
// ("Profile API Help" section). Values differ per field: most use 1 = allow / 0 = restrict,
// a few (camera, video, audio) use 1 = allow / 2 = restrict. The catalog encodes this.
import { fail } from "../lib/errors.ts";

// Zoho's payload type names are lowercase in the URL path.
// Confirmed shape by inspecting /profiles/{id}/payloads on an already-published profile.
export const PAYLOAD = {
  android: {
    restrictions: "androidrestrictionspolicy",
    kiosk: "androidkioskpolicy",
    passcode: "androidpasscodepolicy",
    frp: "androidefrppolicy",
    wifi: "androidwifipolicy",
  },
  ios: {
    restrictions: "restrictionspolicy",
    passcode: "passcodepolicy",
    wifi: "wifipolicy",
  },
} as const;

export type Purpose = "restrictions" | "kiosk" | "passcode" | "frp" | "wifi" | "custom";

type RestrictionDef = {
  key: string;
  label: string;
  category: "security" | "data" | "hardware" | "apps" | "settings";
  allow: number;
  restrict: number;
  recommended: "allow" | "restrict"; // suggested for corporate fully-managed devices
};

export const ANDROID_RESTRICTIONS: readonly RestrictionDef[] = [
  { key: "allow_factory_reset", label: "Factory reset from Settings", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_safe_mode", label: "Boot into safe mode", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_developer_mode", label: "Developer options", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_usb_debug", label: "USB debugging", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_non_market_apps", label: "Install apps from unknown sources", category: "apps", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_install_app", label: "Users can install apps", category: "apps", allow: 1, restrict: 0, recommended: "allow" },
  { key: "allow_uninstall_app", label: "Users can uninstall apps", category: "apps", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_android_market", label: "Play Store access", category: "apps", allow: 1, restrict: 0, recommended: "allow" },
  { key: "allow_user_add_accounts", label: "Add or remove accounts", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_date_time_change", label: "Change date and time", category: "settings", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_settings", label: "Modify device settings", category: "settings", allow: 1, restrict: 0, recommended: "allow" },
  { key: "allow_usb_media_player", label: "USB file transfer", category: "data", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_screen_capture", label: "Screenshots", category: "data", allow: 1, restrict: 0, recommended: "allow" },
  { key: "allow_sd_card", label: "SD card", category: "data", allow: 1, restrict: 0, recommended: "allow" },
  { key: "allow_usb_tethering", label: "USB tethering", category: "data", allow: 1, restrict: 0, recommended: "restrict" },
  { key: "allow_camera", label: "Camera", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { key: "allow_video_record", label: "Video recording", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { key: "allow_audio_record", label: "Audio recording", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { key: "allow_microphone", label: "Microphone", category: "hardware", allow: 1, restrict: 0, recommended: "allow" },
];

const RESTRICTION_KEYS = new Set(ANDROID_RESTRICTIONS.map((r) => r.key));

/** selection: { allow_factory_reset: "restrict", allow_camera: "allow", ... } */
export function buildRestrictionsPayload(selection: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of ANDROID_RESTRICTIONS) {
    const choice = selection[def.key];
    if (choice === undefined) continue;
    if (choice !== "allow" && choice !== "restrict") {
      fail("VALIDATION_FAILED", `${def.key} must be "allow" or "restrict"`);
    }
    out[def.key] = choice === "allow" ? def.allow : def.restrict;
  }
  const unknown = Object.keys(selection).filter((k) => !RESTRICTION_KEYS.has(k));
  if (unknown.length) fail("VALIDATION_FAILED", `Unknown restrictions: ${unknown.join(", ")}`);
  if (!Object.keys(out).length) fail("VALIDATION_FAILED", "Choose at least one restriction");
  return out;
}

export type KioskApp = { appId: string; packageName: string; name?: string };

export function buildKioskPayload(input: {
  mode: "single" | "multi";
  apps: KioskApp[];
  allowStatusBar?: boolean;
  allowHomeButton?: boolean;
  allowBackButton?: boolean;
  allowPowerButton?: boolean;
  extra?: Record<string, unknown>; // any other kiosk field from the guide, passed through as-is
}) {
  if (!input.apps.length) fail("VALIDATION_FAILED", "Kiosk needs at least one app");
  if (input.mode === "single" && input.apps.length !== 1) fail("VALIDATION_FAILED", "Single-app kiosk takes exactly one app");
  const allowed: Record<string, unknown> = {};
  for (const a of input.apps) {
    if (!/^[a-zA-Z][\w.]+$/.test(a.packageName)) fail("VALIDATION_FAILED", `Invalid package name ${a.packageName}`);
    allowed[a.appId] = {
      SHOW_APP_ICON: true,
      APP_GROUP_ID: a.appId,
      GROUP_DISPLAY_NAME: a.name ?? a.packageName,
      IDENTIFIER: a.packageName,
      APP_TYPE: 1,
      DISPLAY_IMAGE_LOC: "",
    };
  }
  // Field names below are the ones fully legible in the guide's ANDROID_KIOSK_POLICY table.
  return {
    kiosk_mode: input.mode === "single" ? 0 : 1, // 0 single app, 1 multi app
    allowed_apps: JSON.stringify(allowed), // the API expects a JSON string
    launcher_type: 2,
    screen_orientation: 2,
    allow_status_bar: input.allowStatusBar ?? false,
    allow_home_button: input.allowHomeButton ?? true,
    allow_back_button: input.allowBackButton ?? true,
    allow_power_button: input.allowPowerButton ?? true,
    ...(input.extra ?? {}),
  };
}

/** "Wipe mode": the device is fully wiped after max_failed_attempts wrong passcodes. */
export function buildPasscodePayload(input: {
  passcodeType?: number; // 2 numbers, 3 alphabets, 4 alphanumeric, 5 complex
  minLength?: number;
  maxFailedAttempts?: number; // -1 = never wipe; 4..16 = wipe after N failures
  autoLockSeconds?: number;
  maxAgeDays?: number;
  history?: number;
}) {
  const p = {
    passcode_type: input.passcodeType ?? 2,
    min_passcode_length: input.minLength ?? 6,
    max_failed_attempts: input.maxFailedAttempts ?? 10,
    auto_lock_idle_for: input.autoLockSeconds ?? 300,
    max_passcode_age: input.maxAgeDays ?? 0,
    no_of_passcode_maintained: input.history ?? 3,
  };
  if (![1, 2, 3, 4, 5].includes(p.passcode_type)) fail("VALIDATION_FAILED", "passcodeType must be 1–5");
  if (p.min_passcode_length < 4 || p.min_passcode_length > 16) fail("VALIDATION_FAILED", "minLength must be 4–16");
  if (p.max_failed_attempts !== -1 && (p.max_failed_attempts < 4 || p.max_failed_attempts > 16)) {
    fail("VALIDATION_FAILED", "maxFailedAttempts must be -1 or 4–16");
  }
  if (p.auto_lock_idle_for < 5 || p.auto_lock_idle_for > 1800) fail("VALIDATION_FAILED", "autoLockSeconds must be 5–1800");
  return p;
}

/** Enterprise Factory Reset Protection: only these Google accounts can set up a reset device. */
export function buildFrpPayload(accounts: { emailUserId: string; email: string }[]) {
  if (!accounts.length) fail("VALIDATION_FAILED", "Add at least one FRP Google account");
  return {
    efrp_details: JSON.stringify(accounts.map((a) => ({ EMAIL_USER_ID: a.emailUserId, EMAIL_ID: a.email }))),
  };
}

export function payloadNameFor(platform: "android" | "ios", purpose: Purpose): string | null {
  if (purpose === "custom") return null;
  const table = PAYLOAD[platform] as Record<string, string>;
  return table[purpose] ?? null;
}
