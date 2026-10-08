-- =============================================================================
-- 008 — Safety fixes from the live end-to-end test (run after 001–007)
--
--   1. Row-level security on the two tables 005 forgot (apps, compliance_policies).
--   2. Worker leases: one sync / one monitoring pass per enterprise at a time,
--      across every process (inline worker, `deno task worker`, Sync button, scripts).
--   3. Backlog = failed or dead operations, not audit rows such as failed logins.
--   4. Scrub plain-text passcodes left in old event rows.
--   5. Indexes for the worker's queue queries.
-- Safe to run more than once.
-- =============================================================================

-- 1) RLS ----------------------------------------------------------------------
alter table if exists apps                enable row level security;
alter table if exists compliance_policies enable row level security;

-- 2) Leases -------------------------------------------------------------------
create table if not exists worker_leases (
  name        text primary key,              -- e.g. 'sync:<enterprise id>'
  holder      text not null,                 -- process id that owns it
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table worker_leases enable row level security;

-- Take (or renew) a lease. True when this holder owns it afterwards.
-- A lease whose holder crashed simply expires after p_ttl_seconds.
create or replace function acquire_lease(p_name text, p_holder text, p_ttl_seconds int)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into worker_leases as l (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set holder      = excluded.holder,
         expires_at  = excluded.expires_at,
         acquired_at = case when l.holder = excluded.holder then l.acquired_at else now() end
   where l.expires_at < now() or l.holder = excluded.holder;
  return found;
end;
$$;

create or replace function release_lease(p_name text, p_holder text)
returns void
language sql
set search_path = public, pg_temp
as $$
  delete from worker_leases where name = p_name and holder = p_holder;
$$;

revoke execute on function acquire_lease(text, text, int) from public, anon, authenticated;
revoke execute on function release_lease(text, text)      from public, anon, authenticated;
grant  execute on function acquire_lease(text, text, int) to service_role;
grant  execute on function release_lease(text, text)      to service_role;

-- Syncs left "running" by a process that stopped mid-sync.
update sync_runs
   set status = 'failed', error = 'Interrupted: the server stopped or restarted during this sync', finished_at = now()
 where status = 'running' and started_at < now() - interval '30 minutes';

-- 3) Backlog definition used by the overview ------------------------------------
create or replace function backlog_count(p_enterprise uuid)
returns bigint
language sql stable
set search_path = public, pg_temp
as $$
  select count(*) from events
   where enterprise_id = p_enterprise
     and state in ('failed', 'dead')
     and category not in ('auth', 'sync');
$$;
revoke execute on function backlog_count(uuid) from public, anon, authenticated;
grant  execute on function backlog_count(uuid) to service_role;

-- 4) Finished events that stored a new passcode in plain text ------------------
--    (new events keep it encrypted as passcode_enc)
update events
   set params = (params - 'passcode') || jsonb_build_object('passcode', '[removed]')
 where params ? 'passcode' and params->>'passcode' <> '[removed]'
   and state in ('succeeded', 'failed', 'dead', 'cancelled');

-- 5) Queue indexes --------------------------------------------------------------
create index if not exists idx_events_state_due  on events (state, next_attempt_at);
create index if not exists idx_events_confirm_due on events (confirm_expires_at) where state = 'awaiting_confirmation';
create index if not exists idx_events_backlog    on events (enterprise_id, action_time desc) where state in ('failed', 'dead');

-- 6) Error codes the backend uses (events.error_code is a foreign key) -----------
insert into error_codes (code, http_status, message, retryable) values
  ('AUTH_INVALID_CREDENTIALS', 401, 'Email or password is incorrect.', false),
  ('SYNC_IN_PROGRESS',         409, 'A sync is already running for this enterprise. Try again in a minute.', true)
on conflict (code) do nothing;
