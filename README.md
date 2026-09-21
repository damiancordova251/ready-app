# Ready

Ready is a mobile-first progressive web app that turns a weather forecast into a practical
clothing checklist for however long you'll be away from home. It speaks English and Spanish, works
offline once installed, and can send a daily reminder that already knows whether it's going to
rain.

---

## What Ready does

### The checklist
You tell Ready roughly how long you'll be out — 3, 6, 9, or 12 hours — and it pulls the forecast
for exactly that window rather than for "today" in the abstract. A 9 PM check with a 3-hour window
only considers the next few night hours; the same check with a 12-hour window may account for
tomorrow's daylight and afternoon rain.

From that window it builds a grouped checklist across five categories: footwear, pants, shirts,
outerwear, and accessories. Every recommendation starts from a clothing foundation — one flexible
top and one flexible bottom, usually offering two or three interchangeable options — and only adds
accessories (umbrella, sunglasses, winter boots) when the forecast actually justifies them.

The logic is deliberately transparent and rule-based, not a model: explicit thresholds for
temperature, rain probability, wind, and snow, tuned so that longer windows trigger rain gear more
readily than short ones, because there's more time to get caught out.

### Personal wardrobe
Ready can ask which garments you actually own, then recommend from your wardrobe instead of
generic defaults. If you skip this, you get sensible defaults instead — nothing breaks. These
preferences never leave your phone.

### Weather-aware reminders
You pick a time; Ready sends one push notification a day at that time in your local timezone. The
reminder isn't generic: if rain is likely, it says so. If it'll feel colder than usual, it says
that instead. The message is written in whichever language you've selected, and falls back to a
plain "your checklist is ready" if weather can't be determined.

### Sharing and feedback
A floating share button generates a personal referral link so you can pass Ready to a friend, and
the app can tell whether a shared link actually led to someone installing it. Settings has an
always-available "Report a problem" box for bugs, plus a periodic prompt (after three days of
actual use) asking how it's going.

### Bilingual throughout
Every screen, button, error message, and notification exists in English and Spanish. Switching
languages in Settings changes everything, including the wording of scheduled notifications.

---

## How it's built

Ready is deliberately simple: **no build step, no bundler, no framework.** The frontend is plain
ES modules served exactly as written, which keeps the whole system small enough to reason about.

### The pieces

**The app itself** is a static PWA — HTML, CSS, and JavaScript modules — plus a service worker that
caches the app shell so it opens instantly and survives a bad connection. Installed to a phone's
home screen, it behaves like a native app.

**Cloudflare** does three separate jobs, which are easy to confuse:

- *Cloudflare Pages* hosts the static app worldwide and serves it over HTTPS. It rebuilds and
  redeploys automatically whenever code is pushed.
- *Cloudflare Pages Functions* provide the API the app talks to — saving a reminder subscription,
  recording feedback, handling referral links — running on the same domain as the app, so there's
  no cross-origin complexity.
- *Cloudflare Workers* run the scheduled background jobs. These are the only part of the system
  that runs when nobody has the app open, which is exactly what a daily reminder requires.

**Supabase** provides the Postgres database. Only the backend ever talks to it — the app in your
browser has no database credentials and no direct access. Every table has row-level security
enabled with no public access policies.

**Open-Meteo** supplies the forecast data. It's free, requires no API key, and the browser queries
it directly.

### Why there are background workers

A reminder has to fire at 7:00 AM whether or not the app is open, so it can't live in the frontend.
It also can't reliably live on a free web server, which sleeps when idle and would miss the moment.
Cloudflare Workers run on a schedule independent of any server being awake, which is what makes
reminders dependable.

Two workers run on their own timers:

**The reminder scheduler** wakes every five minutes and asks a simple question of each saved
reminder: *is it that person's chosen time right now, in their timezone, and have they already been
sent today?* When the answer is yes-and-no, it looks up the weather for their approximate area,
picks a matching message, sends the push notification, and records the date so nobody gets two
reminders in one day.

**The forecast tracker** wakes every thirty minutes and quietly measures how good the forecasts
actually are. It records what the weather service predicted for a given area 6, 12, and 24 hours
out, then later records what actually happened, and stores the difference. This is measurement
only — it never changes the recommendations on its own. If the data ever suggests a threshold
should move, that's a decision for a person to review and approve.

### What's stored, and where

Two categories, and the split is intentional:

**Stays on your phone, never transmitted:** your exact location, your clothing preferences, your
time-away and reminder settings, and your language choice. These live in browser storage.

