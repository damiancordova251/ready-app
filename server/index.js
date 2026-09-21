// Express server entry point: serves the PWA, exposes push/analytics APIs, and
// starts the reminder scheduler when required backend configuration exists.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureWebPush,
  isSubscriptionGone,
  sendReadyChecklistPush
} from "./pushService.js";
import { startReminderScheduler } from "./scheduler.js";
import {
  getAllSubscriptions,
  getSubscription,
  isSubscriptionStoreConfigured,
  markReminderSent,
  removeSubscription,
  toPublicSubscription,
  upsertSubscription
} from "./subscriptionStore.js";
import {
  insertPilotEvent,
  isPilotEventStoreConfigured
} from "./pilotEventStore.js";
import {
  ALLOWED_EVENT_NAMES,
  isAnalyticsStoreConfigured,
  recordAnalyticsEvent,
  recordApiPerformanceEvent,
  recordClientError,
  recordFeedbackSubmission,
  recordRecommendationEvent
} from "./analyticsService.js";
import {
  getOrCreateReferralCode,
  isReferralStoreConfigured,
  markReferralVisitConverted,
  recordReferralVisit
} from "./referralStore.js";
import {
  deleteInstallationData,
  isDataDeletionConfigured
} from "./dataDeletionService.js";
import {
  isNotificationEventStoreConfigured,
  recordNotificationDismissed,
  recordNotificationOpened
} from "./notificationEventStore.js";
import {
  isValidRoutineStartMinutes,
  isValidTimezone
} from "./time.js";

// File paths and hosting settings support both local development and Render's
// platform-provided PORT/HOST behavior.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const schedulerIntervalMs = Number(process.env.SCHEDULER_INTERVAL_MS) || 30000;
const pushConfig = configureWebPush();

// Only these anonymous event names are accepted from the frontend pilot
// analytics endpoint.
const pilotEventTypes = new Set([
  "app_opened",
  "checklist_generated",
  "checklist_completed",
  "reminders_enabled",
  "notification_clicked",
  "weather_screen_viewed",
  "location_updated"
]);

app.use(express.json({ limit: "128kb" }));

// Health check reports whether push keys and persistent subscription storage are
// configured, which is useful during local and hosted deployment testing.
app.get("/api/health", async (req, res) => {
  const storeConfigured = isSubscriptionStoreConfigured();

  try {
    const subscriptions = storeConfigured ? await getAllSubscriptions() : [];

    res.json({
      ok: true,
      vapidConfigured: pushConfig.configured,
      subscriptionStoreConfigured: storeConfigured,
      subscriptions: subscriptions.length
    });
  } catch (error) {
    console.error("Subscription storage health check failed.", error);
    res.status(503).json({
      ok: false,
      vapidConfigured: pushConfig.configured,
      subscriptionStoreConfigured: storeConfigured,
      error: "Subscription storage is unavailable."
    });
  }
});

// Exposes the public VAPID key so the browser can create a PushSubscription.
app.get("/api/push/public-key", (req, res) => {
  if (!pushConfig.configured) {
    res.status(503).json({
      error: "VAPID keys are not configured on the reminder server."
    });
    return;
  }

  res.json({
    publicKey: pushConfig.publicKey
  });
});

// Saves or updates a browser push subscription with its reminder schedule.
app.post("/api/push/subscriptions", async (req, res) => {
  if (!pushConfig.configured) {
    res.status(503).json({
      error: "VAPID keys are not configured on the reminder server."
    });
    return;
  }

  const parsed = parseSubscriptionPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const record = await upsertSubscription(parsed.value);

    res.status(201).json({
      subscription: toPublicSubscription(record)
    });
  } catch (error) {
    sendSubscriptionStoreError(res, error);
  }
});

// Lists public subscription summaries for manual pilot debugging; it never
// exposes the full push subscription JSON.
app.get("/api/push/subscriptions", async (req, res) => {
  try {
    const subscriptions = await getAllSubscriptions();

    res.json({
      count: subscriptions.length,
      subscriptions: subscriptions.map(toPublicSubscription)
    });
  } catch (error) {
    sendSubscriptionStoreError(res, error);
  }
});

