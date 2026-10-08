import { buildPushPayload } from "@block65/webcrypto-web-push";
import { buildNotificationCopy } from "./notificationCopy.js";

const DEFAULT_TABLE_NAME = "push_subscriptions";
const DEFAULT_NOTIFICATION_EVENTS_TABLE = "notification_events";
const DEFAULT_CRON_WINDOW_MINUTES = 5;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const FALLBACK_REMINDER = {
  title: "\u2705 Your checklist is ready",
  body: "Open Ready to see what to wear today.",
  tag: "ready-checklist",
  url: "/"
};

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReminderScheduler({
      env,
      now: getScheduledDate(controller)
    }));
  }
};

export async function runReminderScheduler({ env, now = new Date() }) {
  assertConfigured(env);

  const dryRun = isEnabled(env.DRY_RUN);
  const cronWindowMinutes = getCronWindowMinutes(env.CRON_WINDOW_MINUTES);
  const subscriptions = await getSubscriptions(env);
  const summary = {
    checked: subscriptions.length,
    due: 0,
    sent: 0,
    skippedAlreadySent: 0,
    removed: 0,
    failed: 0,
    dryRun
  };

  await Promise.all(subscriptions.map(async (record) => {
    const localTime = getLocalTimeParts(now, record.timezone);

    if (!isDueWithinWindow(localTime.minuteOfDay, record.routineStartMinutes, cronWindowMinutes)) {
      return;
    }

    if (record.lastSentDate === localTime.dateKey) {
      summary.skippedAlreadySent += 1;
      return;
    }

    summary.due += 1;

    if (dryRun) {
      console.log(`Dry run: Ready reminder due for ${record.id} on ${localTime.dateKey}.`);
      return;
    }

    try {
      await sendReadyChecklistPush(record, env);
      await markReminderSent(record.id, localTime.dateKey, env);
      summary.sent += 1;
      console.log(`Sent Ready Checklist reminder to ${record.id} for ${localTime.dateKey}.`);
    } catch (error) {
      if (isSubscriptionGone(error)) {
        await removeSubscription(record.id, env);
        summary.removed += 1;
        console.log(`Removed expired push subscription ${record.id}.`);
        return;
      }

      summary.failed += 1;
      console.error(`Failed to send Ready Checklist reminder to ${record.id}.`, error);
    }
  }));

  console.log("Ready reminder scheduler summary", summary);
  return summary;
}

async function getSubscriptions(env) {
  const response = await supabaseFetch(env, {
    path: tablePath(env),
    searchParams: new URLSearchParams({
      select: "id,subscription,routine_start_minutes,timezone,coarse_latitude,coarse_longitude,preferred_language,installation_id,last_sent_date,created_at,updated_at",
      order: "created_at.asc"
    })
  });

  const rows = await response.json();

  return rows.map(toRecord);
}

async function markReminderSent(id, localDate, env) {
  await supabaseFetch(env, {
    path: tablePath(env),
    searchParams: new URLSearchParams({
      id: `eq.${id}`
    }),
    init: {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        last_sent_date: localDate,
        updated_at: new Date().toISOString()
      })
    }
  });
}

async function removeSubscription(id, env) {
  await supabaseFetch(env, {
    path: tablePath(env),
    searchParams: new URLSearchParams({
      id: `eq.${id}`
    }),
    init: {
      method: "DELETE"
    }
  });
}

// Weather-aware when the subscription has a coarse location saved (see
// server/pushService.js for the same logic on the Express side); falls back
// to the existing generic reminder on missing location or any fetch failure.
async function sendReadyChecklistPush(record, env) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  const { reminder, variant, weatherContext } = await buildReminderPayload(record);
  const notificationEventId = await recordNotificationScheduled(record, variant, weatherContext, env);
  const message = {
    data: { ...reminder, notificationEventId },
    options: {
      ttl: 60 * 60,
      topic: "ready-checklist"
    }
  };
  const requestInit = await buildPushPayload(message, record.subscription, vapid);
  const response = await fetch(record.subscription.endpoint, requestInit);

  if (response.ok) {
    return;
  }

  throw new PushSendError(response.status, await response.text().catch(() => ""));
}

async function buildReminderPayload(record) {
  if (!Number.isFinite(record.coarseLatitude) || !Number.isFinite(record.coarseLongitude)) {
    return { reminder: FALLBACK_REMINDER, variant: "generic", weatherContext: null };
  }

  try {
    const weatherSummary = await fetchCoarseWeatherSummary(record.coarseLatitude, record.coarseLongitude);
    const copy = buildNotificationCopy({
      language: record.preferredLanguage ?? "en",
      weatherSummary
    });

    return {
      reminder: { ...FALLBACK_REMINDER, title: copy.title, body: copy.body },
      variant: copy.variant,
      weatherContext: weatherSummary
    };
  } catch (error) {
    return { reminder: FALLBACK_REMINDER, variant: "generic", weatherContext: null };
  }
}

