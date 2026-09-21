const DEFAULT_PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";
const DEFAULT_PILOT_EVENTS_TABLE = "pilot_events";
const DEFAULT_APP_INSTALLATIONS_TABLE = "app_installations";
const DEFAULT_ANALYTICS_EVENTS_TABLE = "analytics_events";
const DEFAULT_FEEDBACK_SUBMISSIONS_TABLE = "feedback_submissions";
const DEFAULT_REFERRALS_TABLE = "referrals";
const DEFAULT_REFERRAL_VISITS_TABLE = "referral_visits";
const DEFAULT_NOTIFICATION_EVENTS_TABLE = "notification_events";
const DEFAULT_CLIENT_ERRORS_TABLE = "client_errors";
const DEFAULT_API_PERFORMANCE_EVENTS_TABLE = "api_performance_events";
const DEFAULT_RECOMMENDATION_EVENTS_TABLE = "recommendation_events";
const MAX_JSON_BODY_LENGTH = 128 * 1024;
const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const REFERRAL_CODE_LENGTH = 7;
const MAX_REFERRAL_CODE_ATTEMPTS = 5;
const PILOT_EVENT_TYPES = new Set([
  "app_opened",
  "checklist_generated",
  "checklist_completed",
  "reminders_enabled",
  "notification_clicked",
  "weather_screen_viewed",
  "location_updated"
]);
const SUBSCRIPTION_SELECT_COLUMNS = "id,subscription,routine_start_minutes,timezone,coarse_latitude,coarse_longitude,preferred_language,installation_id,last_sent_date,created_at,updated_at";

// Kept in sync with src/services/analytics.js and server/analyticsService.js's
// own allowlists.
export const ALLOWED_EVENT_NAMES = new Set([
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

// Shared API response helpers keep all Pages Functions returning JSON with the
// same no-store behavior as small backend endpoints.
export function json(data, { status = 200 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function empty({ status = 204 } = {}) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export async function readJson(request) {
  const text = await request.text();

  if (!text) {
    return {
      ok: true,
      value: {}
    };
  }

  if (text.length > MAX_JSON_BODY_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: "Request body is too large."
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: "Request body must be valid JSON."
    };
  }
}

// Pages Functions receive secrets through context.env, keeping service-role and
// VAPID private keys out of frontend JavaScript.
export function isPushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export function isSubscriptionStoreConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isPilotEventStoreConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isReferralStoreConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isNotificationEventStoreConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

// Recorded at send time by workers/reminder-scheduler, immediately after the
// push provider accepts the notification. Mirrors
// server/notificationEventStore.js's recordNotificationScheduled. Never
// throws — returns null on any failure so a storage hiccup never blocks
// sending the actual reminder.
export async function recordNotificationScheduled({ installationId, notificationType, messageVariant, weatherContext }, env) {
  if (!installationId || !isNotificationEventStoreConfigured(env)) {
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
          installation_id: installationId,
          notification_type: notificationType,
          message_variant: messageVariant ?? null,
          weather_context: weatherContext ?? null,
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

export async function recordNotificationOpened(id, env) {
  await updateNotificationEventTimestamp(id, "opened_at", env);
}

export async function recordNotificationDismissed(id, env) {
  await updateNotificationEventTimestamp(id, "dismissed_at", env);
}

async function updateNotificationEventTimestamp(id, column, env) {
  try {
    await supabaseFetch(env, {
      path: notificationEventsTablePath(env),
      searchParams: new URLSearchParams({ id: `eq.${id}` }),
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ [column]: new Date().toISOString() })
      }
    });
  } catch (error) {
    console.error(`notification_events.${column} update failed.`, error);
  }
}

function notificationEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_NOTIFICATION_EVENTS_TABLE || DEFAULT_NOTIFICATION_EVENTS_TABLE);
}

// Structured client-side error records. Mirrors
// server/analyticsService.js's recordClientError.
export async function recordClientError({ installationId, errorType, message, stackExcerpt, appVersion, platform, occurredAt }, env) {
  await supabaseFetch(env, {
    path: clientErrorsTablePath(env),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        installation_id: installationId ?? null,
        error_type: errorType,
        message: message ?? null,
        stack_excerpt: stackExcerpt ?? null,
        app_version: appVersion ?? null,
        platform: platform ?? null,
        occurred_at: occurredAt ?? new Date().toISOString()
      })
    }
  });
}