**Stored in the database:** a randomly generated installation ID (there are no accounts, no names,
no emails, no payment details), which is used to tie together:

| Area | What it holds |
| --- | --- |
| Installations | When a device first and last used Ready, its language, app version |
| Usage events | Which features get used, from a fixed list of event names |
| Recommendations | The weather conditions and the checklist produced from them |
| Notifications | When a reminder was scheduled, sent, opened, or dismissed |
| Reminders | Push subscription details, reminder time, timezone, and an *approximate* location rounded to ~11 km |
| Referrals | Referral codes and whether a shared link led to an install |
| Feedback | Ratings and written feedback |
| Diagnostics | Errors and API response times, for debugging |
| Forecast accuracy | Predicted vs. actual weather by area — not linked to any individual |

The only location ever stored on the server is deliberately coarsened to about 11 kilometres,
rounded on the device before it's sent, and only when reminders are switched on. Users can erase
everything tied to their device at any time from Settings.

Full detail — every table, every column, why each one exists — is in
[`supabase/README.md`](supabase/README.md). For how to actually read that data (where your users
are, how the IDs join up, how to measure retention) see
[`supabase/READING_YOUR_DATA.md`](supabase/READING_YOUR_DATA.md), with ready-made queries in
[`supabase/ANALYTICS_QUERIES.md`](supabase/ANALYTICS_QUERIES.md).

### Privacy and terms

The app ships a [Privacy Policy](privacy.html) and [Terms of Service](terms.html), both bilingual,
linked from Settings and presented during onboarding before any data is collected. Settings also
shows the device's installation ID (the only identifier attached to its records) and a
**Delete my data** control that erases every associated row from the database, cancels any
scheduled reminders, and clears local storage.

---

## Project layout

```
index.html            The app shell
privacy.html          Privacy Policy (English + Spanish)
terms.html            Terms of Service (English + Spanish)
sw.js                 Service worker: offline caching, push notifications
styles.css

src/                  Frontend, plain ES modules
  app.js              Bootstrap — initializes each feature
  features/           One folder per feature (checklist, onboarding, settings, …)
  domain/             Pure recommendation logic, no DOM or network
  services/           Weather, location, notifications, analytics, referrals
  i18n/               English and Spanish translations
  utils/ state/ dom/ constants/

server/               Express backend — local development and a fallback host
functions/            Cloudflare Pages Functions — the production API
workers/
  reminder-scheduler/ Sends the daily reminder (see its README)
  forecast-tracker/   Measures forecast accuracy (see its README)
supabase/             Database schema, migrations, and query examples
tests/                Plain Node scripts — no test framework
scripts/              Build and icon-generation helpers
```

The backend logic exists twice on purpose: once for Node (`server/`) and once for Cloudflare's
runtime (`functions/`), which requires different, Workers-compatible libraries. When changing one,
change both.

---

## Running it locally

```sh
npm install
cp .env.example .env    # then fill in the values described in that file
npm run dev
```

Then open `http://localhost:3000`. The Express server serves the app and the API together on one
origin, which is what the service worker and push notifications expect.

`.env.example` documents every setting the backend needs. Real credentials live only in your local
`.env` and in the hosting provider's own secret storage — never in the repository.

## Testing

```sh
npm run check                 # syntax-check every source file
npm run test:recommendations  # recommendation, checklist, notification, and forecast logic
npm run build:pages           # produce the deployable static bundle
```

Tests are plain scripts using Node's built-in `assert` — no framework to learn. For anything
touching the database or push delivery, prefer verifying against the real thing over mocking:
create a test record, confirm it round-trips, then delete it.

## Deploying

The app and its API deploy automatically whenever changes reach the main branch — no manual step.

The two background workers are deployed separately and manually, each from its own folder, because
they run on Cloudflare's Workers platform rather than as part of the website. Each has a README
covering its own setup, safety switches, and rollout order:

- [`workers/reminder-scheduler/README.md`](workers/reminder-scheduler/README.md)
- [`workers/forecast-tracker/README.md`](workers/forecast-tracker/README.md)

One thing worth knowing: each worker's configuration file is the source of truth for its settings.
Changing a setting only in the Cloudflare dashboard will be silently overwritten the next time that
worker is deployed.

---

## Current limitations

- Runs entirely on free hosting tiers — appropriate for a pilot, not for guaranteed uptime.
- No accounts, so preferences don't sync across devices and clearing browser data resets them.
- Push notification delivery depends on Apple and Google infrastructure and can be delayed.
- Recommendation thresholds are hand-tuned and benefit from real feedback.
- There's no automated monitoring or alerting yet.
