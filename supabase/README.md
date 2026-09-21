# Supabase migrations — analytics, notification content, forecast accuracy

These migrations extend the Supabase project already documented in the root `README.md` (which
covers `push_subscriptions` and `pilot_events`). Everything here is **additive**: no existing
table, column, or row is dropped, renamed, or overwritten. `push_subscriptions` and `pilot_events`
keep working exactly as before.

## What's collected and why

- **`app_installations` / `analytics_events`** — one row per anonymous device (the same anonymous
  id already used by `pilot_events`, generated client-side, no accounts) plus a general event
  stream for feature usage, session activity, and retention calculations. No names, emails, or
  exact location.
- **`recommendation_events`** — what weather conditions produced which checklist, so recommendation
  usefulness can be measured. Weather conditions only (temps/precip/wind/condition code), never
  exact coordinates.
- **`notification_events`** — the lifecycle of a scheduled reminder (scheduled → delivered →
  opened/dismissed) and which message variant it used.
- **`referrals` / `referral_visits`** — referral-code ownership and the visit → install conversion
  funnel.
- **`feedback_submissions`** — the 3-day feedback prompt's rating, optional written comment, and
  optional answer to "what other clothing options would you like to see?" (`clothing_suggestions`).
  `allow_follow_up` defaults to `false` and is unusable in practice today since this app has no
  accounts/contact details to follow up with.
- **`client_errors` / `api_performance_events`** — small, structured error/latency records with no
  personal information.
- **`forecast_predictions` / `forecast_actuals` / `model_change_proposals`** — the forecast-accuracy
  pipeline (see `workers/forecast-tracker/README.md`). Location is a *coarse* bucket
  (`coarse_latitude`/`coarse_longitude`, rounded to 1 decimal degree, ~11km) — the same precision
  used for notification content, never an exact address-level location. `model_change_proposals` is
  a propose → review → approve/reject → apply → (optionally) roll back workflow; nothing here is
  ever applied to `domain/recommendation.js` automatically.
- **`push_subscriptions.coarse_latitude` / `coarse_longitude` / `preferred_language`** — new,
  nullable columns on the *existing* table, populated only when a user enables reminders, letting
  scheduled notifications mention weather context in the user's chosen language. Null for every
  subscription that existed before this migration; the scheduler falls back to the existing
  generic message when either is missing.
- **`push_subscriptions.installation_id`** — new, nullable column linking a subscription back to
  the same anonymous installation id used elsewhere, so a sent reminder can be recorded as a
  `notification_events` row (which requires an installation id). Existing subscriptions stay null
  until the next time that browser resubscribes.

## Applying the migrations

I don't have execute access to this Supabase project's database (only the backend's REST-facing
service-role key is available in this environment, not a Postgres password or Management API
token) — same situation as the original `push_subscriptions`/`pilot_events` setup. Apply these
yourself:

1. Open the Supabase dashboard → SQL Editor for this project.
2. Run each file in `supabase/migrations/` **in numeric order** (`0001_...` through `0008_...`).
   Every statement uses `create table if not exists` / `add column if not exists`, so re-running a
   file that already applied is a safe no-op.
3. Confirm the new tables appear under Table Editor, and that `push_subscriptions` now shows the
   four new nullable columns with existing rows unaffected.
4. No new environment variables are required for the analytics/feedback endpoints — they reuse the
   existing `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` already configured for
   `push_subscriptions`/`pilot_events`.

## Rollback

Each migration file ends with a commented-out `-- ROLLBACK` block containing the exact `drop
table`/`drop column` statements to reverse it, in dependency order. These are documentation, not
executed automatically — copy the block for the migration(s) you want to undo into the SQL Editor
yourself. Roll back in reverse numeric order if undoing more than one migration, since later ones
reference earlier ones via foreign keys (e.g. `forecast_actuals` references
`forecast_predictions`).

## Example queries

New to this schema? Start with `READING_YOUR_DATA.md`, which explains where your users live,
how the IDs connect the tables, and how to measure retention.

See `supabase/ANALYTICS_QUERIES.md` for ready-to-run SQL covering DAU/WAU/MAU, retention,
referral conversion, notification performance, recommendation usefulness, and forecast accuracy.
