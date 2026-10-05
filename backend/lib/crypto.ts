// Encryption for Zoho secrets at rest, hashing for OTPs/session tokens.
import { getConfig } from "../config.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
let aesKey: CryptoKey | null = null;
let hmacKey: CryptoKey | null = null;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAesKey(): Promise<CryptoKey> {
  if (aesKey) return aesKey;
  const raw = fromBase64(getConfig().encryptionKey);
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64). Run: deno task keygen");
  aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return aesKey;
}

async function getHmacKey(): Promise<CryptoKey> {
  if (hmacKey) return hmacKey;
  hmacKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(getConfig().hashPepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hmacKey;
}

/** AES-256-GCM. Output: "v1:<iv b64>:<ciphertext b64>" */
export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getAesKey(), enc.encode(plain)),
  );
  return `v1:${toBase64(iv)}:${toBase64(ct)}`;
}

export async function decryptSecret(blob: string): Promise<string> {
  const [v, ivB64, ctB64] = blob.split(":");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("Unsupported secret format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) },
    await getAesKey(),
    fromBase64(ctB64),
  );
  return dec.decode(pt);
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function randomDigits(length = 6): string {
  const max = 10 ** length;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % max).padStart(length, "0");
}

export async function sha256Hex(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keyed hash for short secrets (OTP, confirmation codes) so a DB leak can't be brute-forced offline. */
export async function hmacHex(value: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await getHmacKey(), enc.encode(value)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, hash: "SHA-256", iterations: PBKDF2_ITERATIONS },
    base,
    PBKDF2_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** PBKDF2-SHA256. Output: "v1:<salt b64>:<derived key b64>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(PBKDF2_SALT_BYTES)));
  const key = await pbkdf2(password, salt);
  return `v1:${toBase64(salt)}:${toBase64(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [v, saltB64, keyB64] = stored.split(":");
  if (v !== "v1" || !saltB64 || !keyB64) return false;
  const key = await pbkdf2(password, fromBase64(saltB64));
  return safeEqual(toBase64(key), keyB64);
}
