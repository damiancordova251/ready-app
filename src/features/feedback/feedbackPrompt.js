import { getLocale, t } from "../../i18n/i18n.js";
import { APP_CONFIG } from "../../config.js";
import {
  ACTIVE_DAYS_LOG_STORAGE_KEY,
  FEEDBACK_PROMPT_STATE_STORAGE_KEY,
  INSTALLATION_ID_STORAGE_KEY,
  ONBOARDING_COMPLETED_STORAGE_KEY
} from "../../constants/storageKeys.js";
import { trackEvent } from "../../services/analytics.js";

const ACTIVE_DAYS_THRESHOLD = 3;
const POSTPONE_COOLDOWN_DAYS = 3;
const DISMISS_COOLDOWN_DAYS = 14;
const SHOW_DELAY_MS = 4000;
const MAX_LOGGED_DAYS = 30;

// Shows a lightweight "how's it going" prompt once the user has opened the
// app on at least 3 distinct calendar days (a reasonable, purely-local proxy
// for "3 days of actual use" without needing a server round trip just to
// decide whether to show a modal). Never shown during onboarding — this is
// only ever called from app.js after onboarding's own gating gets a chance
// to run — and gated behind a short delay so it never appears the instant
// the app opens, even for a returning user who already qualifies.
export function initFeedbackPrompt() {
  recordActiveDay();

  window.setTimeout(() => {
    if (shouldShowPrompt()) {
      showFeedbackPrompt();
    }
  }, SHOW_DELAY_MS);
}

function recordActiveDay() {
  const log = readActiveDaysLog();
  const today = todayKey();

  if (!log.includes(today)) {
    log.push(today);

    while (log.length > MAX_LOGGED_DAYS) {
      log.shift();
    }

    writeActiveDaysLog(log);
  }
}

// Exported so the daily comfort check can stand aside on the day this larger
// prompt appears; two modals on one launch would feel like an ambush.
export function willShowFeedbackPrompt() {
  return shouldShowPrompt();
}

function shouldShowPrompt() {
  if (!hasCompletedOnboarding()) {
    return false;
  }

  if (readActiveDaysLog().length < ACTIVE_DAYS_THRESHOLD) {
    return false;
  }

  const promptState = readPromptState();

  if (promptState.status === "submitted") {
    return false;
  }

  if (promptState.status === "postponed" && promptState.cooldownUntil && Date.now() < promptState.cooldownUntil) {
    return false;
  }

  if (promptState.status === "dismissed" && promptState.cooldownUntil && Date.now() < promptState.cooldownUntil) {
    return false;
  }

  return true;
}

function showFeedbackPrompt() {
  const overlay = createFeedbackModal();

  document.body.append(overlay);
  requestAnimationFrame(() => {
    overlay.hidden = false;
  });

  writePromptState({ status: "shown", lastShownAt: new Date().toISOString() });
  trackEvent("feedback_prompt_shown", {});
}

