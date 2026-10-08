-- =============================================================================
-- 009 — Samsung Knox capability flag
-- Run after 008_safety_and_leases.sql.
--
-- Standard Android MDM does not expose shutdown / restart. Zoho surfaces those
-- only on Samsung Knox devices via a separate endpoint:
--   POST /devices/{id}/knox_actions/{action}
-- Mirroring is_knox lets the command executor route to that endpoint and lets
-- the UI stop offering shutdown on non-Knox Android devices.
--
-- Zoho reports Knox via the knox_details.knox_version field on the device
-- payload. We treat any positive knox_version as "Knox-capable".
-- =============================================================================

alter table devices
  add column if not exists is_knox boolean;

comment on column devices.is_knox is 'True when Zoho reports a positive knox_details.knox_version. Enables Knox-only actions (shutdown, restart).';
