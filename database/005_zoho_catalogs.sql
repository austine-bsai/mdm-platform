-- =============================================================================
-- 005 — Catalogs pulled from the Zoho console on every sync
--
-- Previously the sync only pulled users / devices / groups / profiles, so
-- apps, compliance policies, and announcements managed in the Zoho console
-- were invisible here. This migration adds the mirror tables, extends the
-- sync_runs CHECK to allow the new resource keys, and extends announcements
-- so sync can tell which rows originated in Zoho vs. this platform.
-- Run after 004_zoho_ids_as_text.sql.
-- =============================================================================

begin;

-- ------------------------------------------------------------- apps catalog
create table if not exists apps (
  id             uuid primary key default gen_random_uuid(),
  enterprise_id  uuid not null references enterprises(id) on delete cascade,
  zoho_app_id    text not null,
  name           text not null,
  package_name   text,                      -- Android: com.foo.bar  / iOS: bundle id
  platform       text,                      -- ios | android | windows | chrome | macos
  app_type       text,                      -- store | enterprise | web | ...
  version        text,
  description    text,
  last_synced_at timestamptz not null default now(),
  unique (enterprise_id, zoho_app_id)
);
create index if not exists idx_apps_enterprise on apps(enterprise_id);

-- ---------------------------------------------------------- compliance policies
create table if not exists compliance_policies (
  id                    uuid primary key default gen_random_uuid(),
  enterprise_id         uuid not null references enterprises(id) on delete cascade,
  zoho_policy_id        text not null,
  name                  text not null,
  policy_type           text,               -- compliance | geofence | ...
  platform              text,
  description           text,
  raw                   jsonb,              -- full payload (rules vary a lot between policy types)
  last_synced_at        timestamptz not null default now(),
  unique (enterprise_id, zoho_policy_id)
);
create index if not exists idx_compliance_enterprise on compliance_policies(enterprise_id);

-- --------------------------------------------- announcements: mark Zoho origin
-- Existing table only tracked announcements CREATED here. Sync now pulls Zoho
-- announcements too, so we add a source column and a last_synced_at marker.
alter table announcements
  add column if not exists source text not null default 'platform'
    check (source in ('platform', 'zoho')),
  add column if not exists last_synced_at timestamptz;

comment on column announcements.source is
  'platform = created here; zoho = pulled from the Zoho console';

-- --------------------------------------- sync_runs: allow new resource names
alter table sync_runs drop constraint if exists sync_runs_resource_check;
alter table sync_runs
  add constraint sync_runs_resource_check
  check (resource in ('devices','groups','profiles','users','apps','announcements','compliance','device_details','all'));

commit;
