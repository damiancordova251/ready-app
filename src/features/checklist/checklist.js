import { elements } from "../../dom/elements.js";
import { state } from "../../state/appState.js";
import { SAVED_LOCATION_STORAGE_KEY } from "../../constants/storageKeys.js";
import { getCurrentLocation, LocationAccessError } from "../../services/location.js";
import { fetchTodayWeather, WeatherFetchError } from "../../services/weather.js";
import { trackPilotEvent } from "../../services/pilotAnalytics.js";
import { recordRecommendationEvent, trackEvent } from "../../services/analytics.js";
import { t } from "../../i18n/i18n.js";
import { formatWeatherEmoji } from "../../utils/format.js";
import { translateDomainString } from "../../i18n/domainStrings.js";
import {
  buildWindowWeather,
  createRecommendation,
  getNextForecastWindow
} from "../../domain/recommendation.js";
import { getSavedGroupedChecklist } from "../../domain/personalizedChecklist.js";
import { getChecklistPrompt, getSavedTimeAwayHours } from "../settings/timeAway.js";
import { renderNotificationSetting } from "../notifications/notificationSettings.js";
import { renderFacts, resetFacts } from "../weatherScreen/weatherScreen.js";
import { openCityPicker } from "../location/cityPicker.js";
import { reverseGeocodeCoarse } from "../../services/geocoding.js";

// Wires the main checklist screen's own controls. Other features (onboarding,
// time-away commit) call the exported render/location helpers directly rather
// than this module reaching back into them, which keeps this file free of any
// dependency on onboarding or settings internals.
export function initChecklist() {
  elements.primaryAction.addEventListener("click", handleRecommendationRequest);
  elements.useCityButton?.addEventListener("click", () => openCityPicker(applyChosenCity));
  elements.itemList.addEventListener("change", updateCompletionState);
  elements.primaryAction.textContent = t("checklist.primaryActionUseLocation");
}

export function startAppExperience() {
  if (state.startupFlowStarted) {
    return;
  }

  state.startupFlowStarted = true;
  initializeSavedLocationChecklist();
}

// Re-renders the checklist from whatever weather was last fetched, used after
// a setting changes (time away, clothing preferences) without refetching
// location or weather. Returns false when there is nothing to re-render yet.
export function rerenderLatestChecklist(source) {
  if (!state.latestWeather) {
    return false;
  }

  renderWindowRecommendation(
    state.latestWeather,
    state.latestRecommendationRequestedAt ?? new Date(),
    { source }
  );
  return true;
}

// Handles the explicit "Use current location" / "Update location" button flow:
// get GPS, save it locally, fetch weather, then render the checklist.
async function handleRecommendationRequest() {
  const requestedAt = new Date();

  setLoading(t("checklist.loadingLabelLocation"));

  try {
    const location = await getCurrentLocation();
    state.latestLocation = toReminderLocation(location);
    saveLocationForThisDevice(state.latestLocation);
    renderNotificationSetting();
    trackPilotEvent("location_updated", { source: "current_location" });
    setLoading(t("checklist.loadingLabelWeather"));

    const weather = await fetchTodayWeather(location);
    renderWindowRecommendation(weather, requestedAt, { source: "current_location" });
  } catch (error) {
    trackEvent("client_error", { errorType: "checklist_request_failed", message: error?.message });
    renderError(error);
  }
}

// Applies a city chosen from the picker. Deliberately mirrors
// handleRecommendationRequest's path so a typed city and a GPS fix produce
// exactly the same downstream behaviour.
async function applyChosenCity(city) {
  const requestedAt = new Date();
  const location = { latitude: city.latitude, longitude: city.longitude, accuracy: null, label: city.name };

  setLoading(t("checklist.loadingLabelWeather"));

  try {
    state.latestLocation = toReminderLocation(location);
    saveLocationForThisDevice(state.latestLocation);
    renderNotificationSetting();
    trackPilotEvent("location_updated", { source: "city" });

    const weather = await fetchTodayWeather(location);
    renderWindowRecommendation(weather, requestedAt, { source: "city" });
  } catch (error) {
    trackEvent("client_error", { errorType: "city_checklist_failed", message: error?.message });
    renderError(error);
  }
}

