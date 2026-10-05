-- =============================================================================
-- 002 — Monitoring: security alerts, location history, geofences
-- Run AFTER schema.sql (Supabase SQL editor).
--
-- New nodes and their foreign keys
--   monitoring_settings  1-1 enterprises       (tracking on/off, working hours, retention, thresholds)
--   alert_rules          n-1 enterprises       (per-rule enable / severity / auto-action overrides)
--   device_snapshots     1-1 devices           (last security + network values, for change detection)
--   device_locations     n-1 devices           (location history, purged after retention_days)
--   geofences            n-1 enterprises, n-1 groups (optional scope)
--   alerts               n-1 enterprises, devices, geofences, events (auto-action), admins (ack/resolve)
-- =============================================================================

create type alert_severity as enum ('info', 'warning', 'critical');
create type alert_status   as enum ('open', 'acknowledged', 'resolved');
create type geofence_kind  as enum ('allowed', 'restricted');

insert into error_codes (code, http_status, message, retryable) values
  ('TRACKING_DISABLED', 409, 'Location tracking is turned off for this enterprise.', false),
  ('CONSENT_REQUIRED',  400, 'Confirm that employees have been informed before enabling tracking.', false)
on conflict (code) do nothing;

-- -------------------------------------------------------- settings (1 per enterprise)
create table monitoring_settings (
  enterprise_id             uuid primary key references enterprises(id) on delete cascade,
  location_tracking_enabled boolean not null default false,       -- off until the owner enables it
  tracking_consent_at       timestamptz,                          -- owner confirmed employees were informed
  tracking_consent_by       uuid references admins(id) on delete set null,
  location_interval_minutes int  not null default 30 check (location_interval_minutes between 5 and 1440),
  working_hours_only        boolean not null default true,
  work_start                time not null default '08:00',
  work_end                  time not null default '18:00',
  work_days                 int[] not null default '{1,2,3,4,5}', -- 1 = Monday … 7 = Sunday
  timezone                  text not null default 'Africa/Dar_es_Salaam',
  location_retention_days   int  not null default 30 check (location_retention_days between 1 and 365),
  offline_hours             int  not null default 48 check (offline_hours between 1 and 720),
  data_spike_factor         numeric(4,1) not null default 3.0 check (data_spike_factor between 1.5 and 50),
  email_critical_alerts     boolean not null default true,
  last_location_poll_at     timestamptz,
  last_security_scan_at     timestamptz,
  updated_by                uuid references admins(id) on delete set null,
  updated_at                timestamptz not null default now()
);
create trigger trg_monitoring_settings_updated before update on monitoring_settings
  for each row execute function set_updated_at();

