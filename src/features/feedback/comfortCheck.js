import { getLocale, t } from "../../i18n/i18n.js";
import { translateDomainString } from "../../i18n/domainStrings.js";
import { APP_CONFIG } from "../../config.js";
import {
  COMFORT_CHECK_STORAGE_KEY,
  INSTALLATION_ID_STORAGE_KEY,
  ONBOARDING_COMPLETED_STORAGE_KEY
} from "../../constants/storageKeys.js";
import { trackEvent } from "../../services/analytics.js";
import {
  applyAnswer,
  applySkip,
  daysBetween,
  markPrompted,
  normalizeComfortLog,
  pickComfortCandidate,
  recordSnapshot
} from "../../domain/comfortSchedule.js";
import { willShowFeedbackPrompt } from "./feedbackPrompt.js";

// Asks, one tap, how the person's previous checklist actually felt. This is
// the only signal that measures the checklist itself: forecast_actuals tells
// us whether the forecast was right, not whether someone following Ready ended
// up cold. When to ask is decided in domain/comfortSchedule.js.
const SHOW_DELAY_MS = 2500;
const CLOSE_AFTER_THANKS_MS = 1100;
const RATINGS = [
  { value: "too_cold", emoji: "\u{1F976}", key: "comfort.tooCold" },
  { value: "just_right", emoji: "\u{1F44D}", key: "comfort.justRight" },
  { value: "too_warm", emoji: "\u{1F975}", key: "comfort.tooWarm" }
];

// Called on every checklist render; only the first render of each day is
// kept (see recordSnapshot). Stores English engine vocabulary, never a
// location, and translates only when the question is shown.
export function recordComfortSnapshot({ windowWeather, timeAwayHours, renderedChecklist, recommendation }) {
  const snapshot = {
    date: todayKey(),
    weatherSummary: summarizeWeather(windowWeather),
    suggestions: summarizeSuggestions(renderedChecklist, recommendation),
    expectedTimeAwayHours: Number.isInteger(timeAwayHours) ? timeAwayHours : null
  };

  writeLog(recordSnapshot(readLog(), snapshot));
}

export function initComfortCheck() {
  window.setTimeout(maybeShow, SHOW_DELAY_MS);
}

function maybeShow() {
  if (!hasCompletedOnboarding() || document.querySelector(".comfort-modal-overlay")) {
    return;
  }

  const today = todayKey();
  const log = readLog();
  const candidate = pickComfortCandidate(log, today, Date.now());

  if (!candidate) {
    return;
  }

  // Not marked as prompted: standing aside today means asking tomorrow.
  if (willShowFeedbackPrompt()) {
    return;
  }

  writeLog(markPrompted(log, today));
  showModal(candidate, today);
  trackEvent("comfort_check_shown", { daysAgo: daysBetween(candidate.date, today) });
}

function showModal(candidate, today) {
  const overlay = document.createElement("div");
  const detail = describeVisit(candidate);

  overlay.className = "share-modal-overlay comfort-modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="share-modal-backdrop"></div>
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="comfortModalTitle">
      <p class="kicker">${escapeHtml(t("comfort.kicker"))}</p>
      <h2 id="comfortModalTitle" class="share-modal-title">${escapeHtml(titleFor(candidate.date, today))}</h2>
      ${detail ? `<p class="share-modal-body">${escapeHtml(detail)}</p>` : ""}
      <div class="comfort-options" role="group" aria-labelledby="comfortModalTitle">
        ${RATINGS.map((rating) => `
          <button type="button" class="comfort-option" data-rating="${rating.value}">
            <span class="comfort-option-emoji" aria-hidden="true">${rating.emoji}</span>
            <span>${escapeHtml(t(rating.key))}</span>
          </button>
        `).join("")}
      </div>
      <p class="share-modal-message comfort-message" aria-live="polite"></p>
      <div class="share-modal-actions comfort-actions">
        <button type="button" class="secondary-action comfort-skip">${escapeHtml(t("comfort.skip"))}</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll(".comfort-option").forEach((button) => {
    button.addEventListener("click", () => handleAnswer(overlay, candidate, button.dataset.rating));
  });
  overlay.querySelector(".comfort-skip").addEventListener("click", () => handleSkip(overlay, candidate));
  overlay.querySelector(".share-modal-backdrop").addEventListener("click", () => handleSkip(overlay, candidate));

  document.body.append(overlay);
  requestAnimationFrame(() => {
    overlay.hidden = false;
  });
}

