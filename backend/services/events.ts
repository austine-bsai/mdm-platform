// Events = audit log + operation queue + failure backlog (see database/schema.sql).
//
//   awaiting_confirmation -> requested -> sent -> acknowledged -> succeeded
//                                     \-> failed | dead (backlog) | cancelled
//
// Every change made in Zoho goes through submitOperation(): the event row is written
// first (idempotency key, locked for this process), then executed inline. Retryable
// failures are rescheduled with exponential backoff and picked up by the worker.
import { db, run, runMaybe } from "../lib/db.ts";
import { type AppError, appError, ERROR_CATALOG, type ErrorCode, fail, toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";

export type EventState =
  | "awaiting_confirmation"
  | "requested"
  | "sent"
  | "acknowledged"
  | "succeeded"
  | "failed"
  | "dead"
  | "cancelled";

export type Category = "command" | "group" | "profile" | "announcement" | "sync" | "auth" | "zoho";

export type EventRow = {
  id: string;
  enterprise_id: string;
  admin_id: string | null;
  category: Category;
  action: string;
  state: EventState;
  idempotency_key: string | null;
  device_id: string | null;
  group_id: string | null;
  profile_id: string | null;
  announcement_id: string | null;
  params: Record<string, unknown>;
  response: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  confirm_code_hash: string | null;
  confirm_expires_at: string | null;
  action_time: string;
  sent_at: string | null;
  completed_at: string | null;
};

export type NewEvent = {
  enterpriseId: string;
  adminId?: string | null;
  category: Category;
  action: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string | null;
  deviceId?: string | null;
  groupId?: string | null;
  profileId?: string | null;
  announcementId?: string | null;
  state?: EventState;
  confirmCodeHash?: string;
  confirmExpiresAt?: Date;
  maxAttempts?: number;
};

export type ExecResult = { state: "succeeded" | "sent"; response?: Record<string, unknown> };
export type Executor = (ev: EventRow) => Promise<ExecResult>;

const executors = new Map<string, Executor>();

/** Executors are registered by action name (e.g. "group.create", "command.lock"). */
export function registerExecutor(action: string, fn: Executor) {
  executors.set(action, fn);
}

export function hasExecutor(action: string) {
  return executors.has(action);
}

// ------------------------------------------------------------------ audit
/** Record something that already happened (login, sync, view of location...). */
export async function recordAudit(e: NewEvent & { state?: EventState }): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db().from("events").insert({
    enterprise_id: e.enterpriseId,
    admin_id: e.adminId ?? null,
    category: e.category,
    action: e.action,
    params: e.params ?? {},
    state: e.state ?? "succeeded",
    device_id: e.deviceId ?? null,
    group_id: e.groupId ?? null,
    profile_id: e.profileId ?? null,
    announcement_id: e.announcementId ?? null,
    completed_at: now,
  });
  if (error) log("error", "audit.write_failed", { action: e.action, error: error.message });
}

// ------------------------------------------------------------------ queue
/** Insert an event; if the idempotency key was already used, return the original instead. */
export async function createEvent(e: NewEvent): Promise<{ event: EventRow; duplicate: boolean }> {
  if (e.idempotencyKey) {
    const existing = await runMaybe<EventRow>(
      db().from("events").select("*").eq("enterprise_id", e.enterpriseId)
        .eq("idempotency_key", e.idempotencyKey).maybeSingle(),
    );
    if (existing) return { event: existing, duplicate: true };
  }
  if (!hasExecutor(e.action)) fail("VALIDATION_FAILED", `No executor for ${e.action}`);
  try {
    const event = await run<EventRow>(
      db().from("events").insert({
        enterprise_id: e.enterpriseId,
        admin_id: e.adminId ?? null,
        category: e.category,
        action: e.action,
        params: e.params ?? {},
        idempotency_key: e.idempotencyKey ?? null,
        device_id: e.deviceId ?? null,
        group_id: e.groupId ?? null,
        profile_id: e.profileId ?? null,
        announcement_id: e.announcementId ?? null,
        state: e.state ?? "requested",
        max_attempts: e.maxAttempts ?? 5,
        confirm_code_hash: e.confirmCodeHash ?? null,
        confirm_expires_at: e.confirmExpiresAt?.toISOString() ?? null,
        // Lock for this process so the worker does not pick it up while we run it inline.
        locked_until: new Date(Date.now() + 120_000).toISOString(),
      }).select("*").single(),
    );
    return { event, duplicate: false };
  } catch (err) {
    // Two identical requests raced: return the winner.
    if (e.idempotencyKey && (err as AppError).code === "CONFLICT") {
      const existing = await run<EventRow>(
        db().from("events").select("*").eq("enterprise_id", e.enterpriseId).eq("idempotency_key", e.idempotencyKey).single(),
      );
      return { event: existing, duplicate: true };
    }
    throw err;
  }
}

