// Supabase client (service role, server-side only) + result helpers.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config.ts";
import { fail } from "./errors.ts";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const cfg = getConfig();
  client = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** For tests: inject a fake client. */
export function setDb(fake: SupabaseClient | null) {
  client = fake;
}

type PgError = { code?: string; message: string; details?: string } | null;
type Result<T> = { data: T | null; error: PgError };

/** Unwrap a Supabase result, mapping Postgres errors to app error codes. */
export async function run<T>(query: PromiseLike<Result<T>>): Promise<T> {
  const { data, error } = await query;
  if (error) {
    if (error.code === "23505") fail("CONFLICT", "Already exists", { db: error.details });
    if (error.code === "23503") fail("VALIDATION_FAILED", "Referenced item does not exist", { db: error.details });
    if (error.code === "PGRST116") fail("NOT_FOUND");
    fail("INTERNAL", `Database error: ${error.message}`);
  }
  return data as T;
}

/** Like run(), but returns null instead of throwing when no row matched. */
export async function runMaybe<T>(query: PromiseLike<Result<T>>): Promise<T | null> {
  const { data, error } = await query;
  if (error && error.code !== "PGRST116") return run(Promise.resolve({ data, error }));
  return (data ?? null) as T | null;
}