async function handleAnswer(overlay, candidate, rating) {
  const buttons = overlay.querySelectorAll("button");
  const message = overlay.querySelector(".comfort-message");

  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    await postAnswer(candidate, rating);
    writeLog(applyAnswer(readLog(), candidate.date));
    trackEvent("comfort_check_answered", { rating });
    message.textContent = t("comfort.thanks");
    window.setTimeout(() => overlay.remove(), CLOSE_AFTER_THANKS_MS);
  } catch (error) {
    // Left unresolved on purpose: a failed save should be asked again rather
    // than silently recorded as answered.
    message.textContent = t("comfort.failed");
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function handleSkip(overlay, candidate) {
  writeLog(applySkip(readLog(), candidate.date, Date.now()));
  trackEvent("comfort_check_skipped", {});
  overlay.remove();
}

async function postAnswer(candidate, rating) {
  const response = await fetch(apiUrl("/api/comfort-feedback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId: getInstallationId(),
      rating,
      recommendedForDate: candidate.date,
      weatherSummary: candidate.weatherSummary,
      suggestions: candidate.suggestions,
      expectedTimeAwayHours: candidate.expectedTimeAwayHours,
      appVersion: APP_CONFIG.appVersion
    })
  });

  if (!response.ok) {
    throw new Error(`Comfort feedback failed with ${response.status}`);
  }
}

// "How did yesterday's checklist feel?" when it was yesterday; the weekday
// name otherwise, since "3 days ago" is harder to place than "Monday".
function titleFor(date, today) {
  if (daysBetween(date, today) === 1) {
    return t("comfort.titleYesterday");
  }

  const [year, month, day] = date.split("-").map(Number);
  // Built from parts, not parsed: new Date("2026-10-08") is UTC midnight and
  // lands on the previous weekday anywhere west of Greenwich.
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "long" }).format(new Date(year, month - 1, day));

  return t("comfort.titleDay", { day: weekday });
}

// "52° · Long-sleeve shirt, Jeans" — the reading and the first two clothing
// picks, which is enough to jog the memory without retelling the checklist.
function describeVisit(candidate) {
  const temp = candidate.weatherSummary?.feelsLike ?? candidate.weatherSummary?.temperature;
  const items = (candidate.suggestions ?? [])
    .filter((entry) => entry.category === "Shirts" || entry.category === "Pants" || entry.category === "Top" || entry.category === "Bottom")
    .slice(0, 2)
    .map((entry) => translateDomainString(entry.item));

  if (Number.isFinite(temp) && items.length > 0) {
    return t("comfort.detail", { temp: Math.round(temp), items: items.join(", ") });
  }

  if (items.length > 0) {
    return t("comfort.detailItemsOnly", { items: items.join(", ") });
  }

  return Number.isFinite(temp) ? t("comfort.detailTempOnly", { temp: Math.round(temp) }) : "";
}

function summarizeWeather(weather) {
  const pick = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

  return {
    temperature: pick(weather?.current?.temperature),
    feelsLike: pick(weather?.current?.feelsLike),
    high: pick(weather?.daily?.high),
    low: pick(weather?.daily?.low),
    windSpeed: pick(weather?.current?.windSpeed),
    windMax: pick(weather?.daily?.windMax),
    precipitationProbability: pick(weather?.daily?.precipitationProbability),
    weatherCode: pick(weather?.daily?.weatherCode ?? weather?.current?.weatherCode)
  };
}

// What the person actually saw: one entry per checklist section with its
// weight label and top item. Falls back to the engine's own groups if the
// personalized layer produced nothing.
function summarizeSuggestions(renderedChecklist, recommendation) {
  const sections = renderedChecklist?.sections;

  if (Array.isArray(sections) && sections.length > 0) {
    return sections
      .map((section) => ({
        category: section?.category ?? null,
        weight: section?.label ?? null,
        item: itemLabel(section?.items?.[0])
      }))
      .filter((entry) => typeof entry.item === "string" && entry.item.length > 0);
  }

  return (recommendation?.items ?? [])
    .filter((item) => item.type === "clothingGroup" && item.options?.length > 0)
    .map((item) => ({ category: item.category, weight: item.weightLabel ?? null, item: item.options[0] }));
}

function itemLabel(item) {
  return item && typeof item === "object" && !Array.isArray(item) ? item.label : item;
}

function readLog() {
  try {
    const raw = window.localStorage.getItem(COMFORT_CHECK_STORAGE_KEY);

    return normalizeComfortLog(raw ? JSON.parse(raw) : null);
  } catch (error) {
    return normalizeComfortLog(null);
  }
}

function writeLog(log) {
  try {
    window.localStorage.setItem(COMFORT_CHECK_STORAGE_KEY, JSON.stringify(log));
  } catch (error) {
    // Best-effort; without storage the question simply never appears.
  }
}

function hasCompletedOnboarding() {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY) === "true";
  } catch (error) {
    return false;
  }
}

function getInstallationId() {
  try {
    return window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

function todayKey() {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function apiUrl(path) {
  const baseUrl = APP_CONFIG.pushApiBaseUrl || window.location.origin;

  return new URL(path, baseUrl).toString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
