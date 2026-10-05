// Structured JSON logs with secret redaction.

type Level = "debug" | "info" | "warn" | "error";
const SECRET_KEY = /token|secret|password|authorization|code_hash|otp|cookie|imei|serial/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