// Mirrors server/analyticsService.js's recordApiPerformanceEvent.
export async function recordApiPerformanceEvent({ installationId, endpoint, durationMs, statusCode, occurredAt }, env) {
  await supabaseFetch(env, {
    path: apiPerformanceEventsTablePath(env),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        installation_id: installationId ?? null,
        endpoint,
        duration_ms: durationMs ?? null,
        status_code: statusCode ?? null,
        occurred_at: occurredAt ?? new Date().toISOString()
      })
    }
  });
}

function clientErrorsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_CLIENT_ERRORS_TABLE || DEFAULT_CLIENT_ERRORS_TABLE);
}

function apiPerformanceEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_API_PERFORMANCE_EVENTS_TABLE || DEFAULT_API_PERFORMANCE_EVENTS_TABLE);
}

// The rich counterpart to the flat "recommendation_generated" analytics
// event. Mirrors server/analyticsService.js's recordRecommendationEvent,
// including the app_installations upsert-first-for-the-FK pattern.
export async function recordRecommendationEvent({ installationId, weatherConditions, expectedTimeAwayHours, items, personalized, generationTimeMs, occurredAt }, env) {
  await upsertAppInstallation(installationId, env);

  await supabaseFetch(env, {
    path: recommendationEventsTablePath(env),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        installation_id: installationId,
        occurred_at: occurredAt ?? new Date().toISOString(),
        expected_time_away_hours: expectedTimeAwayHours ?? null,
        weather_conditions: weatherConditions ?? {},
        items: items ?? [],
        personalized: Boolean(personalized),
        generation_time_ms: generationTimeMs ?? null
      })
    }
  });
}

function recommendationEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_RECOMMENDATION_EVENTS_TABLE || DEFAULT_RECOMMENDATION_EVENTS_TABLE);
}

// Subscription storage mirrors the Express API contract while using Supabase
// REST calls that run in Cloudflare's Worker runtime. Schedule changes reset
// duplicate-reminder state so the updated time can send later the same day.
export async function upsertSubscription(input, env) {
  const subscription = input.subscription;
  const id = await createSubscriptionId(subscription.endpoint);
  const existing = await getSubscription(id, env);
  const now = new Date().toISOString();
  const scheduleChanged = hasScheduleChanged(existing, input);

  if (input.installationId) {
    // Satisfies push_subscriptions.installation_id's FK to app_installations;
    // idempotent, so safe on every subscribe/resubscribe.
    await upsertAppInstallation(input.installationId, env);
  }

  const row = {
    id,
    subscription,
    routine_start_minutes: input.routineStartMinutes,
    timezone: input.timezone,
    coarse_latitude: input.coarseLatitude ?? null,
    coarse_longitude: input.coarseLongitude ?? null,
    preferred_language: input.preferredLanguage ?? null,
    installation_id: input.installationId ?? null,
    last_sent_date: scheduleChanged ? null : (existing?.lastSentDate ?? null),
    updated_at: now
  };

  const response = await supabaseFetch(env, {
    path: pushSubscriptionsTablePath(env),
    searchParams: new URLSearchParams({
      on_conflict: "id",
      select: SUBSCRIPTION_SELECT_COLUMNS
    }),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(row)
    }
  });
  const rows = await response.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;

  if (!saved) {
    throw new Error("Subscription storage did not return a saved row.");
  }

  return toSubscriptionRecord(saved);
}

export async function getSubscription(id, env) {
  const response = await supabaseFetch(env, {
    path: pushSubscriptionsTablePath(env),
    searchParams: new URLSearchParams({
      select: SUBSCRIPTION_SELECT_COLUMNS,
      id: `eq.${id}`,
      limit: "1"
    })
  });
  const rows = await response.json();

  return rows[0] ? toSubscriptionRecord(rows[0]) : null;
}

export async function getAllSubscriptions(env) {
  const response = await supabaseFetch(env, {
    path: pushSubscriptionsTablePath(env),
    searchParams: new URLSearchParams({
      select: SUBSCRIPTION_SELECT_COLUMNS,
      order: "created_at.asc"
    })
  });
  const rows = await response.json();

  return rows.map(toSubscriptionRecord);
}

export async function removeSubscription(id, env) {
  await supabaseFetch(env, {
    path: pushSubscriptionsTablePath(env),
    searchParams: new URLSearchParams({
      id: `eq.${id}`
    }),
    init: {
      method: "DELETE"
    }
  });
}

