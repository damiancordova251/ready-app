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

## Is the checklist right? (comfort calibration)

The forecast-accuracy tables measure whether the *forecast* was right. This
measures whether the *checklist* was — from the one-tap "too cold / just right
/ too warm" people answer about their previous visit.

```sql
select * from public.v_comfort_calibration;
```

Read it band by band. A calibrated engine has `just_right` dominating every
row. A band that leans `too_cold` is where clothing weights need to move
warmer; `too_warm`, lighter. Don't act on a band with only a handful of
answers — wait for it to fill in.

What people were actually wearing when they said it felt wrong:

```sql
select recommended_for_date, rating,
       weather_summary ->> 'feelsLike' as feels_like,
       weather_summary ->> 'windMax'   as wind,
       suggestions
from public.comfort_feedback
where rating <> 'just_right'
order by recommended_for_date desc;
```

## Who stopped getting reminders (uninstalls and muting)

Browsers never announce an uninstall or a mute, so these are the traces each
leaves behind:

- **`push_subscription_expired`** — written by the reminder scheduler when the
  push service rejects a reminder (404/410). Usually means Ready was removed
  from the home screen; it also happens when notifications are blocked or site
  data is cleared. Read it as "unreachable", not strictly "uninstalled". The
  subscription is deleted right after, so this event is the only record.
- **`notification_permission_revoked` / `_restored`** — notifications switched
  off (or back on) in device settings. Only noticed the next time the app is
  opened, so someone who mutes Ready and never returns is never counted here —
  though their next reminder will usually come back as an expiry above.
- **`notification_opt_out`** — turned off with Ready's own Settings button.

Short-lived "mute for an hour" or Focus modes are invisible to web apps.

```sql
-- Each way of stopping, per week.
select date_trunc('week', occurred_at)::date as week, event_name, count(*)
from public.analytics_events
where event_name in ('push_subscription_expired', 'notification_permission_revoked',
                     'notification_permission_restored', 'notification_opt_out')
group by 1, 2
order by 1 desc, 2;

-- How long reminders lasted before a device became unreachable.
select (metadata ->> 'daysSubscribed')::int as days_subscribed, count(*) as devices
from public.analytics_events
where event_name = 'push_subscription_expired'
group by 1
order by 1;

-- The last reminder message each person saw before switching notifications off.
-- If one variant keeps showing up here, that message is the one costing you.
select n.message_variant, count(*) as times_seen_last
from public.analytics_events e
cross join lateral (
  select message_variant
  from public.notification_events
  where installation_id = e.installation_id
    and scheduled_at < e.occurred_at
  order by scheduled_at desc
  limit 1
) n
where e.event_name in ('notification_permission_revoked', 'notification_opt_out', 'push_subscription_expired')
group by 1
order by 2 desc;
```

Reminder variants are `snow`, `rain`, `freezing`, `cold`, `wind`, `sun`,
`layers`, and `generic`. Rows written before 14 Oct 2026 use the older
`rain`/`cold`/`warm` set, whose titles stated the weather rather than what to
bring.

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
