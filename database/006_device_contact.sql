-- =============================================================================
-- 006 — Device last-contact tracking (stale/zombie detection)
-- Run after schema.sql and earlier migrations.
--
-- Zoho reports when each device last contacted the MDM server as
-- `last_contact_time` on GET /devices/{id}. We mirror it so the dashboard can:
--   * flag devices as "stale" when they haven't checked in recently
--   * auto-mark zombies (unregistered or long-silent) as is_removed=true in sync
-- =============================================================================

alter table devices
  add column if not exists last_contact_at timestamptz;

comment on column devices.last_contact_at is
  'Last time Zoho saw the device check in. Older than SYNC env ZOMBIE_DAYS → auto-removed.';

create index if not exists idx_devices_last_contact
  on devices (enterprise_id, last_contact_at) where is_removed = false;