// On later app opens, reuses the locally saved location so the checklist can
// generate without asking the user to tap the location button again.
export async function initializeSavedLocationChecklist() {
  const savedLocation = getSavedLocationForThisDevice();

  if (!savedLocation) {
    elements.appStatus.textContent = t("checklist.tapLocationOnceStatus");
    return;
  }

  state.latestLocation = savedLocation;
  renderNotificationSetting();
  setLoading(t("checklist.loadingLabelSavedLocation"));

  try {
    const weather = await fetchTodayWeather(savedLocation);
    renderWindowRecommendation(weather, new Date(), { source: "saved_location" });
  } catch (error) {
    renderError(error);
    elements.primaryAction.textContent = t("checklist.primaryActionUseLocation");
    elements.appStatus.textContent = t("checklist.savedLocationFailedStatus");
  }
}

// Applies the selected time-away setting to the forecast before running the
// recommendation engine. Exported so onboarding can render the very first
// checklist the same way the main app does.
export function renderWindowRecommendation(weather, requestedAt = new Date(), options = {}) {
  const timeAwayHours = getSavedTimeAwayHours();
  const generationStartedAt = performance.now();
  const forecastWindow = getNextForecastWindow(weather, requestedAt, timeAwayHours);
  const windowWeather = buildWindowWeather(weather, forecastWindow);
  const recommendation = createRecommendation(windowWeather);
  const groupedChecklist = getSavedGroupedChecklist(recommendation);
  const generationTimeMs = performance.now() - generationStartedAt;
  const renderedChecklist = groupedChecklist ?? recommendation.items;

  state.latestWeather = weather;
  state.latestRecommendationRequestedAt = requestedAt;
  renderRecommendation(weather, timeAwayHours, renderedChecklist);
  trackPilotEvent("checklist_generated", {
    source: options.source ?? "unknown",
    itemCount: getChecklistItemCount(renderedChecklist),
    hasItems: getChecklistItemCount(renderedChecklist) > 0,
    expected_time_away_hours: timeAwayHours,
    has_clothing_preferences: Boolean(groupedChecklist?.personalized),
    personalized_checklist: Boolean(groupedChecklist?.personalized)
  });
  trackEvent("recommendation_generated", {
    source: options.source ?? "unknown",
    itemCount: getChecklistItemCount(renderedChecklist),
    expectedTimeAwayHours: timeAwayHours,
    personalized: Boolean(groupedChecklist?.personalized)
  });
  recordRecommendationEvent({
    weatherConditions: summarizeWeatherConditions(windowWeather),
    expectedTimeAwayHours: timeAwayHours,
    items: recommendation.items,
    personalized: Boolean(groupedChecklist?.personalized),
    generationTimeMs
  });
}

// Bounded, typed summary for recommendation_events.weather_conditions — never
// exact coordinates, just the same conditions the checklist was based on.
function summarizeWeatherConditions(weather) {
  return {
    temperature: weather.current?.temperature ?? null,
    feelsLike: weather.current?.feelsLike ?? null,
    precipitation: weather.current?.precipitation ?? null,
    precipitationProbability: weather.daily?.precipitationProbability ?? null,
    weatherCode: weather.current?.weatherCode ?? null,
    windSpeed: weather.current?.windSpeed ?? null
  };
}

// Updates the main checklist screen after a successful weather fetch.
function renderRecommendation(weather, timeAwayHours, checklist) {
  elements.appShell.classList.remove("is-error", "is-warning", "is-complete");
  elements.kicker.textContent = `${t("checklist.todayKicker")} ${formatWeatherEmoji(weather?.current?.weatherCode)}`;
  setHeadline(buildConditionsHeadline(weather));
  elements.reasonText.textContent = getChecklistPrompt(timeAwayHours);
  elements.primaryAction.disabled = false;
  elements.primaryAction.textContent = t("checklist.primaryActionUpdateLocation");

  renderItems(checklist);
  updateCompletionState();
  renderFacts(weather);
  resolvePlaceNameIfMissing(weather);
}


