-- Zoho IDs (device_id, group_id, profile_id, announcement_id, user_id) are 18-digit
-- values that exceed JavaScript's Number.MAX_SAFE_INTEGER (2^53 - 1). The Supabase JS
-- client deserialises Postgres `bigint` as a JS number, which silently truncates the
-- last few digits — e.g. 247008000000135004 becomes 247008000000135000. Every write
-- back to Zoho using those truncated IDs 404s. Storing them as text preserves exact
-- values round-trip.
--
-- Existing mirror data is corrupted and unrecoverable (IDs collide after rounding),
-- so clear it. The next sync re-fetches it correctly. Enterprise, admins, sessions,
-- zoho_connections, monitoring settings are preserved.
--
-- Monitoring tables (device_alerts / device_snapshots / device_locations) may or may
-- not exist depending on whether 002_monitoring.sql has been applied; the DO block
-- below truncates only the tables that exist.

begin;

-- 1. Clear corrupted mirror data (preserve tenant / auth / connection rows).
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'announcement_targets','announcements',
    'profile_groups','profiles',
    'group_devices','groups',
    'device_alerts','device_snapshots','device_locations',
    'devices','mdm_users',
    'sync_runs'
  ]
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = tbl) then
      execute format('truncate table public.%I restart identity cascade', tbl);
    end if;
  end loop;
end $$;

-- Events reference the above via FKs; keep auth/zoho events, drop the rest.
delete from events
 where device_id is not null
    or group_id is not null
    or profile_id is not null
    or announcement_id is not null;

-- 2. Drop and re-add the unique composites that reference the columns.
alter table devices       drop constraint if exists devices_enterprise_id_zoho_device_id_key;
alter table groups        drop constraint if exists groups_enterprise_id_zoho_group_id_key;
alter table profiles      drop constraint if exists profiles_enterprise_id_zoho_profile_id_key;
alter table announcements drop constraint if exists announcements_enterprise_id_zoho_announcement_id_key;
alter table mdm_users     drop constraint if exists mdm_users_enterprise_id_zoho_user_id_key;

-- 3. Convert bigint → text. Tables are empty, so the `using` cast is trivial.
alter table devices       alter column zoho_device_id       type text using zoho_device_id::text;
alter table groups        alter column zoho_group_id        type text using zoho_group_id::text;
alter table profiles      alter column zoho_profile_id      type text using zoho_profile_id::text;
alter table announcements alter column zoho_announcement_id type text using zoho_announcement_id::text;
alter table mdm_users     alter column zoho_user_id         type text using zoho_user_id::text;

-- 4. Re-add the composite unique constraints.
alter table devices       add unique (enterprise_id, zoho_device_id);
alter table groups        add unique (enterprise_id, zoho_group_id);
alter table profiles      add unique (enterprise_id, zoho_profile_id);
alter table announcements add unique (enterprise_id, zoho_announcement_id);
alter table mdm_users     add unique (enterprise_id, zoho_user_id);

commit;
