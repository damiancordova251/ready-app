# Example analytics queries

Ready-to-run in the Supabase SQL Editor once the migrations in `supabase/migrations/` are applied.

## Start here: the headline numbers

```sql
select * from public.v_headline_metrics;
```

**Do not quote `storage_contexts`.** A row in `app_installations` is one browser
*storage context*, not a person and not an install. A new row appears every time
local storage comes up empty: a private tab, a link opened inside another app's
in-app browser, an automated test run, and — the common one on iOS — Safari
deleting all script-writable storage after about seven days without a visit.

Read the columns in order of how much they mean:

| Column | What it actually is |
| --- | --- |
| `storage_contexts` | Raw row count. Inflated. Useful only as a denominator. |
| `devices` | Storage contexts collapsed by `device_id`. |
| `engaged_devices` | Devices with **more than one event**. A lone `session_started` is a bounce or a bot. |
| `returned_another_day` | Devices active on two or more distinct days. The real retention signal. |
| `installed_pwa` | Added to the home screen. Exempt from Safari's storage sweep. |
| `reachable_by_push` | Has a push subscription — the only devices that can receive a morning reminder. |
| `devices_with_wiped_storage` | Devices seen under more than one installation ID, i.e. caught being wiped and recovered. |

Per-device detail behind that row:

```sql
select * from public.v_device_engagement
order by event_count desc;
```

> `device_id` is only recoverable for visits **after** migration `0009` was
> applied; earlier rows are each treated as their own device, so historical
> counts stay inflated and only new traffic gets collapsed.

## Daily / weekly / monthly active installations

```sql
-- DAU for a specific day
select count(distinct installation_id) as dau
from public.v_daily_active_installations
where activity_date = current_date;

-- WAU (trailing 7 days)
select count(distinct installation_id) as wau
from public.v_daily_active_installations
where activity_date >= current_date - interval '6 days';

-- MAU (trailing 30 days)
select count(distinct installation_id) as mau
from public.v_daily_active_installations
where activity_date >= current_date - interval '29 days';
```

## Retention (D1 / D3 / D7 / D14 / D30)

```sql
-- Preferred: counts devices, and excludes single-event bounces from the
-- cohort, so the denominator is people who actually arrived.
select * from public.get_device_retention('2026-07-01'::date, 1);
select * from public.get_device_retention('2026-07-01'::date, 7);

-- The original, kept for comparison: counts storage contexts and includes
-- every one-second bounce in the cohort, so it reads lower than reality.
select * from public.get_retention('2026-07-01'::date, 1);
```

## Session frequency / recommendation frequency

```sql
-- Average distinct active days per installation over the trailing 30 days.
select avg(days_active) from (
  select installation_id, count(distinct activity_date) as days_active
  from public.v_daily_active_installations
  where activity_date >= current_date - interval '29 days'
  group by installation_id
) per_installation;

-- Average recommendations generated per installation over the trailing 7 days.
select avg(rec_count) from (
  select installation_id, count(*) as rec_count
  from public.recommendation_events
  where occurred_at >= now() - interval '7 days'
  group by installation_id
) per_installation;
```

## Referral conversion rate

```sql
select
  count(*) as total_visits,
  count(*) filter (where resulted_in_install) as installs,
  round(
    100.0 * count(*) filter (where resulted_in_install) / nullif(count(*), 0),
    1
  ) as conversion_pct
from public.referral_visits;
```

## Notification performance

```sql
-- Open rate over the trailing 30 days.
select
  count(*) as sent,
  count(*) filter (where opened_at is not null) as opened,
  round(
    100.0 * count(*) filter (where opened_at is not null) / nullif(count(*), 0),
    1
  ) as open_rate_pct
from public.notification_events
where scheduled_at >= now() - interval '30 days';

-- Which message variant performs best.
select
  message_variant,
  count(*) as sent,
  count(*) filter (where opened_at is not null) as opened,
  round(
    100.0 * count(*) filter (where opened_at is not null) / nullif(count(*), 0),
    1
  ) as open_rate_pct
from public.notification_events
group by message_variant
order by open_rate_pct desc nulls last;
```

## Recommendation usefulness

```sql
-- Only counts installations that voluntarily reported feedback (there is no
-- forced prompt for this yet — user_feedback_useful/followed stay null
-- otherwise).
select
  count(*) filter (where user_feedback_useful is not null) as responses,
  count(*) filter (where user_feedback_useful = true) as marked_useful,
  round(
    100.0 * count(*) filter (where user_feedback_useful = true)
      / nullif(count(*) filter (where user_feedback_useful is not null), 0),
    1
  ) as useful_pct
from public.recommendation_events;
```

## PWA installation rate / feedback participation rate

```sql
select
  count(*) filter (where pwa_installed) as pwa_installed_count,
  count(*) as total_installations,
  round(100.0 * count(*) filter (where pwa_installed) / nullif(count(*), 0), 1) as pwa_install_pct
from public.app_installations;

select
  count(distinct installation_id) as installations_with_feedback,
  (select count(*) from public.app_installations) as total_installations
from public.feedback_submissions;
```

## Forecast accuracy summary

```sql
select
  p.location_bucket,
  p.horizon_hours,
  count(*) as sample_size,
  round(avg(abs(a.temp_error))::numeric, 1) as mean_abs_temp_error_f,
  round(avg(abs(a.feels_like_error))::numeric, 1) as mean_abs_feels_like_error_f,
  round(100.0 * count(*) filter (where a.condition_match), 1) / nullif(count(*), 0) as condition_match_pct,
  count(*) filter (where a.would_change_recommendation) as would_change_recommendation_count
from public.forecast_predictions p
join public.forecast_actuals a on a.prediction_id = p.id
group by p.location_bucket, p.horizon_hours
order by p.location_bucket, p.horizon_hours;
```