// A GPS fix has no place name of its own. Resolve one once, store it on the
// saved location, and reuse it from then on — so this costs one request per
// location change, not one per app open. A new GPS fix clears the label,
// which is what re-triggers this.
async function resolvePlaceNameIfMissing(weather) {
  const saved = getSavedLocationForThisDevice();

  if (!saved || saved.label || state.placeNameLookupInFlight) {
    return;
  }

  state.placeNameLookupInFlight = true;

  try {
    const place = await reverseGeocodeCoarse(saved.latitude, saved.longitude);

    if (!place) {
      return;
    }

    saveLocationForThisDevice({ ...saved, label: place });

    // Only the headline depends on the name, so re-render that rather than
    // regenerating the whole checklist.
    setHeadline(buildConditionsHeadline(weather));
  } finally {
    state.placeNameLookupInFlight = false;
  }
}

// The headline is the weather itself — "\u2600\ufe0f 51\u00b0 in Guayaquil" — rather than a
// "Ready Checklist:" title that repeated the app name for no information.
//
// The place is only named when it is actually known: a city the user typed.
// It is deliberately NOT derived from the forecast timezone any more. That
// looked clever and was wrong — Cambridge, Massachusetts reports
// America/New_York, so a Cambridge user was told their weather was "for New
// York" while the forecast underneath was correctly theirs.
function buildConditionsHeadline(weather) {
  const temperature = weather?.current?.temperature;

  if (!Number.isFinite(temperature)) {
    return t("checklist.title");
  }

  const degrees = Math.round(temperature);
  const place = getSavedLocationForThisDevice()?.label;

  return place
    ? t("checklist.conditionsHeadlinePlace", { degrees, place })
    : t("checklist.conditionsHeadline", { degrees });
}

// Long place names ("Santo Domingo de los Colorados") would wrap onto a
// second line and push the checklist below the fold, so the type shrinks to
// fit rather than the header growing. Bucketed in JS because CSS alone cannot
// size on content length.
function setHeadline(text) {
  elements.recommendationTitle.textContent = text;
  elements.recommendationTitle.dataset.size = text.length > 22
    ? "sm"
    : text.length > 15 ? "md" : "lg";
}

// Rebuilds the checklist rows from generic strings or personalized grouped
// sections, while preserving checkbox completion behavior.
function renderItems(checklist) {
  state.completedTrackedForChecklist = false;

  if (isPersonalizedChecklist(checklist)) {
    renderPersonalizedItems(checklist.sections);
    return;
  }

  const items = Array.isArray(checklist) ? checklist : [];

  if (items.length === 0) {
    const listItem = document.createElement("li");
    listItem.className = "empty-checklist";
    listItem.textContent = t("checklist.emptyChecklist");
    elements.itemList.replaceChildren(listItem);
    return;
  }

  elements.itemList.replaceChildren(...items.map(createChecklistItem));
}

function renderPersonalizedItems(sections) {
  if (sections.length === 0) {
    renderItems([]);
    return;
  }

  elements.itemList.replaceChildren(...sections.map(createChecklistSection));
}

// Loading and error renderers keep the main screen in a clear state while async
// location/weather/reminder work is running or has failed.
export function setLoading(label) {
  elements.appShell.classList.remove("is-error", "is-warning", "is-complete");
  elements.kicker.textContent = label;
  setHeadline(t("checklist.title"));
  elements.reasonText.textContent = t("checklist.loadingReason", { hours: getSavedTimeAwayHours() });
  elements.primaryAction.disabled = true;
  elements.primaryAction.textContent = t("checklist.primaryActionChecking");
  elements.appStatus.textContent = t("checklist.locationOnlyStatus");
  clearItems();
}

function renderError(error) {
  const copy = getErrorCopy(error);

  elements.appShell.classList.toggle("is-warning", copy.kind === "warning");
  elements.appShell.classList.toggle("is-error", copy.kind === "error");
  elements.appShell.classList.remove("is-complete");
  elements.kicker.textContent = copy.kicker;
  setHeadline(copy.title);
  elements.reasonText.textContent = copy.reason;
  elements.primaryAction.disabled = false;
  elements.primaryAction.textContent = t("checklist.primaryActionTryAgain");
  elements.appStatus.textContent = copy.footer;
  clearItems();
  resetFacts();
}

// Builds one accessible checklist row with a hidden checkbox and styled check
// mark. `item` is either a structured recommendation descriptor
// (clothingGroup/accessory) or a personalized-checklist entry (a canonical
// clothing-item string or a {label, warning} fallback object) — all resolved
// to translated display text + optional warning here.
function createChecklistItem(item) {
  const listItem = document.createElement("li");

  listItem.append(createChecklistRow(item));

  return listItem;
}

