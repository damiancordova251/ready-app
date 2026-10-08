-- A row in app_installations has never been an "install", or even a person: it
-- is one browser STORAGE CONTEXT. A new row appears whenever localStorage comes
-- up empty — a private tab, a link opened inside another app's in-app browser,
-- an automated test run with a fresh profile, and (the common one on iOS)
-- Safari's ITP deleting all script-writable storage after 7 days without a
-- visit. Installed PWAs are exempt from that sweep; browser tabs are not.
--
-- The practical effect was a badly inflated headline number: at the time this
-- migration was written, 75 rows represented 13 devices that ever did more than
-- one thing, and 7 of the most recent rows were a single laptop running
-- automated tests.
--
-- device_id is the stable identity underneath those rows. The backend restores
-- it from a first-party HttpOnly cookie (see server/deviceCookie.js), which is
-- NOT script-writable and so survives the sweep that clears localStorage.

alter table public.app_installations
  add column if not exists device_id text;

-- Every pre-existing row is its own device: there is no cookie history to
-- recover, so this is the only honest backfill. Counts before today therefore
-- stay as they were, and only new visits can be collapsed.
update public.app_installations
set device_id = id
where device_id is null;

create index if not exists app_installations_device_id_idx
  on public.app_installations (device_id);

-- One row per real device, with the storage contexts it has burned through.
-- storage_contexts > 1 means this device was wiped and came back.
create or replace view public.v_device_engagement as
with device_rows as (
  select
    coalesce(device_id, id) as device_id,
    id as installation_id,
    first_seen_at,
    last_active_at,
    pwa_installed,
    platform,
    device_type
  from public.app_installations
),
events as (
  select
    dr.device_id,
    count(*) as event_count,
    count(distinct ae.occurred_at::date) as active_days,
    max(ae.occurred_at) as last_event_at
  from public.analytics_events ae
  join device_rows dr on dr.installation_id = ae.installation_id
  group by dr.device_id
),
push as (
  select distinct dr.device_id
  from public.push_subscriptions ps
  join device_rows dr on dr.installation_id = ps.installation_id
)
select
  dr.device_id,
  min(dr.first_seen_at) as first_seen_at,
  max(dr.last_active_at) as last_active_at,
  count(*) as storage_contexts,
  bool_or(dr.pwa_installed) as pwa_installed,
  max(dr.platform) as platform,
  max(dr.device_type) as device_type,
  coalesce(max(e.event_count), 0) as event_count,
  coalesce(max(e.active_days), 0) as active_days,
  max(e.last_event_at) as last_event_at,
  -- "engaged" deliberately means more than one event. A single session_started
  -- with nothing after it is a bounce or a bot, not a user.
  coalesce(max(e.event_count), 0) >= 2 as engaged,
  bool_or(p.device_id is not null) as reachable_by_push
from device_rows dr
left join events e on e.device_id = dr.device_id
left join push p on p.device_id = dr.device_id
group by dr.device_id;

-- The numbers worth quoting, in one row. Read left to right: the raw row count
-- is the least meaningful and reachable_by_push is the most.
create or replace view public.v_headline_metrics as
-- d is aliased so that `storage_contexts` below unambiguously means the view's
-- per-device column and not this query's own output alias of the same name.
select
  (select count(*) from public.app_installations) as storage_contexts,
  count(*) as devices,
  count(*) filter (where d.engaged) as engaged_devices,
  count(*) filter (where d.active_days >= 2) as returned_another_day,
  count(*) filter (where d.pwa_installed) as installed_pwa,
  count(*) filter (where d.reachable_by_push) as reachable_by_push,
  count(*) filter (where d.storage_contexts > 1) as devices_with_wiped_storage
from public.v_device_engagement d;

-- Device-level retention. Mirrors get_retention(), but counts devices rather
-- than storage contexts and excludes single-event bounces from the cohort, so
-- the denominator is people who actually arrived rather than everyone who
-- loaded the page once.
create or replace function public.get_device_retention(cohort_date date, day_n integer)
returns table (cohort_size bigint, retained_count bigint)
language sql
stable
as $$
  with cohort as (
    select device_id
    from public.v_device_engagement
    where first_seen_at::date = cohort_date
      and engaged
  ),
  retained as (
    select distinct coalesce(i.device_id, i.id) as device_id
    from public.analytics_events ae
    join public.app_installations i on i.id = ae.installation_id
    join cohort c on c.device_id = coalesce(i.device_id, i.id)
    where ae.occurred_at::date = cohort_date + day_n
  )
  select
    (select count(*) from cohort) as cohort_size,
    (select count(*) from retained) as retained_count;
$$;

-- ROLLBACK (documentation only — not executed automatically):
-- drop function if exists public.get_device_retention(date, integer);
-- drop view if exists public.v_headline_metrics;
-- drop view if exists public.v_device_engagement;
-- drop index if exists public.app_installations_device_id_idx;
-- alter table public.app_installations drop column if exists device_id;
