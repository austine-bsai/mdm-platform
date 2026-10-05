-- =============================================================================
-- 003 — Profile ↔ group links made in the Zoho console
-- Run after schema.sql and 002_monitoring.sql.
--
-- The MDM API documents POST/DELETE /groups/{id}/profiles but no GET, so a
-- profile assigned to a group in the Zoho console was never pulled in.
-- Sync now records where each link came from:
--   platform  assigned from this console
--   zoho      read directly from Zoho (GET /groups/{id}/profiles, when available)
--   inferred  every device in the group reports the profile (GET /devices/{id}/profiles)
-- =============================================================================

alter table profile_groups
  add column if not exists source text not null default 'platform'
    check (source in ('platform', 'zoho', 'inferred')),
  add column if not exists last_seen_at timestamptz;

comment on column profile_groups.source is
  'platform = assigned here; zoho = read from Zoho group; inferred = present on every member device';
