import webPush from "web-push";
import { createChecklistReminder } from "../src/domain/reminders.js";
import { buildNotificationCopy, buildReminderWeatherUrl, parseReminderWeather } from "../src/domain/notificationCopy.js";
import { recordNotificationScheduled } from "./notificationEventStore.js";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// Reads VAPID keys from environment variables and configures web-push only when
// the backend has everything needed to send browser push notifications.
export function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    return {
      configured: false,
      publicKey: publicKey ?? null
    };
  }

  webPush.setVapidDetails(subject, publicKey, privateKey);

  return {
    configured: true,
    publicKey
  };
}

// Sends the reminder payload to one stored subscription. When the
// subscription has a coarse location saved (opt-in, set only when the user
// last enabled/updated reminders — see services/notificationsApi.js), the
// message becomes weather-aware via notificationCopy.js; otherwise, and on
// any weather-fetch failure, it falls back to the existing generic copy.
export async function sendReadyChecklistPush(record) {
  const { reminder, variant, weatherContext } = await buildReminderPayload(record);
  const notificationEventId = await recordNotificationScheduled({
    installationId: record.installationId,
    notificationType: "scheduled_reminder",
    messageVariant: variant,
    weatherContext
  });
  const payload = JSON.stringify({ ...reminder, notificationEventId });

  return webPush.sendNotification(record.subscription, payload);
}

async function buildReminderPayload(record) {
  const fallback = createChecklistReminder({ url: "/" });

  if (!Number.isFinite(record.coarseLatitude) || !Number.isFinite(record.coarseLongitude)) {
    return { reminder: fallback, variant: "generic", weatherContext: null };
  }

  try {
    const weatherSummary = await fetchCoarseWeatherSummary(record.coarseLatitude, record.coarseLongitude);
    const copy = buildNotificationCopy({
      language: record.preferredLanguage ?? "en",
      weatherSummary
    });

    return {
      reminder: { ...fallback, title: copy.title, body: copy.body },
      variant: copy.variant,
      weatherContext: weatherSummary
    };
  } catch (error) {
    return { reminder: fallback, variant: "generic", weatherContext: null };
  }
}

// A small, coarse-only Open-Meteo request — just enough to pick one message
// variant, not the full recommendation engine's forecast window.
async function fetchCoarseWeatherSummary(latitude, longitude) {
  const response = await fetch(buildReminderWeatherUrl(OPEN_METEO_URL, latitude, longitude));

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed with ${response.status}.`);
  }

  return parseReminderWeather(await response.json());
}


// Browsers return 404/410 when a push subscription is no longer valid.
export function isSubscriptionGone(error) {
  return error?.statusCode === 404 || error?.statusCode === 410;
}
