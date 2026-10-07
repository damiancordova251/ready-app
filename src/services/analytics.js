import { APP_CONFIG } from "../config.js";
import { getLocale } from "../i18n/i18n.js";
import { INSTALLATION_ID_STORAGE_KEY } from "../constants/storageKeys.js";
import { getDeviceContext } from "../utils/deviceContext.js";

// Centralized event tracker for the expanded analytics schema (see
// supabase/migrations/). This is additive alongside — not a replacement for —
// pilotAnalytics.js's original trackPilotEvent(), which keeps working exactly
// as before for full backward compatibility. All *new* instrumentation added
// after this module was introduced should call trackEvent() here instead of
// posting to Supabase-backed endpoints directly, so there is one place that
// owns the request shape, retry-free fire-and-forget behavior, and failure
// handling.

// Kept in sync with server/analyticsService.js and
// functions/_shared/analytics.js's own allowlists; the backend is the source
// of truth for validation, this is just to fail fast/quietly on typos.
const ALLOWED_EVENT_NAMES = new Set([
  "app_installation_seen",
  "session_started",
  "session_ended",
  "language_changed",
  "share_opened",
  "share_completed",
  "install_instructions_viewed",
  "notification_scheduled",
  "notification_opened",
  "notification_dismissed",
  "notification_opt_in",
  "notification_opt_out",
  "recommendation_generated",
  "recommendation_feedback",
  "checklist_completed",
  "referral_link_visited",
  "feedback_prompt_shown",
  "feedback_prompt_postponed",
  "feedback_prompt_dismissed",
  "feedback_submitted",
  "client_error",
  "api_performance"
]);

export function trackEvent(eventName, metadata = {}) {
  if (!ALLOWED_EVENT_NAMES.has(eventName)) {
    return;
  }

  const installationId = getInstallationId();

  if (!installationId) {
    return;
  }

  const payload = JSON.stringify({
    installationId,
    eventName,
    language: getLocale(),
    metadata: sanitizeMetadata(metadata),
    occurredAt: new Date().toISOString(),
    // Keeps app_installations describing the device it belongs to, rather
    // than leaving those columns at their defaults.
    deviceContext: getDeviceContext()
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });

    if (navigator.sendBeacon(apiUrl("/api/analytics/events"), blob)) {
      return;
    }
  }

  fetch(apiUrl("/api/analytics/events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

// A small, separate latency sample — not part of the general event stream,
// since api_performance_events has typed duration/status columns rather than
// a metadata blob. Best-effort and silent, same as trackEvent().
export function trackApiPerformance({ endpoint, durationMs, statusCode }) {
  const installationId = getInstallationId();

  if (!installationId) {
    return;
  }

  const payload = JSON.stringify({
    installationId,
    endpoint,
    durationMs,
    statusCode,
    occurredAt: new Date().toISOString()
  });

  fetch(apiUrl("/api/performance-events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

// The rich, typed counterpart to trackEvent("recommendation_generated", ...):
// what weather conditions produced which checklist, so recommendation
// usefulness can eventually be measured. weatherConditions is a small
// summary (temps/precip/wind/condition code) — never exact coordinates.
export function recordRecommendationEvent({ weatherConditions, expectedTimeAwayHours, items, personalized, generationTimeMs }) {
  const installationId = getInstallationId();

  if (!installationId) {
    return;
  }

  const payload = JSON.stringify({
    installationId,
    weatherConditions: weatherConditions ?? {},
    expectedTimeAwayHours: expectedTimeAwayHours ?? null,
    items: Array.isArray(items) ? items : [],
    personalized: Boolean(personalized),
    generationTimeMs: generationTimeMs ?? null,
    occurredAt: new Date().toISOString()
  });

  fetch(apiUrl("/api/recommendation-events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

// Reuses the same anonymous device id pilotAnalytics.js already generates, so
// the two event tables can be joined by the same installation identity
// without introducing a second id.
function getInstallationId() {
  try {
    return window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY) ?? null;
  } catch (error) {
    return null;
  }
}

// Bounded, allow-listed fields only — mirrors pilotAnalytics.js's own
// sanitizer so accidental large payloads or unexpected personal fields never
// reach the backend.
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const clean = {};

  Object.entries(metadata).forEach(([key, value]) => {
    if (typeof value === "string") {
      clean[key] = value.slice(0, 120);
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

function apiUrl(path) {
  const baseUrl = APP_CONFIG.pushApiBaseUrl || window.location.origin;

  return new URL(path, baseUrl).toString();
}
