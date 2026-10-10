// EXACT DUPLICATE of server/comfortFeedback.js — edit both together. Pages
// Functions keep their shared code inside functions/, so this copy exists for
// the Cloudflare runtime; the file is pure precisely so the two can match.

export const COMFORT_RATINGS = new Set(["too_cold", "just_right", "too_warm"]);

// People remember yesterday's commute; they do not remember last month's.
// Older answers are refused rather than stored as if they were reliable.
const MAX_AGE_DAYS = 14;

// Local dates arrive from every timezone, so "today" on the client can be
// tomorrow in UTC. One day of slack covers that without allowing real futures.
const FUTURE_SLACK_DAYS = 1;

const WEATHER_FIELDS = [
  "temperature",
  "feelsLike",
  "high",
  "low",
  "windSpeed",
  "windMax",
  "precipitationProbability",
  "weatherCode"
];

const MAX_SUGGESTIONS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const INSTALLATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseComfortFeedbackPayload(body, now = new Date()) {
  if (!isValidInstallationId(body?.installationId)) {
    return { ok: false, error: "A valid installation id is required." };
  }

  if (!COMFORT_RATINGS.has(body?.rating)) {
    return { ok: false, error: "Rating must be too_cold, just_right, or too_warm." };
  }

  if (!isAcceptableDate(body?.recommendedForDate, now)) {
    return { ok: false, error: "recommendedForDate must be a recent YYYY-MM-DD date." };
  }

  return {
    ok: true,
    value: {
      installationId: body.installationId,
      rating: body.rating,
      recommendedForDate: body.recommendedForDate,
      weatherSummary: sanitizeWeatherSummary(body?.weatherSummary),
      suggestions: sanitizeSuggestions(body?.suggestions),
      expectedTimeAwayHours: sanitizeHours(body?.expectedTimeAwayHours),
      appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 20) : null
    }
  };
}

function isValidInstallationId(value) {
  return typeof value === "string" && INSTALLATION_ID_PATTERN.test(value);
}

// A real calendar date (rejects 2026-02-30), no older than MAX_AGE_DAYS and no
// further ahead than the timezone slack.
export function isAcceptableDate(value, now = new Date()) {
  if (typeof value !== "string") {
    return false;
  }

  const match = DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [, year, month, day] = match.map(Number);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);

  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return false;
  }

  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return time >= todayUtc - MAX_AGE_DAYS * DAY_MS
    && time <= todayUtc + FUTURE_SLACK_DAYS * DAY_MS;
}

function sanitizeWeatherSummary(summary) {
  const clean = {};

  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return clean;
  }

  WEATHER_FIELDS.forEach((field) => {
    const value = summary[field];

    // Number.isFinite rather than Number(): Number(null) is 0, which would
    // record a missing reading as a real 0F.
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1000) {
      clean[field] = Math.round(value * 10) / 10;
    }
  });

  return clean;
}

function sanitizeSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) {
    return [];
  }

  return suggestions
    .slice(0, MAX_SUGGESTIONS)
    .filter((entry) => entry && typeof entry === "object" && typeof entry.item === "string" && entry.item.length > 0)
    .map((entry) => ({
      category: typeof entry.category === "string" ? entry.category.slice(0, 20) : null,
      weight: typeof entry.weight === "string" ? entry.weight.slice(0, 20) : null,
      item: entry.item.slice(0, 60)
    }));
}

function sanitizeHours(value) {
  return Number.isInteger(value) && value >= 1 && value <= 24 ? value : null;
}