// Recorded immediately after buildReminderPayload, before the actual push
// send — the closest proxy this Worker has for "delivered" without a
// device-side delivery receipt. Never throws: returns null on any failure so
// a storage hiccup never blocks sending the actual reminder.
async function recordNotificationScheduled(record, variant, weatherContext, env) {
  if (!record.installationId) {
    return null;
  }

  try {
    const now = new Date().toISOString();
    const response = await supabaseFetch(env, {
      path: notificationEventsTablePath(env),
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({
          installation_id: record.installationId,
          notification_type: "scheduled_reminder",
          message_variant: variant,
          weather_context: weatherContext,
          scheduled_at: now,
          delivered_at: now
        })
      }
    });
    const rows = await response.json();
    const saved = Array.isArray(rows) ? rows[0] : rows;

    return saved?.id ?? null;
  } catch (error) {
    console.error("notification_events insert failed.", error);
    return null;
  }
}

async function fetchCoarseWeatherSummary(latitude, longitude) {
  const url = new URL(OPEN_METEO_URL);

  url.search = new URLSearchParams({
    latitude: latitude.toFixed(1),
    longitude: longitude.toFixed(1),
    current: "temperature_2m,apparent_temperature",
    daily: "temperature_2m_max,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: "1"
  }).toString();

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed with ${response.status}.`);
  }

  const data = await response.json();

  return {
    currentTemp: toWeatherNumber(data.current?.temperature_2m),
    feelsLike: toWeatherNumber(data.current?.apparent_temperature),
    highTemp: toWeatherNumber(data.daily?.temperature_2m_max?.[0]),
    precipitationProbability: toWeatherNumber(data.daily?.precipitation_probability_max?.[0])
  };
}

function toWeatherNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

async function supabaseFetch(env, { path, searchParams = new URLSearchParams(), init = {} }) {
  const url = new URL(`/rest/v1/${path}`, env.SUPABASE_URL);

  searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed with ${response.status}: ${await response.text()}`);
  }

  return response;
}

function getLocalTimeParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const value = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));

  return {
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    dateKey: `${value("year")}-${value("month")}-${value("day")}`
  };
}

function isDueWithinWindow(minuteOfDay, routineStartMinutes, cronWindowMinutes) {
  return minuteOfDay >= routineStartMinutes
    && minuteOfDay < routineStartMinutes + cronWindowMinutes;
}

function getScheduledDate(controller) {
  const scheduledTime = Number(controller?.scheduledTime);

  if (!Number.isFinite(scheduledTime)) {
    return new Date();
  }

  return new Date(scheduledTime < 10_000_000_000 ? scheduledTime * 1000 : scheduledTime);
}

function getCronWindowMinutes(value) {
  const minutes = Number(value);

  return Number.isInteger(minutes) && minutes > 0 && minutes <= 30
    ? minutes
    : DEFAULT_CRON_WINDOW_MINUTES;
}

function tablePath(env) {
  return encodeURIComponent(env.SUPABASE_PUSH_SUBSCRIPTIONS_TABLE || DEFAULT_TABLE_NAME);
}

function notificationEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_NOTIFICATION_EVENTS_TABLE || DEFAULT_NOTIFICATION_EVENTS_TABLE);
}

function toRecord(row) {
  return {
    id: row.id,
    subscription: row.subscription,
    routineStartMinutes: row.routine_start_minutes,
    timezone: row.timezone,
    coarseLatitude: row.coarse_latitude ?? null,
    coarseLongitude: row.coarse_longitude ?? null,
    preferredLanguage: row.preferred_language ?? null,
    installationId: row.installation_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSentDate: row.last_sent_date
  };
}

function assertConfigured(env) {
  [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_SUBJECT"
  ].forEach((key) => {
    if (!env[key]) {
      throw new Error(`${key} is required.`);
    }
  });
}

function isEnabled(value) {
  return String(value).toLowerCase() === "true";
}

function isSubscriptionGone(error) {
  return error?.statusCode === 404 || error?.statusCode === 410;
}

class PushSendError extends Error {
  constructor(statusCode, responseBody) {
    super(`Push service request failed with ${statusCode}. ${responseBody}`);
    this.name = "PushSendError";
    this.statusCode = statusCode;
  }
}
