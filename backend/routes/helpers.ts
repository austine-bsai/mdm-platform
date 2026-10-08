import type { Context } from "hono";
import type { EventRow } from "../services/events.ts";
import type { Role } from "../services/auth.ts";

/** 200 when finished, 202 when queued / waiting on the device / awaiting confirmation. */
export function eventResponse(c: Context, event: EventRow | EventRow[], extra: Record<string, unknown> = {}) {
  const list = Array.isArray(event) ? event : [event];
  const pending = list.some((e) => ["requested", "sent", "acknowledged", "awaiting_confirmation"].includes(e.state));
  const data = { ...extra, events: list.map(publicEvent) };
  return c.json({ data }, pending ? 202 : 200);
}

export function publicEvent(e: EventRow) {
  const { confirm_code_hash: _h, locked_until: _l, ...rest } = e;
  return { ...rest, params: redactParams(rest.params as Record<string, unknown> | null) };
}

// Secrets never leave the server; contact details only for owners/admins.
const SECRET_KEY = /passcode|password|secret|token|_enc$/i;
const CONTACT_KEY = /phone|email_address|user_email/i;

export function redactParams(p: Record<string, unknown> | null | undefined, role: Role = "admin") {
  if (!p || typeof p !== "object") return p ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (SECRET_KEY.test(k)) out[k.replace(/_enc$/, "")] = "[hidden]";
    else if (role === "viewer" && CONTACT_KEY.test(k)) out[k] = "[hidden]";
    else out[k] = v;
  }
  return out;
}

export function redactEvents<T extends Record<string, unknown>>(rows: T[], role: Role): T[] {
  return rows.map((r) => ("params" in r ? { ...r, params: redactParams(r.params as Record<string, unknown>, role) } : r));
}

const mask = (v: unknown) => (v ? `••••${String(v).slice(-4)}` : null);

/** Personal / asset identifiers are only shown in full to owners and admins. */
export function maskDevice<T extends Record<string, unknown>>(d: T, role: Role): T {
  if (role !== "viewer") return d;
  return { ...d, imei: mask(d.imei), serial_number: mask(d.serial_number) };
}

export function intQuery(v: string | undefined, fallback: number, max: number) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
