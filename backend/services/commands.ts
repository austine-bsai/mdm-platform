// Device commands: catalogue, role rules, two-step confirmation and acknowledgement tracking.
import { getConfig } from "../config.ts";
import { db } from "../lib/db.ts";
import { randomDigits, safeEqual } from "../lib/crypto.ts";
import { fail } from "../lib/errors.ts";
import { getCommandHistory, runDeviceAction } from "../zoho/api.ts";
import type { Role, Session } from "./auth.ts";
import { hashConfirmCode } from "./auth.ts";
import { confirmMail, sendMail } from "./mail.ts";
import {
  createEvent,
  type EventRow,
  processEvent,
  recordAudit,
  registerExecutor,
  updateEvent,
} from "./events.ts";
import { getDevice, getDevices } from "./lookup.ts";
import { raiseAlert } from "./monitoring.ts";

type ActionDef = {
  label: string;
  minRole: Role;
  confirm: boolean; // two-step confirmation (typed device name + emailed code)
  params: readonly string[]; // allowed body fields for Zoho
  history: RegExp; // how the command shows up in Zoho command history
};

// Action names from the guide: POST /devices/{id}/actions/{action_name}
export const DEVICE_ACTIONS: Record<string, ActionDef> = {
  scan: { label: "Scan / refresh inventory", minRole: "admin", confirm: false, params: [], history: /scan/i },
  lock: { label: "Lock device", minRole: "admin", confirm: false, params: ["lock_message"], history: /lock/i },
  remote_alarm: { label: "Ring alarm", minRole: "admin", confirm: false, params: [], history: /alarm/i },
  fetch_location: { label: "Fetch location", minRole: "admin", confirm: false, params: [], history: /locat/i },
  restart: { label: "Restart", minRole: "admin", confirm: false, params: [], history: /restart|reboot/i },
  shutdown: { label: "Shut down", minRole: "admin", confirm: false, params: [], history: /shut/i },
  enable_lost_mode: {
    label: "Enable lost mode",
    minRole: "admin",
    confirm: false,
    params: ["lock_message", "phone_number", "send_email_to_user", "audit_message"],
    history: /lost/i,
  },
  disable_lost_mode: { label: "Disable lost mode", minRole: "admin", confirm: false, params: [], history: /lost/i },
  pause_kiosk: { label: "Pause kiosk", minRole: "admin", confirm: false, params: ["re_enter_time"], history: /kiosk/i },
  re_apply_kiosk: { label: "Re-apply kiosk", minRole: "admin", confirm: false, params: [], history: /kiosk/i },
  reset_passcode: {
    label: "Reset passcode",
    minRole: "admin",
    confirm: true,
    params: ["passcode", "email_sent_to_user", "email_sent_to_admin"],
    history: /pass/i,
  },
  clear_passcode: { label: "Clear passcode", minRole: "admin", confirm: true, params: [], history: /pass/i },
  corporate_wipe: { label: "Corporate wipe (work data only)", minRole: "owner", confirm: true, params: [], history: /wipe|corporate/i },
  complete_wipe: {
    label: "Complete wipe (erase everything)",
    minRole: "owner",
    confirm: true,
    params: ["wipe_sd_card", "wipe_but_retain_mdm"],
    history: /wipe/i,
  },
};

const ROLE_RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

function pickParams(def: ActionDef, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of def.params) if (params[k] !== undefined) out[k] = params[k];
  const extra = Object.keys(params).filter((k) => !def.params.includes(k));
  if (extra.length) fail("VALIDATION_FAILED", `Unsupported parameters: ${extra.join(", ")}`);
  return out;
}