-- ------------------------------------------------------------- alert rules
create table alert_rules (
  id            uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  rule_key      text not null check (rule_key in (
                  'device_rooted', 'passcode_missing', 'passcode_noncompliant', 'storage_unencrypted',
                  'device_offline', 'device_unenrolled', 'data_spike',
                  'geofence_exit', 'geofence_restricted',
                  'admin_failed_logins', 'admin_new_ip', 'wipe_confirmation_failed')),
  enabled       boolean not null default true,
  severity      alert_severity not null,
  auto_action   text check (auto_action in ('lock', 'enable_lost_mode', 'remote_alarm')),
  updated_by    uuid references admins(id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (enterprise_id, rule_key)
);

-- ----------------------------------------------------------- device snapshots
create table device_snapshots (
  device_id           uuid primary key references devices(id) on delete cascade,
  enterprise_id       uuid not null references enterprises(id) on delete cascade,
  device_rooted       boolean,
  passcode_present    boolean,
  passcode_compliant  boolean,
  storage_encrypted   boolean,
  battery_level       int,
  last_contact_at     timestamptz,
  data_total          bigint,          -- cumulative mobile in+out reported by Zoho
  data_rate_baseline  double precision, -- moving average of usage per hour
  data_samples        int not null default 0,
  captured_at         timestamptz not null default now()
);
create index idx_snapshots_enterprise on device_snapshots(enterprise_id);

-- ---------------------------------------------------------- location history
create table device_locations (
  id            bigint generated always as identity primary key,
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  device_id     uuid not null references devices(id) on delete cascade,
  latitude      double precision not null check (latitude between -90 and 90),
  longitude     double precision not null check (longitude between -180 and 180),
  located_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  unique (device_id, located_at)
);
create index idx_locations_device_time on device_locations(device_id, located_at desc);
create index idx_locations_enterprise_time on device_locations(enterprise_id, located_at desc);

-- ---------------------------------------------------------------- geofences
create table geofences (
  id                uuid primary key default gen_random_uuid(),
  enterprise_id     uuid not null references enterprises(id) on delete cascade,
  group_id          uuid references groups(id) on delete cascade,   -- null = all devices
  name              text not null,
  kind              geofence_kind not null default 'allowed',
  latitude          double precision not null check (latitude between -90 and 90),
  longitude         double precision not null check (longitude between -180 and 180),
  radius_m          int not null check (radius_m between 50 and 50000),
  active_hours_only boolean not null default true,
  enabled           boolean not null default true,
  created_by        uuid references admins(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index idx_geofences_enterprise on geofences(enterprise_id) where enabled;

-- ------------------------------------------------------------------ alerts
create table alerts (
  id                   uuid primary key default gen_random_uuid(),
  enterprise_id        uuid not null references enterprises(id) on delete cascade,
  device_id            uuid references devices(id)   on delete set null,
  geofence_id          uuid references geofences(id) on delete set null,
  rule_key             text not null,
  severity             alert_severity not null,
  status               alert_status not null default 'open',
  title                text not null,
  details              jsonb not null default '{}'::jsonb,
  dedupe_key           text not null,              -- one open alert per condition
  occurrences          int not null default 1,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  auto_action_event_id uuid references events(id) on delete set null,
  acknowledged_by      uuid references admins(id) on delete set null,
  acknowledged_at      timestamptz,
  resolved_by          uuid references admins(id) on delete set null,  -- null + resolved_at = auto-resolved
  resolved_at          timestamptz,
  resolution_note      text
);
create unique index uq_alerts_open_dedupe on alerts(enterprise_id, dedupe_key) where status <> 'resolved';
create index idx_alerts_enterprise_time on alerts(enterprise_id, last_seen_at desc);
create index idx_alerts_device on alerts(device_id);

-- ---------------------------------------------------------------- functions
-- Delete location points older than each enterprise's retention period.
create or replace function purge_old_locations()
returns int
language sql as $$
  with d as (
    delete from device_locations l
     using monitoring_settings s
     where s.enterprise_id = l.enterprise_id
       and l.located_at < now() - make_interval(days => s.location_retention_days)
    returning 1
  ) select count(*)::int from d;
$$;

-- Latest point per device (for the map).
create or replace function latest_device_locations(p_enterprise uuid)
returns table (device_id uuid, latitude double precision, longitude double precision, located_at timestamptz)
language sql stable as $$
  select distinct on (device_id) device_id, latitude, longitude, located_at
    from device_locations
   where enterprise_id = p_enterprise
   order by device_id, located_at desc;
$$;

-- Overview now also reports alerts.
create or replace function enterprise_overview(p_enterprise uuid)
returns json
language sql stable as $$
  select json_build_object(
    'devices',         (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed),
    'android',         (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed and platform = 'android'),
    'ios',             (select count(*) from devices  where enterprise_id = p_enterprise and not is_removed and platform = 'ios'),
    'lost_mode',       (select count(*) from devices  where enterprise_id = p_enterprise and is_lost_mode),
    'groups',          (select count(*) from groups   where enterprise_id = p_enterprise),
    'profiles',        (select count(*) from profiles where enterprise_id = p_enterprise and state <> 'deleted'),
    'pending_events',  (select count(*) from events   where enterprise_id = p_enterprise and state in ('requested','sent','awaiting_confirmation')),
    'backlog',         (select count(*) from events   where enterprise_id = p_enterprise and state = 'dead'),
    'open_alerts',     (select count(*) from alerts   where enterprise_id = p_enterprise and status <> 'resolved'),
    'critical_alerts', (select count(*) from alerts   where enterprise_id = p_enterprise and status <> 'resolved' and severity = 'critical'),
    'last_sync',       (select max(finished_at) from sync_runs where enterprise_id = p_enterprise and status = 'succeeded')
  );
$$;

-- Settings row for every existing enterprise (new ones get it at registration).
insert into monitoring_settings (enterprise_id) select id from enterprises on conflict do nothing;

alter table monitoring_settings enable row level security;
alter table alert_rules         enable row level security;
alter table device_snapshots    enable row level security;
alter table device_locations    enable row level security;
alter table geofences           enable row level security;
alter table alerts              enable row level security;

revoke execute on function purge_old_locations()           from public, anon, authenticated;
revoke execute on function latest_device_locations(uuid)   from public, anon, authenticated;
revoke execute on function enterprise_overview(uuid)       from public, anon, authenticated;
grant  execute on function purge_old_locations()                to service_role;
grant  execute on function latest_device_locations(uuid)        to service_role;
grant  execute on function enterprise_overview(uuid)            to service_role;
