// Small function-based validators for request bodies.
import { fail } from "./errors.ts";

export type Body = Record<string, unknown>;

export async function readJson(req: Request): Promise<Body> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      fail("VALIDATION_FAILED", "Body must be a JSON object");
    }
    return body as Body;
  } catch (e) {
    if ((e as { isAppError?: boolean }).isAppError) throw e;
    fail("VALIDATION_FAILED", "Invalid JSON body");
  }
}

export function str(body: Body, key: string, opts: { required?: boolean; max?: number; min?: number } = {}): string {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required !== false) fail("VALIDATION_FAILED", `${key} is required`, { field: key });
    return "";
  }
  if (typeof v !== "string") fail("VALIDATION_FAILED", `${key} must be text`, { field: key });
  const s = v.trim();
  if (opts.max && s.length > opts.max) fail("VALIDATION_FAILED", `${key} is too long`, { field: key });
  if (opts.min && s.length < opts.min) fail("VALIDATION_FAILED", `${key} is too short`, { field: key });
  return s;
}

export function email(body: Body, key = "email"): string {
  const s = str(body, key, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail("VALIDATION_FAILED", `${key} is not a valid email`, { field: key });
  return s;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], fallback?: T): T {
  const v = body[key];
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail("VALIDATION_FAILED", `${key} must be one of: ${allowed.join(", ")}`, { field: key });
  }
  return v as T;
}

export function uuidList(body: Body, key: string, opts: { min?: number; max?: number } = {}): string[] {
  const v = body[key];
  if (!Array.isArray(v)) fail("VALIDATION_FAILED", `${key} must be a list`, { field: key });
  const ids = v.map(String);
  if (ids.some((id) => !isUuid(id))) fail("VALIDATION_FAILED", `${key} contains an invalid id`, { field: key });
  if (opts.min !== undefined && ids.length < opts.min) fail("VALIDATION_FAILED", `${key} needs at least ${opts.min} item(s)`);
  if (opts.max !== undefined && ids.length > opts.max) fail("VALIDATION_FAILED", `${key} allows at most ${opts.max} items`);
  return [...new Set(ids)];
}

export function obj(body: Body, key: string, required = false): Body {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) fail("VALIDATION_FAILED", `${key} is required`, { field: key });
    return {};
  }
  if (typeof v !== "object" || Array.isArray(v)) fail("VALIDATION_FAILED", `${key} must be an object`, { field: key });
  return v as Body;
}

export function bool(body: Body, key: string, fallback = false): boolean {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") fail("VALIDATION_FAILED", `${key} must be true or false`, { field: key });
  return v;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function uuidParam(value: string | undefined, name = "id"): string {
  if (!value || !isUuid(value)) fail("VALIDATION_FAILED", `${name} is not a valid id`);
  return value;
}