/** Step 1. Non-destructive actions run now; destructive ones wait for confirmCommand(). */
export async function requestCommand(session: Session, input: {
  deviceIds: string[];
  action: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
}): Promise<EventRow[]> {
  const def = DEVICE_ACTIONS[input.action];
  if (!def) fail("COMMAND_UNKNOWN");
  if (!roleAtLeast(session.role, def.minRole)) fail("AUTH_FORBIDDEN", `${def.label} needs the ${def.minRole} role`);
  if (def.confirm && input.deviceIds.length !== 1) {
    fail("VALIDATION_FAILED", `${def.label} can only target one device at a time`);
  }
  const params = pickParams(def, input.params);
  const devices = await getDevices(session.enterpriseId, input.deviceIds);
  const cfg = getConfig();
  const results: EventRow[] = [];

  for (const device of devices) {
    if (device.is_removed) fail("CONFLICT", `${device.device_name ?? device.id} is no longer enrolled`);
    const base = {
      enterpriseId: session.enterpriseId,
      adminId: session.adminId,
      category: "command" as const,
      action: `command.${input.action}`,
      params,
      deviceId: device.id,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${device.id}` : null,
      maxAttempts: 4,
    };

    if (def.confirm) {
      const code = randomDigits(6);
      const { event, duplicate } = await createEvent({
        ...base,
        state: "awaiting_confirmation",
        confirmCodeHash: await hashConfirmCode(`${session.adminId}:${device.id}`, code),
        confirmExpiresAt: new Date(Date.now() + cfg.confirmTtlMinutes * 60_000),
      });
      if (!duplicate) {
        await updateEvent(event.id, { locked_until: null });
        await sendMail(confirmMail(session.email, code, def.label, device.device_name ?? String(device.zoho_device_id), cfg.confirmTtlMinutes));
      }
      results.push(event);
      continue;
    }

    const { event, duplicate } = await createEvent(base);
    results.push(duplicate ? event : await processEvent(event));
  }
  return results;
}

/** Step 2. The requester types the exact device name and the emailed code. */
export async function confirmCommand(session: Session, eventId: string, input: { code: string; deviceName: string }) {
  const ev = (await db().from("events").select("*").eq("id", eventId).eq("enterprise_id", session.enterpriseId)
    .maybeSingle()).data as EventRow | null;
  if (!ev || ev.category !== "command") fail("NOT_FOUND");
  if (ev.state !== "awaiting_confirmation") fail("CONFLICT", `Event is ${ev.state}`);
  if (ev.admin_id !== session.adminId) fail("AUTH_FORBIDDEN", "Only the admin who requested this can confirm it");
  if (!ev.confirm_expires_at || Date.parse(ev.confirm_expires_at) < Date.now()) {
    await updateEvent(ev.id, { state: "cancelled", error_code: "COMMAND_CONFIRMATION_EXPIRED", completed_at: new Date().toISOString() });
    fail("COMMAND_CONFIRMATION_EXPIRED");
  }
  const device = await getDevice(session.enterpriseId, ev.device_id!);
  const tries = Number((ev.response as { confirm_tries?: number } | null)?.confirm_tries ?? 0) + 1;
  const nameOk = (device.device_name ?? String(device.zoho_device_id)).trim().toLowerCase() ===
    input.deviceName.trim().toLowerCase();
  const codeOk = safeEqual(await hashConfirmCode(`${session.adminId}:${device.id}`, input.code), ev.confirm_code_hash ?? "");

  if (!nameOk || !codeOk) {
    const cancel = tries >= 5;
    await updateEvent(ev.id, {
      response: { ...(ev.response ?? {}), confirm_tries: tries },
      ...(cancel ? { state: "cancelled", error_code: "COMMAND_CONFIRMATION_INVALID", completed_at: new Date().toISOString() } : {}),
    });
    if (cancel) {
      await raiseAlert({
        enterpriseId: session.enterpriseId,
        ruleKey: "wipe_confirmation_failed",
        dedupeKey: `wipe_confirm:${ev.id}`,
        deviceId: device.id,
        title: `${session.email} failed to confirm "${ev.action.replace("command.", "")}" on ${device.device_name ?? device.id} 5 times`,
        details: { event_id: ev.id, admin: session.email },
      });
    }
    fail("COMMAND_CONFIRMATION_INVALID", cancel ? "Too many wrong attempts; request cancelled" : undefined);
  }

  const ready = await updateEvent(ev.id, {
    state: "requested",
    confirm_code_hash: null,
    locked_until: new Date(Date.now() + 120_000).toISOString(),
    response: { ...(ev.response ?? {}), confirmed_at: new Date().toISOString() },
  });
  return await processEvent(ready);
}

// ------------------------------------------------------------- executors
for (const action of Object.keys(DEVICE_ACTIONS)) {
  registerExecutor(`command.${action}`, async (ev) => {
    const device = await getDevice(ev.enterprise_id, ev.device_id!);
    const zoho = await runDeviceAction(ev.enterprise_id, device.zoho_device_id, action, ev.params);
    return { state: "sent", response: { zoho_send: zoho ?? { status: "accepted" } } };
  });
}

// ------------------------------------------------------ acknowledgement poll
type HistoryCommand = { command_name?: string; added_time?: number; command_status?: number; remarks?: string; command_life?: { status_description?: string; status_code?: number }[] };

const MAX_POLLS = 40;

function classify(cmd: HistoryCommand): "succeeded" | "failed" | "acknowledged" {
  const life = cmd.command_life ?? [];
  const last = life[life.length - 1];
  const text = `${last?.status_description ?? ""} ${cmd.remarks ?? ""}`;
  if (/success|completed/i.test(text) || cmd.command_status === 2) return "succeeded";
  if (/fail|error|not supported|not compatible/i.test(text)) return "failed";
  return "acknowledged";
}

/** Called by the worker for events in state "sent". */
export async function pollCommandStatus(ev: EventRow): Promise<void> {
  const action = ev.action.replace(/^command\./, "");
  const def = DEVICE_ACTIONS[action];
  const polls = Number((ev.response as { polls?: number } | null)?.polls ?? 0) + 1;
  const device = await getDevice(ev.enterprise_id, ev.device_id!);

  const history = await getCommandHistory(ev.enterprise_id, device.zoho_device_id, { days: 2, limit: 25 });
  const commands = ((history as { commands?: HistoryCommand[] }).commands ?? [])
    .filter((c) => (c.added_time ?? 0) >= Date.parse(ev.sent_at ?? ev.action_time) - 120_000)
    .filter((c) => !def || def.history.test(c.command_name ?? ""))
    .sort((a, b) => (b.added_time ?? 0) - (a.added_time ?? 0));

  const match = commands[0];
  const outcome = match ? classify(match) : null;
  const response = { ...(ev.response ?? {}), polls, zoho_status: match ?? null };

  if (outcome === "succeeded" || outcome === "failed") {
    await updateEvent(ev.id, {
      state: outcome,
      response,
      completed_at: new Date().toISOString(),
      error_code: outcome === "failed" ? "ZOHO_BAD_REQUEST" : null,
      error_message: outcome === "failed" ? (match?.remarks ?? "Device reported failure") : null,
      locked_until: null,
    });
    if (outcome === "succeeded") await applyLocalEffects(ev, device.id);
    return;
  }
  // Still waiting (device offline or command queued). Poll less often over time; stop after MAX_POLLS.
  const waitMs = Math.min(60_000 * polls, 30 * 60_000);
  await updateEvent(ev.id, {
    state: outcome === "acknowledged" ? "acknowledged" : "sent",
    response,
    next_attempt_at: new Date(Date.now() + (polls >= MAX_POLLS ? 365 * 86400_000 : waitMs)).toISOString(),
    error_message: polls >= MAX_POLLS ? "No final status from the device yet; check the device in Zoho." : null,
    locked_until: null,
  });
}

async function applyLocalEffects(ev: EventRow, deviceId: string) {
  if (ev.action === "command.enable_lost_mode") await db().from("devices").update({ is_lost_mode: true }).eq("id", deviceId);
  if (ev.action === "command.disable_lost_mode") await db().from("devices").update({ is_lost_mode: false }).eq("id", deviceId);
  if (ev.action === "command.complete_wipe") {
    await recordAudit({ enterpriseId: ev.enterprise_id, category: "command", action: "device.wiped", deviceId });
  }
}
