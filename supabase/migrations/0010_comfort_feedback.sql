-- Ground truth for the recommendation engine.
--
-- forecast_actuals measures whether the FORECAST was right. Nothing measured
-- whether the CHECKLIST was right — whether someone who followed it ended up
-- cold, comfortable, or overheated. This table is that measurement: a one-tap
-- "too cold / just right / too warm" about the person's previous visit, asked
-- the next time they open Ready.
--
-- Each row carries the conditions and suggestions it is rating, so an answer
-- stays interpretable on its own: "too cold" means nothing unless you know it
-- was 48F and windy and we suggested a sweater.
create table if not exists public.comfort_feedback (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null references public.app_installations (id),
  rating text not null check (rating in ('too_cold', 'just_right', 'too_warm')),
  -- The local calendar day being rated — the previous visit, not today.
  recommended_for_date date not null,
  -- Same coarse shape as recommendation_events.weather_conditions. Never a
  -- location: temperatures, wind, precipitation chance and a condition code.
  weather_summary jsonb not null default '{}'::jsonb,
  -- The engine's clothing weights plus the top item shown per category, in
  -- the engine's own English vocabulary so answers compare across languages.
  suggestions jsonb not null default '[]'::jsonb,
  expected_time_away_hours integer,
  app_version text,
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- One answer per person per day. A second answer for the same day replaces
  -- the first rather than double-counting it.
  unique (installation_id, recommended_for_date)
);

alter table public.comfort_feedback enable row level security;

create index if not exists comfort_feedback_date_idx
  on public.comfort_feedback (recommended_for_date);

-- How the checklist lands, bucketed by how warm it actually felt. If the
-- engine is calibrated, "just_right" dominates every band; a band that leans
-- "too_cold" is where the clothing weights need to move warmer.
create or replace view public.v_comfort_calibration as
with banded as (
  select
    rating,
    (weather_summary ->> 'feelsLike')::numeric as feels_like,
    case
      when (weather_summary ->> 'feelsLike') is null then 'unknown'
      when (weather_summary ->> 'feelsLike')::numeric < 35 then 'a. below 35F'
      when (weather_summary ->> 'feelsLike')::numeric < 50 then 'b. 35-49F'
      when (weather_summary ->> 'feelsLike')::numeric < 62 then 'c. 50-61F'
      when (weather_summary ->> 'feelsLike')::numeric < 72 then 'd. 62-71F'
      when (weather_summary ->> 'feelsLike')::numeric < 82 then 'e. 72-81F'
      else 'f. 82F and up'
    end as feels_like_band
  from public.comfort_feedback
)
select
  feels_like_band,
  count(*) as answers,
  count(*) filter (where rating = 'too_cold') as too_cold,
  count(*) filter (where rating = 'just_right') as just_right,
  count(*) filter (where rating = 'too_warm') as too_warm,
  round(100.0 * count(*) filter (where rating = 'just_right') / nullif(count(*), 0), 0) as just_right_pct
from banded
group by feels_like_band
order by feels_like_band;

-- ROLLBACK (documentation only — not executed automatically):
-- drop view if exists public.v_comfort_calibration;
-- drop table if exists public.comfort_feedback;