export function toPublicSubscription(record) {
  return {
    id: record.id,
    routineStartMinutes: record.routineStartMinutes,
    timezone: record.timezone,
    hasLocation: false,
    hasCoarseLocation: record.coarseLatitude !== null && record.coarseLongitude !== null,
    preferredLanguage: record.preferredLanguage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSentDate: record.lastSentDate
  };
}

// Records one analytics event and keeps app_installations.last_active_at
// (and preferred_language, if provided) current via upsert. Mirrors
// server/analyticsService.js's recordAnalyticsEvent for the Cloudflare
// Pages Functions runtime.
export async function recordAnalyticsEvent({ installationId, eventName, category, language, metadata, occurredAt }, env) {
  await supabaseFetch(env, {
    path: appInstallationsTablePath(env),
    searchParams: new URLSearchParams({ on_conflict: "id" }),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: installationId,
        last_active_at: new Date().toISOString(),
        ...(language ? { preferred_language: language } : {})
      })
    }
  });

  await supabaseFetch(env, {
    path: analyticsEventsTablePath(env),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        installation_id: installationId,
        event_name: eventName,
        category: category ?? null,
        language: language ?? null,
        metadata: metadata ?? {},
        occurred_at: occurredAt ?? new Date().toISOString()
      })
    }
  });
}

export async function recordFeedbackSubmission({
  installationId,
  rating,
  comment,
  clothingSuggestions,
  category,
  appVersion,
  language,
  fromScheduledPrompt,
  allowFollowUp
}, env) {
  await supabaseFetch(env, {
    path: feedbackSubmissionsTablePath(env),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        installation_id: installationId,
        rating: rating ?? null,
        comment: comment ?? null,
        clothing_suggestions: clothingSuggestions ?? null,
        category: category ?? null,
        app_version: appVersion ?? null,
        language: language ?? null,
        from_scheduled_prompt: Boolean(fromScheduledPrompt),
        allow_follow_up: Boolean(allowFollowUp)
      })
    }
  });
}

// Returns the installation's existing referral code, or generates and stores
// a new one. Mirrors server/referralStore.js's getOrCreateReferralCode for
// the Cloudflare Pages Functions runtime.
export async function getOrCreateReferralCode(installationId, env) {
  await upsertAppInstallation(installationId, env);

  const existingResponse = await supabaseFetch(env, {
    path: referralsTablePath(env),
    searchParams: new URLSearchParams({
      select: "code",
      owner_installation_id: `eq.${installationId}`,
      limit: "1"
    })
  });
  const existingRows = await existingResponse.json();

  if (existingRows[0]?.code) {
    return existingRows[0].code;
  }

  for (let attempt = 0; attempt < MAX_REFERRAL_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();

    try {
      await supabaseFetch(env, {
        path: referralsTablePath(env),
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ code, owner_installation_id: installationId })
        }
      });
      return code;
    } catch (error) {
      if (!String(error.message).includes("23505")) {
        throw error;
      }
    }
  }

  throw new Error("Could not generate a unique referral code.");
}

// Logs one visit to a referral link. Mirrors
// server/referralStore.js's recordReferralVisit.
export async function recordReferralVisit({ referralCode, visitorInstallationId, shareChannel }, env) {
  if (visitorInstallationId) {
    await upsertAppInstallation(visitorInstallationId, env);
  }

  const response = await supabaseFetch(env, {
    path: referralVisitsTablePath(env),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        referral_code: referralCode,
        share_channel: shareChannel ?? null,
        new_installation_id: visitorInstallationId ?? null,
        resulted_in_install: false
      })
    }
  });
  const rows = await response.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;

  if (!saved?.id) {
    throw new Error("Referral visit storage did not return a saved row.");
  }

  return saved.id;
}

// Flips a visit's resulted_in_install once its visiting installation
// completes onboarding, and tags that installation with the referral code
// that brought it in. Mirrors server/referralStore.js's
// markReferralVisitConverted.
export async function markReferralVisitConverted({ visitId, installationId, referralCode }, env) {
  await supabaseFetch(env, {
    path: referralVisitsTablePath(env),
    searchParams: new URLSearchParams({
      id: `eq.${visitId}`,
      new_installation_id: `eq.${installationId}`
    }),
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ resulted_in_install: true })
    }
  });

  await supabaseFetch(env, {
    path: appInstallationsTablePath(env),
    searchParams: new URLSearchParams({ id: `eq.${installationId}` }),
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ referral_code: referralCode })
    }
  });
}