// Removes a saved subscription so scheduled reminders stop immediately. This
// is what "turn reminders off" in the app actually calls.
app.delete("/api/push/subscriptions/:id", async (req, res) => {
  try {
    await removeSubscription(req.params.id);
    res.status(204).send();
  } catch (error) {
    sendSubscriptionStoreError(res, error);
  }
});

// Sends an immediate backend push to one subscription or all subscriptions for
// end-to-end notification testing.
app.post("/api/push/test", async (req, res) => {
  if (!pushConfig.configured) {
    res.status(503).json({
      error: "VAPID keys are not configured on the reminder server."
    });
    return;
  }

  let targets;

  try {
    const subscriptionId = req.body?.subscriptionId;
    targets = subscriptionId
      ? [await getSubscription(subscriptionId)].filter(Boolean)
      : await getAllSubscriptions();
  } catch (error) {
    sendSubscriptionStoreError(res, error);
    return;
  }

  if (targets.length === 0) {
    res.status(404).json({
      error: "No matching push subscription found."
    });
    return;
  }

  const results = await Promise.allSettled(targets.map(sendReminder));

  res.json({
    sent: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length
  });
});

// Accepts anonymous pilot activity events. Logging failures are intentionally
// soft so analytics never break the app experience.
app.post("/api/pilot-events", async (req, res) => {
  if (!isPilotEventStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const parsed = parsePilotEventPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await insertPilotEvent(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Pilot event logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Accepts the expanded analytics event stream from src/services/analytics.js.
// Soft-fails like /api/pilot-events: analytics must never break the app.
app.post("/api/analytics/events", async (req, res) => {
  if (!isAnalyticsStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const parsed = parseAnalyticsEventPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await recordAnalyticsEvent(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Analytics event logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Accepts a feedback-prompt submission (rating + optional comment).
app.post("/api/feedback", async (req, res) => {
  if (!isAnalyticsStoreConfigured()) {
    res.status(503).json({ error: "Feedback storage is not configured." });
    return;
  }

  const parsed = parseFeedbackPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await recordFeedbackSubmission(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Feedback submission failed.", error);
    res.status(503).json({ error: "Feedback could not be saved right now." });
  }
});

// Returns (creating on first call) the installation's own referral code, used
// to build its share link.
app.post("/api/referrals/code", async (req, res) => {
  if (!isReferralStoreConfigured()) {
    res.status(503).json({ error: "Referral storage is not configured." });
    return;
  }

  const installationId = req.body?.installationId;

  if (!isValidAnonymousDeviceId(installationId)) {
    res.status(400).json({ error: "A valid installation id is required." });
    return;
  }

  try {
    const code = await getOrCreateReferralCode(installationId);
    res.status(200).json({ code });
  } catch (error) {
    console.error("Referral code lookup failed.", error);
    res.status(503).json({ error: "Referral code is not available right now." });
  }
});

// Logs one visit to a referral link (fired once per landing with ?ref=...).
app.post("/api/referrals/visits", async (req, res) => {
  if (!isReferralStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const referralCode = req.body?.referralCode;
  const visitorInstallationId = req.body?.installationId;

  if (!isValidReferralCode(referralCode)) {
    res.status(400).json({ error: "A valid referral code is required." });
    return;
  }

  if (visitorInstallationId !== undefined && !isValidAnonymousDeviceId(visitorInstallationId)) {
    res.status(400).json({ error: "installationId must be a valid installation id, or omitted." });
    return;
  }

  const shareChannel = typeof req.body?.shareChannel === "string" ? req.body.shareChannel.slice(0, 40) : null;

  try {
    const id = await recordReferralVisit({ referralCode, visitorInstallationId: visitorInstallationId ?? null, shareChannel });
    res.status(201).json({ id });
  } catch (error) {
    console.error("Referral visit logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Marks a previously-logged visit as having resulted in a completed
// installation (called once, when this device finishes onboarding).
app.post("/api/referrals/visits/:id/convert", async (req, res) => {
  if (!isReferralStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const visitId = req.params.id;
  const installationId = req.body?.installationId;
  const referralCode = req.body?.referralCode;

  if (!isValidUuid(visitId)) {
    res.status(400).json({ error: "A valid visit id is required." });
    return;
  }

  if (!isValidAnonymousDeviceId(installationId) || !isValidReferralCode(referralCode)) {
    res.status(400).json({ error: "A valid installationId and referralCode are required." });
    return;
  }

  try {
    await markReferralVisitConverted({ visitId, installationId, referralCode });
    res.status(204).send();
  } catch (error) {
    console.error("Referral conversion failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Called by the service worker on notification click/close. Best-effort and
// idempotent: always responds 204 for a well-formed id, whether or not a
// matching row exists, so this never becomes a way to probe row existence.
app.post("/api/notifications/events/:id/opened", async (req, res) => {
  await handleNotificationEventUpdate(req, res, recordNotificationOpened);
});

app.post("/api/notifications/events/:id/dismissed", async (req, res) => {
  await handleNotificationEventUpdate(req, res, recordNotificationDismissed);
});

async function handleNotificationEventUpdate(req, res, updateFn) {
  if (!isNotificationEventStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "A valid notification event id is required." });
    return;
  }

  await updateFn(req.params.id);
  res.status(204).send();
}

// Global client-side error reports (window.onerror/unhandledrejection).
// Soft-fails like the other analytics endpoints: error reporting must never
// itself surface an error to the user.
app.post("/api/client-errors", async (req, res) => {
  if (!isAnalyticsStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const parsed = parseClientErrorPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await recordClientError(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Client error logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Lightweight API-latency samples (currently just the weather/recommendation
// fetch). Soft-fails for the same reason as client-errors above.
app.post("/api/performance-events", async (req, res) => {
  if (!isAnalyticsStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const parsed = parsePerformanceEventPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await recordApiPerformanceEvent(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Performance event logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// The rich, typed counterpart to the flat "recommendation_generated"
// analytics event. Soft-fails for the same reason as the other analytics
// endpoints.
app.post("/api/recommendation-events", async (req, res) => {
  if (!isAnalyticsStoreConfigured()) {
    res.status(202).json({ ok: false });
    return;
  }

  const parsed = parseRecommendationEventPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    await recordRecommendationEvent(parsed.value);
    res.status(204).send();
  } catch (error) {
    console.error("Recommendation event logging failed.", error);
    res.status(202).json({ ok: false });
  }
});

// Backs the "Delete my data" control in Settings. Unlike the analytics
// endpoints, this one does NOT soft-fail: if deletion did not happen the user
// must be told so, never shown a false confirmation.
app.delete("/api/installations/:id", async (req, res) => {
  if (!isDataDeletionConfigured()) {
    res.status(503).json({ error: "Data deletion is not available right now." });
    return;
  }

  if (!isValidAnonymousDeviceId(req.params.id)) {
    res.status(400).json({ error: "A valid installation id is required." });
    return;
  }

  try {
    const deleted = await deleteInstallationData(req.params.id);
    res.status(200).json({ ok: true, deleted });
  } catch (error) {
    console.error("Data deletion failed.", error);
    res.status(503).json({ error: "Data could not be deleted right now. Please try again later." });
  }
});

servePwaFiles(app);

// Starts the web server first, then starts scheduled reminders only when VAPID
// keys and Supabase subscription storage are configured.
app.listen(port, host, () => {
  console.log(`Ready running at http://${host}:${port}`);

  if (!isExpressSchedulerEnabled()) {
    console.log("Express reminder scheduler disabled by ENABLE_EXPRESS_SCHEDULER=false.");
    return;
  }

  if (!pushConfig.configured) {
    console.log("VAPID keys are missing. Copy .env.example to .env and add generated keys.");
    return;
  }

  if (!isSubscriptionStoreConfigured()) {
    console.log("Supabase storage is missing. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.");
    return;
  }

  startReminderScheduler({
    getSubscriptions: getAllSubscriptions,
    markSent: markReminderSent,
    removeSubscription,
    sendReminder,
    intervalMs: schedulerIntervalMs
  });
  console.log(`Reminder scheduler running every ${schedulerIntervalMs}ms.`);
});

// Wraps push delivery so expired subscriptions can be identified and removed by
// the scheduler.
async function sendReminder(record) {
  try {
    await sendReadyChecklistPush(record);
  } catch (error) {
    if (isSubscriptionGone(error)) {
      error.subscriptionGone = true;
    }

    throw error;
  }
}

function isExpressSchedulerEnabled() {
  return String(process.env.ENABLE_EXPRESS_SCHEDULER ?? "true").toLowerCase() !== "false";
}

// Validates the subscription payload before it reaches Supabase or Web Push.
// coarseLatitude/coarseLongitude/preferredLanguage are optional: existing
// clients (and the fallback if a user declines) omit them entirely, and the
// scheduler falls back to the generic reminder message when they're absent.
function parseSubscriptionPayload(body) {
  const subscription = body?.subscription;
  const routineStartMinutes = Number(body?.routineStartMinutes);
  const timezone = body?.timezone;
  const coarseLocation = parseOptionalCoarseLocation(body?.coarseLatitude, body?.coarseLongitude);

  if (!isValidPushSubscription(subscription)) {
    return {
      ok: false,
      error: "A valid push subscription is required."
    };
  }

  if (!isValidRoutineStartMinutes(routineStartMinutes)) {
    return {
      ok: false,
      error: "A valid 30-minute routine start time is required."
    };
  }

  if (!isValidTimezone(timezone)) {
    return {
      ok: false,
      error: "A valid IANA timezone is required."
    };
  }

  if (coarseLocation === undefined) {
    return {
      ok: false,
      error: "coarseLatitude and coarseLongitude must both be finite numbers, or both omitted."
    };
  }

  const installationId = body?.installationId;

  return {
    ok: true,
    value: {
      subscription,
      routineStartMinutes,
      timezone,
      coarseLatitude: coarseLocation?.coarseLatitude ?? null,
      coarseLongitude: coarseLocation?.coarseLongitude ?? null,
      preferredLanguage: isValidLanguage(body?.preferredLanguage) ? body.preferredLanguage : null,
      installationId: isValidAnonymousDeviceId(installationId) ? installationId : null
    }
  };
}

// Returns null when both are omitted (valid — coarse location is optional),
// an object when both are present and finite, or undefined for a malformed
// partial/invalid pair (rejected by the caller).
function parseOptionalCoarseLocation(rawLatitude, rawLongitude) {
  if (rawLatitude === undefined && rawLongitude === undefined) {
    return null;
  }

  const coarseLatitude = Number(rawLatitude);
  const coarseLongitude = Number(rawLongitude);

  if (
    !Number.isFinite(coarseLatitude) || coarseLatitude < -90 || coarseLatitude > 90
    || !Number.isFinite(coarseLongitude) || coarseLongitude < -180 || coarseLongitude > 180
  ) {
    return undefined;
  }

  return { coarseLatitude, coarseLongitude };
}

function isValidLanguage(value) {
  return typeof value === "string" && /^[a-z]{2}$/.test(value);
}

// Validates the general analytics event payload from src/services/analytics.js.
function parseAnalyticsEventPayload(body) {
  const installationId = body?.installationId;
  const eventName = body?.eventName;

  if (!isValidAnonymousDeviceId(installationId)) {
    return {
      ok: false,
      error: "A valid installation id is required."
    };
  }

  if (typeof eventName !== "string" || !ALLOWED_EVENT_NAMES.has(eventName)) {
    return {
      ok: false,
      error: "A valid event name is required."
    };
  }

  return {
    ok: true,
    value: {
      installationId,
      eventName,
      category: typeof body?.category === "string" ? body.category.slice(0, 40) : null,
      language: isValidLanguage(body?.language) ? body.language : null,
      metadata: sanitizeAnalyticsMetadata(body?.metadata),
      occurredAt: isValidIsoDate(body?.occurredAt) ? body.occurredAt : new Date().toISOString()
    }
  };
}

// Validates a feedback-prompt submission.
function parseFeedbackPayload(body) {
  const installationId = body?.installationId;

  if (!isValidAnonymousDeviceId(installationId)) {
    return {
      ok: false,
      error: "A valid installation id is required."
    };
  }

  const rating = Number.isInteger(body?.rating) && body.rating >= 1 && body.rating <= 5
    ? body.rating
    : null;
  const comment = typeof body?.comment === "string" ? body.comment.slice(0, 2000) : null;
  const clothingSuggestions = typeof body?.clothingSuggestions === "string"
    ? body.clothingSuggestions.slice(0, 500)
    : null;

  return {
    ok: true,
    value: {
      installationId,
      rating,
      comment,
      clothingSuggestions,
      category: typeof body?.category === "string" ? body.category.slice(0, 40) : null,
      appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 20) : null,
      language: isValidLanguage(body?.language) ? body.language : null,
      fromScheduledPrompt: Boolean(body?.fromScheduledPrompt),
      allowFollowUp: Boolean(body?.allowFollowUp)
    }
  };
}

// installationId is optional here (unlike feedback/analytics-events): an
// error occurring before an anonymous id is even readable is still worth
// recording.
function parseClientErrorPayload(body) {
  const errorType = body?.errorType;

  if (typeof errorType !== "string" || errorType.length === 0 || errorType.length > 60) {
    return {
      ok: false,
      error: "A valid errorType is required."
    };
  }

  const installationId = body?.installationId;

  return {
    ok: true,
    value: {
      installationId: isValidAnonymousDeviceId(installationId) ? installationId : null,
      errorType,
      message: typeof body?.message === "string" ? body.message.slice(0, 500) : null,
      stackExcerpt: typeof body?.stackExcerpt === "string" ? body.stackExcerpt.slice(0, 1000) : null,
      appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 20) : null,
      platform: typeof body?.platform === "string" ? body.platform.slice(0, 200) : null,
      occurredAt: isValidIsoDate(body?.occurredAt) ? body.occurredAt : new Date().toISOString()
    }
  };
}

function parsePerformanceEventPayload(body) {
  const endpoint = body?.endpoint;

  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 80) {
    return {
      ok: false,
      error: "A valid endpoint is required."
    };
  }

  const installationId = body?.installationId;
  const durationMs = Number(body?.durationMs);
  const statusCode = Number(body?.statusCode);

  return {
    ok: true,
    value: {
      installationId: isValidAnonymousDeviceId(installationId) ? installationId : null,
      endpoint,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
      statusCode: Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : null,
      occurredAt: isValidIsoDate(body?.occurredAt) ? body.occurredAt : new Date().toISOString()
    }
  };
}

function parseRecommendationEventPayload(body) {
  const installationId = body?.installationId;

  if (!isValidAnonymousDeviceId(installationId)) {
    return {
      ok: false,
      error: "A valid installation id is required."
    };
  }

  const expectedTimeAwayHours = Number(body?.expectedTimeAwayHours);
  const generationTimeMs = Number(body?.generationTimeMs);

  return {
    ok: true,
    value: {
      installationId,
      weatherConditions: sanitizeWeatherConditions(body?.weatherConditions),
      expectedTimeAwayHours: Number.isFinite(expectedTimeAwayHours) ? expectedTimeAwayHours : null,
      items: sanitizeRecommendationItems(body?.items),
      personalized: Boolean(body?.personalized),
      generationTimeMs: Number.isFinite(generationTimeMs) && generationTimeMs >= 0 ? Math.round(generationTimeMs) : null,
      occurredAt: isValidIsoDate(body?.occurredAt) ? body.occurredAt : new Date().toISOString()
    }
  };
}

// Only finite numbers pass through; never exact coordinates (there is no
// latitude/longitude field to begin with — just temps/precip/wind/condition).
function sanitizeWeatherConditions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const clean = {};

  Object.entries(value).forEach(([key, fieldValue]) => {
    if (typeof key !== "string" || key.length > 40) {
      return;
    }

    const number = Number(fieldValue);
    clean[key] = Number.isFinite(number) ? number : null;
  });

  return clean;
}

// Bounded to a small array of plain descriptor objects — the same structured
// shape domain/recommendation.js already produces, never free-form text.
function sanitizeRecommendationItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 30).map((item) => (item && typeof item === "object" && !Array.isArray(item) ? item : null)).filter(Boolean);
}

function isValidIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// Bounded, allow-listed fields only, mirroring sanitizePilotEventMetadata's
// approach but generalized since analytics_events' metadata shape varies by
// event name.
function sanitizeAnalyticsMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const clean = {};

  Object.entries(metadata).forEach(([key, value]) => {
    if (typeof key !== "string" || key.length > 60) {
      return;
    }

    if (typeof value === "string") {
      clean[key] = value.slice(0, 200);
      return;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
      return;
    }

    if (typeof value === "boolean") {
      clean[key] = value;
    }
  });

  return clean;
}

function isValidPushSubscription(subscription) {
  return typeof subscription?.endpoint === "string"
    && subscription.endpoint.length > 0
    && typeof subscription.keys?.p256dh === "string"
    && typeof subscription.keys?.auth === "string";
}

// Validates and sanitizes anonymous pilot events before inserting them.
function parsePilotEventPayload(body) {
  const anonymousDeviceId = body?.anonymousDeviceId;
  const eventType = body?.eventType;

  if (!isValidAnonymousDeviceId(anonymousDeviceId)) {
    return {
      ok: false,
      error: "A valid anonymous device id is required."
    };
  }

  if (!pilotEventTypes.has(eventType)) {
    return {
      ok: false,
      error: "A valid pilot event type is required."
    };
  }

  return {
    ok: true,
    value: {
      anonymousDeviceId,
      eventType,
      metadata: sanitizePilotEventMetadata(body?.metadata)
    }
  };
}

function isValidAnonymousDeviceId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 80
    && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isValidReferralCode(value) {
  return typeof value === "string" && /^[A-Z0-9]{4,16}$/.test(value);
}

function isValidUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sanitizePilotEventMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const clean = {};

  if (typeof metadata.source === "string") {
    clean.source = metadata.source.slice(0, 40);
  }

  if (Number.isInteger(metadata.itemCount)) {
    clean.itemCount = Math.max(0, Math.min(metadata.itemCount, 20));
  }

  if (Number.isInteger(metadata.expected_time_away_hours)) {
    clean.expected_time_away_hours = Math.max(3, Math.min(metadata.expected_time_away_hours, 15));
  }

  if (typeof metadata.hasItems === "boolean") {
    clean.hasItems = metadata.hasItems;
  }

  if (typeof metadata.standalone === "boolean") {
    clean.standalone = metadata.standalone;
  }

  if (typeof metadata.permission === "string") {
    clean.permission = metadata.permission.slice(0, 20);
  }

  return clean;
}

// Keeps subscription storage errors consistent across endpoints.
function sendSubscriptionStoreError(res, error) {
  console.error("Subscription storage request failed.", error);
  res.status(503).json({
    error: "Subscription storage is unavailable. Check Supabase configuration and table setup."
  });
}

// Serves the static PWA files from the same Express app as the API.
function servePwaFiles(appInstance) {
  appInstance.use("/icons", express.static(path.join(projectRoot, "icons")));
  appInstance.use("/src", express.static(path.join(projectRoot, "src")));

  appInstance.get("/", (req, res) => {
    res.sendFile(path.join(projectRoot, "index.html"));
  });

  [
    "index.html",
    "privacy.html",
    "terms.html",
    "styles.css",
    "manifest.webmanifest",
    "sw.js"
  ].forEach((fileName) => {
    appInstance.get(`/${fileName}`, (req, res) => {
      res.sendFile(path.join(projectRoot, fileName));
    });
  });
}