// Shows the category plus its single best option, with any alternatives behind
// a disclosure. Keeps the whole checklist on one screen instead of making
// people scroll past every option in every category to reach accessories.
function createChecklistSection(section) {
  const listItem = document.createElement("li");
  const heading = document.createElement("h2");
  const rows = document.createElement("div");
  const items = Array.isArray(section.items) ? section.items : [];
  const [topItem, ...alternatives] = items;

  listItem.className = "checklist-section";
  listItem.dataset.checklistSection = "true";
  heading.className = "checklist-section-title";
  heading.textContent = `${translateDomainString(section.category)} (${translateDomainString(section.label)})`;
  rows.className = "checklist-section-items";

  if (topItem) {
    rows.append(createChecklistRow(topItem));
  }

  listItem.append(heading, rows);

  if (alternatives.length > 0) {
    listItem.append(createChecklistAlternatives(alternatives));
  }

  return listItem;
}

// A native <details> rather than a custom toggle: it is keyboard accessible
// and screen-reader friendly for free, and the hidden rows stay in the DOM so
// checking any one of them still completes the category.
function createChecklistAlternatives(items) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const rows = document.createElement("div");

  details.className = "checklist-more";
  summary.className = "checklist-more-summary";
  summary.textContent = items.length === 1
    ? t("checklist.moreOptionSingular", { n: items.length })
    : t("checklist.moreOptionPlural", { n: items.length });
  rows.className = "checklist-section-items";
  rows.replaceChildren(...items.map(createChecklistRow));
  details.append(summary, rows);

  return details;
}

function createChecklistRow(item) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  const box = document.createElement("span");
  const copy = document.createElement("span");
  const text = document.createElement("span");
  const normalizedItem = normalizeChecklistItem(item);

  label.className = "checklist-row";
  checkbox.type = "checkbox";
  box.className = "checkbox-mark";
  box.innerHTML = "&#10003;";
  copy.className = "checklist-copy";
  text.className = "checklist-label";
  text.textContent = normalizedItem.label;
  copy.append(text);

  if (normalizedItem.warning) {
    const warning = document.createElement("span");

    warning.className = "checklist-warning";
    warning.textContent = normalizedItem.warning;
    copy.append(warning);
  }

  label.append(checkbox, box, copy);

  return label;
}

// Marks the screen complete when flat fallback items are all checked, or when
// grouped checklist sections each have at least one selected option.
function updateCompletionState() {
  const checkboxes = [...elements.itemList.querySelectorAll("input[type='checkbox']")];
  const groupedSections = [...elements.itemList.querySelectorAll("[data-checklist-section='true']")];
  const completableSections = groupedSections
    .filter((section) => section.querySelectorAll("input[type='checkbox']").length > 0);
  const isComplete = groupedSections.length > 0
    ? completableSections.length > 0
      && completableSections.every((section) => [...section.querySelectorAll("input[type='checkbox']")].some((checkbox) => checkbox.checked))
    : checkboxes.length > 0 && checkboxes.every((checkbox) => checkbox.checked);

  elements.appShell.classList.toggle("is-complete", isComplete);

  if (isComplete && !state.completedTrackedForChecklist) {
    state.completedTrackedForChecklist = true;
    trackPilotEvent("checklist_completed", { itemCount: checkboxes.length });
    trackEvent("checklist_completed", { itemCount: checkboxes.length });
  }
}

// Small text and reset helpers keep checklist display copy consistent.
function clearItems() {
  elements.itemList.replaceChildren();
  updateCompletionState();
}

// Normalizes a checklist row into its final translated {label, warning} shape
// from any of the three source shapes: a structured recommendation
// descriptor (clothingGroup/accessory), a personalized-checklist {label,
// warning} fallback object, or a plain canonical clothing-item string.
function normalizeChecklistItem(item) {
  if (item && item.type === "clothingGroup") {
    const options = item.options.map(translateDomainString).join(" / ");

    return {
      label: `${translateDomainString(item.category)} (${translateDomainString(item.weightLabel)}): ${options}`,
      warning: ""
    };
  }

  if (item && item.type === "accessory") {
    return {
      label: item.options.map(translateDomainString).join(" / "),
      warning: ""
    };
  }

  if (item && typeof item === "object" && !Array.isArray(item)) {
    return {
      label: translateDomainString(item.label ?? ""),
      warning: translateDomainString(item.warning ?? "")
    };
  }

  return {
    label: translateDomainString(String(item)),
    warning: ""
  };
}

