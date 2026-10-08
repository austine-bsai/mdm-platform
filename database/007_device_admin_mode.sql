-- =============================================================================
-- 007 — Device management-mode mirroring (admin badge in dashboard)
-- Run after 006_device_contact.sql.
--
-- Zoho reports a device's management authority via these fields on
-- GET /devices and GET /devices/{id}:
--   is_supervised  — true when the agent has fully-managed authority (device owner)
--   is_profileowner — true when the agent only controls the work-profile container
-- Mirroring these lets the dashboard show a "mode" badge so admins can tell at a
-- glance why a given profile might not enforce on a given device.
-- =============================================================================

alter table devices
  add column if not exists is_supervised  boolean,
  add column if not exists is_profileowner boolean;

comment on column devices.is_supervised  is 'Zoho is_supervised. True = agent has device-wide authority.';
comment on column devices.is_profileowner is 'Zoho is_profileowner. True = agent limited to work-profile container only.';
