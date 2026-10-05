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
  return rest;
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