function isPersonalizedChecklist(checklist) {
  return checklist
    && typeof checklist === "object"
    && Array.isArray(checklist.sections);
}

function getChecklistItemCount(checklist) {
  if (isPersonalizedChecklist(checklist)) {
    return checklist.sections.reduce((total, section) => total + section.items.length, 0);
  }

  return Array.isArray(checklist) ? checklist.length : 0;
}

// Maps known error types to concise UI states and recovery guidance.
function getErrorCopy(error) {
  if (error instanceof LocationAccessError) {
    if (error.code === "DENIED") {
      return {
        kind: "warning",
        status: t("checklist.errorLocationOffStatus"),
        kicker: t("checklist.kickerLocation"),
        title: t("checklist.errorLocationOffTitle"),
        reason: t("checklist.errorLocationOffReason"),
        footer: t("checklist.errorLocationOffFooter")
      };
    }

    if (error.code === "INSECURE_CONTEXT") {
      return {
        kind: "warning",
        status: t("checklist.errorHttpsNeededStatus"),
        kicker: t("checklist.kickerLocation"),
        title: t("checklist.errorHttpsNeededTitle"),
        reason: t("checklist.errorHttpsNeededReason"),
        footer: t("checklist.errorHttpsNeededFooter")
      };
    }

    return {
      kind: "warning",
      status: t("checklist.errorLocationUnavailableStatus"),
      kicker: t("checklist.kickerLocation"),
      title: t("checklist.errorLocationUnavailableTitle"),
      reason: t("checklist.errorLocationUnavailableReason"),
      footer: t("checklist.errorLocationUnavailableFooter")
    };
  }

  if (error instanceof WeatherFetchError) {
    return {
      kind: "error",
      status: t("checklist.errorWeatherUnavailableStatus"),
      kicker: t("checklist.kickerWeather"),
      title: t("checklist.errorWeatherUnavailableTitle"),
      reason: t("checklist.errorWeatherUnavailableReason"),
      footer: t("checklist.errorWeatherUnavailableFooter")
    };
  }

  return {
    kind: "error",
    status: t("checklist.errorGenericStatus"),
    kicker: t("checklist.kickerError"),
    title: t("checklist.errorGenericTitle"),
    reason: t("checklist.errorGenericReason"),
    footer: t("checklist.errorGenericFooter")
  };
}

// localStorage readers and writers validate every saved value before using it,
// so corrupted or stale data falls back to safe defaults. Exported so
// onboarding's location step can save/read the same device-local location.
export function getSavedLocationForThisDevice() {
  try {
    const rawValue = window.localStorage.getItem(SAVED_LOCATION_STORAGE_KEY);

    if (!rawValue) {
      return null;
    }

    const location = JSON.parse(rawValue);

    if (isValidSavedLocation(location)) {
      return {
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        accuracy: toAccuracy(location.accuracy),
        label: typeof location.label === "string" ? location.label : null,
        savedAt: location.savedAt ?? null
      };
    }

    window.localStorage.removeItem(SAVED_LOCATION_STORAGE_KEY);
  } catch (error) {
    return null;
  }

  return null;
}

export function saveLocationForThisDevice(location) {
  if (!isValidSavedLocation(location)) {
    return;
  }

  try {
    window.localStorage.setItem(SAVED_LOCATION_STORAGE_KEY, JSON.stringify({
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      accuracy: toAccuracy(location.accuracy),
      label: typeof location.label === "string" ? location.label : null,
      savedAt: new Date().toISOString()
    }));
  } catch (error) {
    elements.appStatus.textContent = t("checklist.locationSaveFailedStatus");
  }
}

export function toReminderLocation(location) {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    // Carried through so a typed city keeps its name on the way to storage;
    // a GPS fix has none and falls back to the forecast timezone.
    label: typeof location.label === "string" ? location.label : null
  };
}

// Number(null) is 0, so a plain Number.isFinite check would record a city
// centroid as 0 metres — i.e. perfect precision — when the truth is "unknown".
function toAccuracy(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const accuracy = Number(value);

  return Number.isFinite(accuracy) ? accuracy : null;
}

function isValidSavedLocation(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);

  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}
