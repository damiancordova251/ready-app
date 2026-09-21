# Reading your data

A plain-language map of what's in the database, where your users are, and how to tell whether
people are actually coming back. For copy-paste SQL, see
[`ANALYTICS_QUERIES.md`](ANALYTICS_QUERIES.md); this file explains what you're looking at.

---

## Where your users are

**`app_installations` is your user table.** One row = one install of Ready on one browser. To get
your user count:

```sql
select count(*) from app_installations;
```

That's it. There is no separate "users" table, because Ready has no accounts — which is the point,
but it means the install is the closest thing to a person you have.

### What a row actually represents

An installation, not a human. Specifically:

- One person with a phone **and** a laptop = **two rows**.
- One person who clears their browser data and returns = **two rows**.
- One person who uses "Delete my data" and comes back = **two rows** (the first is gone).
- Someone who opens the link once, glances, and leaves = **one row**, same as your most devoted user.

So treat the raw count as *"devices that have opened Ready at least once"* and use the activity
columns below to find the people who actually stuck around.

### The useful columns

| Column | What it tells you |
| --- | --- |
| `id` | The installation ID — the key that links this device to every other table |
| `first_seen_at` | When this device first opened Ready |
| `last_active_at` | The last time it did anything — your best signal of who's still around |
| `preferred_language` | `en` or `es` |
| `referral_code` | Set if this install arrived through someone's shared link |
| `app_version` | Useful when a bug only affects older installs |

Several other columns (`platform`, `browser`, `os`, `device_type`, `pwa_installed`,
`notification_permission`, `reminders_enabled`) exist in the schema but **are not currently being
filled in** — nothing writes to them yet. Don't trust them; they'll read as null or default.

---

## The one ID that connects everything

Every table ties back to `app_installations.id`. Two naming quirks to know:

- Most tables call it **`installation_id`**.
- **`pilot_events`** calls it **`anonymous_device_id`** — it's the *same value*. That table predates
  the current analytics system and was never renamed.

So to see everything one device has ever done:

```sql
select * from analytics_events where installation_id = 'paste-the-id-here';
select * from pilot_events    where anonymous_device_id = 'paste-the-id-here';
```

A user can find their own ID in Settings under "Privacy & your data" — that's how you'd locate
their records if someone emails asking for a data export or deletion.

---

## Every table, briefly

### The ones about people

| Table | What it holds | Written when |
| --- | --- | --- |
| `app_installations` | One row per install — your user list | First event from a new device |
| `analytics_events` | The main activity stream: app opened, checklist generated, reminder toggled, link shared, feedback given | Every tracked action |
| `pilot_events` | The *older* activity stream, same idea, fewer event types | Still writing, kept for continuity |
| `recommendation_events` | The weather conditions and the checklist produced from them | Every checklist generated |
| `feedback_submissions` | Ratings and written feedback. `category = 'issue_report'` means it came from "Report a problem"; `from_scheduled_prompt = true` means it came from the 3-day prompt | On submit |

### The ones about reminders

| Table | What it holds | Written when |
| --- | --- | --- |
| `push_subscriptions` | Everyone with reminders switched on — reminder time, timezone, coarse location. **Row count = how many people have reminders enabled** | On enable; deleted on disable |
| `notification_events` | One row per reminder sent, plus whether it was opened or dismissed | Each send, then updated on tap |

### The ones about growth

| Table | What it holds |
| --- | --- |
| `referrals` | One row per person who has generated a share link |
| `referral_visits` | One row per click on a share link. `resulted_in_install = true` means that visit became a real install |

### The ones about health

| Table | What it holds |
| --- | --- |
| `client_errors` | JavaScript errors from real devices |
| `api_performance_events` | How long weather requests took |

### The ones about forecast accuracy

| Table | What it holds |
| --- | --- |
| `forecast_predictions` | What the weather service predicted for an area, 6/12/24h ahead |
| `forecast_actuals` | What actually happened, and the error |
| `model_change_proposals` | Suggested threshold changes awaiting your review — nothing applies automatically |

These three are **not linked to any person** — they're keyed to a rough geographic area.

---

## Tracking retention

Retention is just: *of the people who showed up, how many came back?* You can answer it from
`app_installations` alone.

**Who's still active:**

```sql
select count(*) from app_installations
where last_active_at > now() - interval '7 days';
```

**Who came back at all** (last activity meaningfully after first activity):

```sql
select count(*) from app_installations
where last_active_at > first_seen_at + interval '1 hour';
```

**Daily active installs over the last two weeks:**

```sql
select date(occurred_at) as day, count(distinct installation_id) as active
from analytics_events
where occurred_at > now() - interval '14 days'
group by day order by day desc;
```

**Cohort retention** — of everyone who installed in a given week, how many were still active a week
later:

```sql
select
  date_trunc('week', first_seen_at)::date as cohort_week,
  count(*) as installed,
  count(*) filter (where last_active_at > first_seen_at + interval '7 days') as still_active_after_7d
from app_installations
group by cohort_week order by cohort_week desc;
```

`ANALYTICS_QUERIES.md` has fuller D1/D3/D7/D14/D30 versions.

---

## Your numbers right now

Snapshot taken 21 September 2026, for orientation — re-run the queries above for current figures.

| Metric | Value | Read it as |
| --- | --- | --- |
| Total installations | **56** | Devices that have opened Ready since 19 July |
| Came back after the first hour | **6** | Your actual returning users |
| Active in the last 7 days | **6** | Currently engaged |
| Reminders enabled | **4** | People receiving daily notifications |
| Referral links created | **3** (5 clicks) | Sharing is being tried, barely |
| Feedback submitted | **2** | |
| Language | 55 English, 0 Spanish (1 unset) | See the flag below |

Two things worth your attention:

**Almost nobody comes back.** 6 of 56 returned after their first session. For a pilot that's the
single most important number on this page — it says people will try Ready once but haven't yet
found a reason to make it a habit. Worth asking your returning users what made them stay.

**No one has selected Spanish.** Every install that recorded a language reads as English, despite
an Ecuador-based pilot. Either testers genuinely prefer English, or the language selector isn't
being discovered — it sits near the bottom of Settings. Worth checking with an actual tester before assuming the translation
work isn't needed.

**Also note:** `forecast_predictions` and `forecast_actuals` are both empty. The forecast tracker is
deployed but still in dry-run mode, so it's logging what it *would* record without writing
anything. Flip `DRY_RUN` to `false` in `workers/forecast-tracker/wrangler.toml` and redeploy when
you want it to start collecting.

---

## Handling a data request

If someone asks what you hold on them, or asks you to delete it:

1. Ask for their installation ID (Settings → Privacy & your data).
2. Point them at **Delete my data** in Settings — it removes everything tied to that ID across all
   tables, and is instant.
3. If they want a copy instead, query each table by `installation_id` (and `pilot_events` by
   `anonymous_device_id`) and send them the rows.