async function upsertAppInstallation(installationId, env) {
  await supabaseFetch(env, {
    path: appInstallationsTablePath(env),
    searchParams: new URLSearchParams({ on_conflict: "id" }),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: installationId, last_active_at: new Date().toISOString() })
    }
  });
}

function generateReferralCode() {
  let code = "";

  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[Math.floor(Math.random() * REFERRAL_CODE_ALPHABET.length)];
  }

  return code;
}

// Pilot event writes remain anonymous and intentionally small.
// Failures are handled softly by the route so analytics never break the app.
export async function insertPilotEvent({ anonymousDeviceId, eventType, metadata }, env) {
  await supabaseFetch(env, {
    path: pilotEventsTablePath(env),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        anonymous_device_id: anonymousDeviceId,
        event_type: eventType,
        metadata
      })
    }
  });
}

// Validation mirrors the existing Express routes before anything reaches
// Supabase or browser push services.
export function parseSubscriptionPayload(body) {
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

export function parseAnalyticsEventPayload(body) {
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

export function parseFeedbackPayload(body) {
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

export function parseReferralVisitPayload(body) {
  const referralCode = body?.referralCode;
  const visitorInstallationId = body?.installationId;

  if (!isValidReferralCode(referralCode)) {
    return {
      ok: false,
      error: "A valid referral code is required."
    };
  }

  if (visitorInstallationId !== undefined && !isValidAnonymousDeviceId(visitorInstallationId)) {
    return {
      ok: false,
      error: "installationId must be a valid installation id, or omitted."
    };
  }

  return {
    ok: true,
    value: {
      referralCode,
      visitorInstallationId: visitorInstallationId ?? null,
      shareChannel: typeof body?.shareChannel === "string" ? body.shareChannel.slice(0, 40) : null
    }
  };
}

export function parseReferralConversionPayload(body, visitId) {
  const installationId = body?.installationId;
  const referralCode = body?.referralCode;

  if (!isValidUuid(visitId)) {
    return {
      ok: false,
      error: "A valid visit id is required."
    };
  }

  if (!isValidAnonymousDeviceId(installationId) || !isValidReferralCode(referralCode)) {
    return {
      ok: false,
      error: "A valid installationId and referralCode are required."
    };
  }

  return {
    ok: true,
    value: { visitId, installationId, referralCode }
  };
}

function isValidReferralCode(value) {
  return typeof value === "string" && /^[A-Z0-9]{4,16}$/.test(value);
}

export function isValidUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseRecommendationEventPayload(body) {
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

function sanitizeRecommendationItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 30).map((item) => (item && typeof item === "object" && !Array.isArray(item) ? item : null)).filter(Boolean);
}

export function parseClientErrorPayload(body) {
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

export function parsePerformanceEventPayload(body) {
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

function isValidIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

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

export function parsePilotEventPayload(body) {
  const anonymousDeviceId = body?.anonymousDeviceId;
  const eventType = body?.eventType;

  if (!isValidAnonymousDeviceId(anonymousDeviceId)) {
    return {
      ok: false,
      error: "A valid anonymous device id is required."
    };
  }

  if (!PILOT_EVENT_TYPES.has(eventType)) {
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

export function subscriptionStoreErrorResponse(error) {
  console.error("Subscription storage request failed.", error);

  return json({
    error: "Subscription storage is unavailable. Check Supabase configuration and table setup."
  }, { status: 503 });
}

async function supabaseFetch(env, { path, searchParams = new URLSearchParams(), init = {} }) {
  if (!isSubscriptionStoreConfigured(env)) {
    throw new Error("Supabase storage is not configured.");
  }

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

async function createSubscriptionId(endpoint) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

function hasScheduleChanged(existing, input) {
  return Boolean(existing)
    && (
      existing.routineStartMinutes !== input.routineStartMinutes
      || existing.timezone !== input.timezone
    );
}

function pushSubscriptionsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_PUSH_SUBSCRIPTIONS_TABLE || DEFAULT_PUSH_SUBSCRIPTIONS_TABLE);
}

export function isDataDeletionConfigured(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

// Deletes every row keyed to one anonymous installation id. Mirrors
// server/dataDeletionService.js, including its ordering: children before
// parents so no foreign key is ever left dangling, app_installations last.
export async function deleteInstallationData(installationId, env) {
  const deleted = {};

  deleted.referralVisits = await deleteRowsWhere(
    env, referralVisitsTablePath(env), `new_installation_id=eq.${installationId}`
  );

  const ownedCodes = await getOwnedReferralCodes(installationId, env);

  if (ownedCodes.length > 0) {
    const codeList = ownedCodes.map((code) => `"${code}"`).join(",");

    deleted.referralVisits += await deleteRowsWhere(
      env, referralVisitsTablePath(env), `referral_code=in.(${codeList})`
    );
  }

  deleted.referrals = await deleteRowsWhere(
    env, referralsTablePath(env), `owner_installation_id=eq.${installationId}`
  );
  deleted.analyticsEvents = await deleteRowsWhere(
    env, analyticsEventsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.recommendationEvents = await deleteRowsWhere(
    env, recommendationEventsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.notificationEvents = await deleteRowsWhere(
    env, notificationEventsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.feedbackSubmissions = await deleteRowsWhere(
    env, feedbackSubmissionsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.clientErrors = await deleteRowsWhere(
    env, clientErrorsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.apiPerformanceEvents = await deleteRowsWhere(
    env, apiPerformanceEventsTablePath(env), `installation_id=eq.${installationId}`
  );
  deleted.pushSubscriptions = await deleteRowsWhere(
    env, pushSubscriptionsTablePath(env), `installation_id=eq.${installationId}`
  );

  // pilot_events predates app_installations and holds the same id under its
  // own column with no foreign key.
  deleted.pilotEvents = await deleteRowsWhere(
    env, pilotEventsTablePath(env), `anonymous_device_id=eq.${installationId}`
  );

  deleted.appInstallations = await deleteRowsWhere(
    env, appInstallationsTablePath(env), `id=eq.${installationId}`
  );

  return deleted;
}

async function getOwnedReferralCodes(installationId, env) {
  const response = await supabaseFetch(env, {
    path: referralsTablePath(env),
    searchParams: new URLSearchParams({
      select: "code",
      owner_installation_id: `eq.${installationId}`
    })
  });
  const rows = await response.json();

  return rows.map((row) => row.code);
}

// `filter` is a raw PostgREST filter expression (e.g. "id=eq.abc") rather than
// a URLSearchParams pair, because "in.(...)" values must not be re-encoded.
async function deleteRowsWhere(env, path, filter) {
  const url = new URL(`/rest/v1/${path}?${filter}`, env.SUPABASE_URL);
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase delete failed with ${response.status}: ${await response.text()}`);
  }

  const rows = await response.json().catch(() => []);

  return Array.isArray(rows) ? rows.length : 0;
}

function pilotEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_PILOT_EVENTS_TABLE || DEFAULT_PILOT_EVENTS_TABLE);
}

function appInstallationsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_APP_INSTALLATIONS_TABLE || DEFAULT_APP_INSTALLATIONS_TABLE);
}

function analyticsEventsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_ANALYTICS_EVENTS_TABLE || DEFAULT_ANALYTICS_EVENTS_TABLE);
}

function feedbackSubmissionsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_FEEDBACK_SUBMISSIONS_TABLE || DEFAULT_FEEDBACK_SUBMISSIONS_TABLE);
}

function referralsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_REFERRALS_TABLE || DEFAULT_REFERRALS_TABLE);
}

function referralVisitsTablePath(env) {
  return encodeURIComponent(env.SUPABASE_REFERRAL_VISITS_TABLE || DEFAULT_REFERRAL_VISITS_TABLE);
}

function toSubscriptionRecord(row) {
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

function isValidPushSubscription(subscription) {
  return typeof subscription?.endpoint === "string"
    && subscription.endpoint.length > 0
    && typeof subscription.keys?.p256dh === "string"
    && typeof subscription.keys?.auth === "string";
}

function isValidRoutineStartMinutes(value) {
  return Number.isInteger(value)
    && value >= 0
    && value < 24 * 60
    && value % 30 === 0;
}

function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch (error) {
    return false;
  }
}

export function isValidAnonymousDeviceId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 80
    && /^[a-zA-Z0-9_-]+$/.test(value);
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