function createFeedbackModal() {
  const overlay = document.createElement("div");

  overlay.className = "share-modal-overlay feedback-modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="share-modal-backdrop"></div>
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="feedbackModalTitle">
      <p class="kicker">${escapeHtml(t("feedback.kicker"))}</p>
      <h2 id="feedbackModalTitle" class="share-modal-title">${escapeHtml(t("feedback.title"))}</h2>
      <p class="share-modal-body">${escapeHtml(t("feedback.body"))}</p>
      <div class="feedback-rating" role="radiogroup" aria-label="${escapeHtml(t("feedback.ratingLabel"))}">
        ${[1, 2, 3, 4, 5].map((value) => `
          <label class="feedback-rating-option">
            <input type="radio" name="feedbackRating" value="${value}">
            <span>${value}</span>
          </label>
        `).join("")}
      </div>
      <label class="feedback-comment-label" for="feedbackComment">${escapeHtml(t("feedback.commentLabel"))}</label>
      <textarea id="feedbackComment" class="feedback-comment" rows="3" placeholder="${escapeHtml(t("feedback.commentPlaceholder"))}"></textarea>
      <label class="feedback-comment-label" for="feedbackClothingSuggestions">${escapeHtml(t("feedback.clothingSuggestionsLabel"))}</label>
      <textarea id="feedbackClothingSuggestions" class="feedback-comment" rows="2" placeholder="${escapeHtml(t("feedback.clothingSuggestionsPlaceholder"))}"></textarea>
      <p class="share-modal-message feedback-message" aria-live="polite"></p>
      <div class="share-modal-actions feedback-actions">
        <button type="button" class="secondary-action feedback-dismiss">${escapeHtml(t("feedback.dismiss"))}</button>
        <button type="button" class="secondary-action feedback-remind-later">${escapeHtml(t("feedback.remindLater"))}</button>
        <button type="button" class="primary-action feedback-submit">${escapeHtml(t("feedback.submit"))}</button>
      </div>
    </div>
  `;

  overlay.querySelector(".feedback-dismiss").addEventListener("click", () => handleDismiss(overlay));
  overlay.querySelector(".feedback-remind-later").addEventListener("click", () => handlePostpone(overlay));
  overlay.querySelector(".feedback-submit").addEventListener("click", () => handleSubmit(overlay));
  overlay.querySelector(".share-modal-backdrop").addEventListener("click", () => handleDismiss(overlay));

  return overlay;
}

function handleDismiss(overlay) {
  writePromptState({
    status: "dismissed",
    lastShownAt: new Date().toISOString(),
    cooldownUntil: Date.now() + DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  });
  trackEvent("feedback_prompt_dismissed", {});
  closeModal(overlay);
}

function handlePostpone(overlay) {
  writePromptState({
    status: "postponed",
    lastShownAt: new Date().toISOString(),
    cooldownUntil: Date.now() + POSTPONE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  });
  trackEvent("feedback_prompt_postponed", {});
  closeModal(overlay);
}

async function handleSubmit(overlay) {
  const submitButton = overlay.querySelector(".feedback-submit");
  const messageEl = overlay.querySelector(".feedback-message");
  const rating = Number(overlay.querySelector("input[name='feedbackRating']:checked")?.value) || null;
  const comment = overlay.querySelector("#feedbackComment").value.trim().slice(0, 2000);
  const clothingSuggestions = overlay.querySelector("#feedbackClothingSuggestions").value.trim().slice(0, 500);

  submitButton.disabled = true;

  try {
    await postFeedback({ rating, comment, clothingSuggestions });
    trackEvent("feedback_submitted", { hasRating: rating !== null, hasComment: comment.length > 0, hasClothingSuggestions: clothingSuggestions.length > 0 });
    writePromptState({ status: "submitted", lastShownAt: new Date().toISOString(), submittedAt: new Date().toISOString() });
    messageEl.textContent = t("feedback.thanks");
    window.setTimeout(() => closeModal(overlay), 1200);
  } catch (error) {
    messageEl.textContent = t("feedback.submitFailed");
    submitButton.disabled = false;
  }
}

async function postFeedback({ rating, comment, clothingSuggestions }) {
  const installationId = getInstallationId();
  const response = await fetch(apiUrl("/api/feedback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId,
      rating,
      comment,
      clothingSuggestions,
      language: getLocale(),
      appVersion: APP_CONFIG.appVersion,
      fromScheduledPrompt: true
    })
  });

  if (!response.ok) {
    throw new Error(`Feedback request failed with ${response.status}`);
  }
}

function closeModal(overlay) {
  overlay.remove();
}

function hasCompletedOnboarding() {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY) === "true";
  } catch (error) {
    return false;
  }
}

function readActiveDaysLog() {
  try {
    const raw = window.localStorage.getItem(ACTIVE_DAYS_LOG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeActiveDaysLog(log) {
  try {
    window.localStorage.setItem(ACTIVE_DAYS_LOG_STORAGE_KEY, JSON.stringify(log));
  } catch (error) {
    // Best-effort; missing a day in the log just delays the prompt slightly.
  }
}

function readPromptState() {
  try {
    const raw = window.localStorage.getItem(FEEDBACK_PROMPT_STATE_STORAGE_KEY);

    return raw ? JSON.parse(raw) : { status: "not_shown" };
  } catch (error) {
    return { status: "not_shown" };
  }
}

function writePromptState(state) {
  try {
    window.localStorage.setItem(FEEDBACK_PROMPT_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Best-effort; worst case the prompt may show again sooner than intended.
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
