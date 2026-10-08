import { t } from "../../i18n/i18n.js";
import { CitySearchError, searchCities } from "../../services/geocoding.js";

// The main screen's counterpart to onboarding's city step: same underlying
// search, presented as a modal because this screen is already full. Shared
// logic lives in services/geocoding.js; only the presentation differs.
let modal = null;
let onSelect = null;

export function openCityPicker(handleSelect) {
  onSelect = handleSelect;

  if (!modal) {
    modal = createModal();
    document.body.append(modal);
  }

  modal.querySelector(".city-picker-message").textContent = "";
  modal.querySelector(".city-picker-results").replaceChildren();
  modal.querySelector(".city-picker-input").value = "";
  modal.hidden = false;
  modal.querySelector(".city-picker-input").focus();
}

function createModal() {
  const overlay = document.createElement("div");

  overlay.className = "share-modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="share-modal-backdrop"></div>
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="cityPickerTitle">
      <h2 id="cityPickerTitle" class="share-modal-title">${escapeHtml(t("onboarding.cityTitle"))}</h2>
      <p class="share-modal-body">${escapeHtml(t("onboarding.cityBody"))}</p>
      <input type="text" class="onboarding-city-input city-picker-input" autocomplete="off"
        placeholder="${escapeHtml(t("onboarding.cityPlaceholder"))}"
        aria-label="${escapeHtml(t("onboarding.cityTitle"))}">
      <div class="onboarding-city-results city-picker-results"></div>
      <p class="share-modal-message city-picker-message" aria-live="polite"></p>
      <div class="share-modal-actions">
        <button type="button" class="secondary-action city-picker-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button type="button" class="primary-action city-picker-search">${escapeHtml(t("onboarding.cityPrimary"))}</button>
      </div>
    </div>
  `;

  overlay.querySelector(".city-picker-cancel").addEventListener("click", () => closeModal());
  overlay.querySelector(".share-modal-backdrop").addEventListener("click", () => closeModal());
  overlay.querySelector(".city-picker-search").addEventListener("click", () => runSearch());
  overlay.querySelector(".city-picker-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });

  return overlay;
}

function closeModal() {
  if (modal) {
    modal.hidden = true;
  }
}

async function runSearch() {
  const input = modal.querySelector(".city-picker-input");
  const results = modal.querySelector(".city-picker-results");
  const message = modal.querySelector(".city-picker-message");
  const searchButton = modal.querySelector(".city-picker-search");

  searchButton.disabled = true;
  message.textContent = t("onboarding.citySearching");
  results.replaceChildren();

  try {
    const matches = await searchCities(input.value);

    message.textContent = matches.length === 0 ? t("onboarding.cityNoResults") : "";

    matches.forEach((match) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "onboarding-city-result";
      button.textContent = match.label;
      button.addEventListener("click", () => {
        closeModal();
        onSelect?.(match);
      });
      results.append(button);
    });
  } catch (error) {
    message.textContent = error instanceof CitySearchError && error.code === "TOO_SHORT"
      ? t("onboarding.cityTooShort")
      : t("onboarding.citySearchFailed");
  } finally {
    searchButton.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