export function backoffMs(attempt: number): number {
  // 30s, 1m, 2m, 4m ... capped at 30 minutes, with ±20% jitter.
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Run an event's executor and persist the outcome. Never throws. */
export async function processEvent(ev: EventRow): Promise<EventRow> {
  const exec = executors.get(ev.action);
  const attempts = ev.attempts + 1;
  if (!exec) {
    return await updateEvent(ev.id, {
      state: "failed",
      error_code: "INTERNAL",
      error_message: `No executor for ${ev.action}`,
      attempts,
      locked_until: null,
      completed_at: new Date().toISOString(),
    });
  }
  try {
    const result = await exec({ ...ev, attempts });
    const now = new Date().toISOString();
    return await updateEvent(ev.id, {
      state: result.state,
      response: { ...(ev.response ?? {}), ...(result.response ?? {}) },
      attempts,
      error_code: null,
      error_message: null,
      sent_at: ev.sent_at ?? now,
      completed_at: result.state === "succeeded" ? now : null,
      // "sent" commands are polled for acknowledgement starting in 30 s
      next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
      locked_until: null,
    });
  } catch (e) {
    const err = toAppError(e);
    const exhausted = attempts >= ev.max_attempts;
    const state: EventState = err.retryable ? (exhausted ? "dead" : "requested") : "failed";
    log(state === "requested" ? "warn" : "error", "event.failed", {
      event_id: ev.id,
      action: ev.action,
      code: err.code,
      attempts,
      state,
    });
    return await updateEvent(ev.id, {
      state,
      attempts,
      error_code: err.retryable && exhausted ? "MAX_RETRIES_EXCEEDED" : err.code,
      error_message: err.message.slice(0, 1000),
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      locked_until: null,
      completed_at: state === "requested" ? null : new Date().toISOString(),
    });
  }
}

export async function updateEvent(id: string, patch: Partial<EventRow>): Promise<EventRow> {
  return await run<EventRow>(db().from("events").update(patch).eq("id", id).select("*").single());
}

/** Create + execute now. Returns the event in its resulting state. */
export async function submitOperation(e: NewEvent): Promise<{ event: EventRow; duplicate: boolean }> {
  const { event, duplicate } = await createEvent(e);
  if (duplicate || event.state !== "requested") return { event, duplicate };
  return { event: await processEvent(event), duplicate: false };
}

/** Throw the stored error of a failed event so the HTTP layer reports it. */
export function raiseIfFailed(ev: EventRow): EventRow {
  if (ev.state === "failed" || ev.state === "dead") {
    const code = (ev.error_code && ev.error_code in ERROR_CATALOG ? ev.error_code : "INTERNAL") as ErrorCode;
    throw appError(code, ev.error_message ?? undefined, { event_id: ev.id });
  }
  return ev;
}

// -------------------------------------------------------------- backlog ops
export async function retryEvent(enterpriseId: string, id: string): Promise<EventRow> {
  const ev = await run<EventRow>(db().from("events").select("*").eq("id", id).eq("enterprise_id", enterpriseId).single());
  if (!["dead", "failed"].includes(ev.state)) fail("CONFLICT", "Only failed or backlog events can be retried");
  const reset = await updateEvent(id, {
    state: "requested",
    attempts: 0,
    error_code: null,
    error_message: null,
    completed_at: null,
    next_attempt_at: new Date().toISOString(),
    locked_until: new Date(Date.now() + 120_000).toISOString(),
  });
  return await processEvent(reset);
}

export async function cancelEvent(enterpriseId: string, id: string): Promise<EventRow> {
  const ev = await run<EventRow>(db().from("events").select("*").eq("id", id).eq("enterprise_id", enterpriseId).single());
  if (!["awaiting_confirmation", "requested", "dead", "failed"].includes(ev.state)) {
    fail("CONFLICT", "This event can no longer be cancelled");
  }
  // A worker is sending it to Zoho right now: cancelling would hide a command that may already be out.
  if (ev.state === "requested" && ev.locked_until && Date.parse(ev.locked_until) > Date.now()) {
    fail("CONFLICT", "This is being sent to Zoho right now and can't be cancelled");
  }
  return await updateEvent(id, { state: "cancelled", completed_at: new Date().toISOString(), locked_until: null });
}

/**
 * Cancel every event still queued or in the backlog for a device.
 * Only touches events in states we can still influence (awaiting_confirmation, requested, dead).
 * Events already `sent` have been accepted by Zoho and cannot be recalled.
 * Returns the number of events cancelled, broken down by state.
 */
export async function clearDeviceCommands(enterpriseId: string, deviceId: string): Promise<{ cancelled: number; by_state: Record<string, number> }> {
  const cancellable: EventState[] = ["awaiting_confirmation", "requested", "dead"];
  const pending = await run<EventRow[]>(
    db().from("events").select("*")
      .eq("enterprise_id", enterpriseId)
      .eq("device_id", deviceId)
      .in("state", cancellable),
  );
  if (!pending.length) return { cancelled: 0, by_state: {} };
  const now = new Date().toISOString();
  await run(
    db().from("events")
      .update({ state: "cancelled", completed_at: now, locked_until: null, error_code: null, error_message: "Cleared by admin" })
      .in("id", pending.map((e) => e.id)),
  );
  const by_state: Record<string, number> = {};
  for (const e of pending) by_state[e.state] = (by_state[e.state] ?? 0) + 1;
  return { cancelled: pending.length, by_state };
}

export async function claimDue(states: EventState[], limit = 20): Promise<EventRow[]> {
  return (await run<EventRow[]>(db().rpc("claim_due_events", { p_states: states, p_limit: limit }))) ?? [];
}
