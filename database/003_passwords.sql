-- Per-admin password login (alternative to passwordless OTP).
-- Nullable: existing admins keep working with OTP until they set a password.
-- Format stored in password_hash: "v1:<salt b64>:<derived key b64>" (PBKDF2-SHA256, 310k iters).
alter table admins add column if not exists password_hash text;
