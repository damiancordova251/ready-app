import { elements } from "../../dom/elements.js";
import { state } from "../../state/appState.js";
import { formatTimeLabel } from "../../utils/format.js";
import { getLocale, t } from "../../i18n/i18n.js";
import { getSavedRoutineStartTime } from "../settings/routineStart.js";
import { createChecklistReminder } from "../../domain/reminders.js";
import { buildNotificationCopy } from "../../domain/notificationCopy.js";
import { classifyPermissionChange } from "../../domain/notificationPermission.js";
import { LAST_NOTIFICATION_PERMISSION_STORAGE_KEY } from "../../constants/storageKeys.js";
import { trackPilotEvent } from "../../services/pilotAnalytics.js";
import { trackEvent } from "../../services/analytics.js";
import {
  clearSavedPushSubscriptionId,
  getBrowserTimezone,
  getNotificationEnvironment,
  requestNotificationPermission,
  savePushSubscriptionId,
  sendTestNotification,
  subscribeToPushReminders,
  unsubscribeFromPushReminders
} from "../../services/notificationsApi.js";

// Notification settings manage browser permission, local test notifications,
// and saving/removing the Web Push subscription that drives scheduled
// reminders. The single Settings button doubles as an enable/disable toggle:
// its label and action depend on whether a subscription is currently saved.
export function initNotificationSettings() {
  checkPermissionChange();
  renderNotificationSetting();
  elements.enableNotificationsButton.addEventListener("click", handleNotificationButtonClick);
  elements.testNotificationButton.addEventListener("click", handleTestNotification);
  elements.testNotificationButton.textContent = t("settings.sendTest");
}

// Notices when someone has switched Ready's notifications off (or back on) in
// their device settings since the last launch. See
// domain/notificationPermission.js for why this can only be caught on launch.
function checkPermissionChange() {
  const current = getNotificationEnvironment().permission;
  let previous = null;

  try {
    previous = window.localStorage.getItem(LAST_NOTIFICATION_PERMISSION_STORAGE_KEY);
    window.localStorage.setItem(LAST_NOTIFICATION_PERMISSION_STORAGE_KEY, current);
  } catch (error) {
    return;
  }

  const change = classifyPermissionChange(previous, current);

  if (change) {
    trackEvent(`notification_permission_${change}`, {
      from: previous,
      to: current,
      remindersWereOn: Boolean(state.pushSubscriptionId)
    });
  }
}

// Wired as the routine-start slider's onInput callback from the app bootstrap
// so this feature can react to routine-time edits without routineStart.js
// having to import this module back (which would create a cycle, since this
// module already imports getSavedRoutineStartTime from routineStart.js).
export function handleRoutineStartInputChanged() {
  renderNotificationSetting();
}

// Wired as the routine-start slider's onCommit callback; re-saves the push
// subscription's schedule so the server sends the next reminder at the new
// time, but only if reminders are actually turned on.
export async function handleRoutineStartCommitted() {
  const environment = getNotificationEnvironment();

  if (environment.permission !== "granted" || !state.pushSubscriptionId) {
    return;
  }

  await syncPushReminderSubscription(t("notifications.notificationsEnabledSaving"));
}

async function handleNotificationButtonClick() {
  const environment = getNotificationEnvironment();

  if (environment.permission === "granted" && state.pushSubscriptionId) {
    await handleDisableNotifications();
    return;
  }

  await handleEnableNotifications();
}

async function handleEnableNotifications() {
  renderNotificationSetting(t("notifications.requestingPermission"));

  const permission = await requestNotificationPermission();

  if (permission === "granted") {
    await syncPushReminderSubscription(t("notifications.notificationsEnabledSaving"));
    return;
  }

  if (permission === "denied") {
    renderNotificationSetting(t("notifications.blockedStatus"));
    return;
  }

  if (permission === "default") {
    renderNotificationSetting(t("notifications.permissionNotGranted"));
    return;
  }

  renderNotificationSetting(t("notifications.unsupportedBrowser"));
}

// Turns reminders off: removes the browser PushSubscription, deletes the
// matching server row (which is what actually cancels any scheduled
// notification), and clears the locally saved subscription id so the toggle
// and its persisted state agree on app restart.
async function handleDisableNotifications() {
  elements.enableNotificationsButton.disabled = true;
  renderNotificationSetting(t("notifications.turningOff"));

  try {
    await unsubscribeFromPushReminders(state.pushSubscriptionId);
    state.pushSubscriptionId = null;
    clearSavedPushSubscriptionId();
    trackEvent("notification_opt_out", {});
    renderNotificationSetting(t("notifications.turnedOff"));
  } catch (error) {
    renderNotificationSetting(t("notifications.turnOffFailed", { error: error.message }));
  } finally {
    elements.enableNotificationsButton.disabled = false;
  }
}

async function handleTestNotification() {
  elements.testNotificationButton.disabled = true;

  try {
    // Uses the same copy builder the real scheduled reminder uses, so a test
    // shows exactly what a real morning reminder will say. It previously had
    // its own fixed "Ready Checklist" wording, which meant the test told you
    // nothing about the message you would actually receive.
    const copy = buildNotificationCopy({
      language: getLocale(),
      weatherSummary: buildTestWeatherSummary(state.latestWeather)
    });

    await sendTestNotification({
      ...createChecklistReminder(),
      title: copy.title,
      body: copy.body
    });
    renderNotificationSetting(t("notifications.testSent"));
  } catch (error) {
    renderNotificationSetting(error.message);
  }
}

// Mirrors the shape domain/notificationCopy.js parseReminderWeather() builds
// for a real send, derived from the forecast the app already has. Returns null
// when no forecast has loaded yet, which the copy builder handles by falling
// back to its generic variant.
function buildTestWeatherSummary(weather) {
  if (!weather) {
    return null;
  }

  // The real reminder reads daily totals. The app keeps hourly detail
  // instead, so today's coldest feels-like and total snowfall come from
  // today's hours.
  const today = typeof weather.daily?.date === "string" ? weather.daily.date : null;
  const hours = (weather.hourly ?? []).filter((hour) => (
    today ? String(hour.time).startsWith(today) : true
  )).slice(0, 24);
  const feels = hours.map((hour) => hour.feelsLike).filter(Number.isFinite);
  const snow = hours.map((hour) => hour.snowfall).filter(Number.isFinite);

  return {
    currentTemp: weather.current?.temperature ?? null,
    feelsLike: weather.current?.feelsLike ?? null,
    lowFeelsLike: feels.length > 0 ? Math.min(...feels) : null,
    highTemp: weather.daily?.high ?? null,
    precipitationProbability: weather.daily?.precipitationProbability ?? null,
    snowfall: snow.length > 0 ? snow.reduce((total, value) => total + value, 0) : null,
    windMax: weather.daily?.windMax ?? null,
    weatherCode: weather.daily?.weatherCode ?? null
  };
}

// Syncs the current browser PushSubscription with the server so scheduled
// reminders can survive restarts through Supabase storage. Exported so the
// onboarding "reminders" step can reuse the exact same enable flow.
export async function syncPushReminderSubscription(statusMessage) {
  renderNotificationSetting(statusMessage);

  try {
    const subscription = await subscribeToPushReminders({
      routineStartMinutes: getSavedRoutineStartTime(),
      timezone: getBrowserTimezone(),
      location: state.latestLocation,
      preferredLanguage: getLocale()
    });

    state.pushSubscriptionId = subscription.id;
    savePushSubscriptionId(subscription.id);
    trackPilotEvent("reminders_enabled", { permission: getNotificationEnvironment().permission });
    trackEvent("notification_opt_in", { permission: getNotificationEnvironment().permission });
    renderNotificationSetting(t("notifications.enabledOn", { scheduledServer: t("notifications.scheduledServer") }));
  } catch (error) {
    renderNotificationSetting(t("notifications.permissionGrantedNotSaved", { error: error.message }));
  }
}

// Recomputes Settings text and button availability from current browser
// notification support, permission, and saved subscription state. Exported so
// checklist/onboarding flows can refresh this panel after location or
// permission changes without duplicating this logic.
export function renderNotificationSetting(statusOverride = null) {
  const environment = getNotificationEnvironment();
  const routineStartLabel = formatTimeLabel(getSavedRoutineStartTime());

  elements.notificationRoutineNote.textContent = getReminderRoutineNote(routineStartLabel);

  if (!environment.supported) {
    elements.notificationStatus.textContent = statusOverride
      ?? getUnsupportedNotificationStatus(environment);
    elements.enableNotificationsButton.textContent = t("notifications.unavailable");
    elements.enableNotificationsButton.disabled = true;
    elements.testNotificationButton.disabled = true;
    return;
  }

  elements.testNotificationButton.disabled = environment.permission !== "granted";

  if (environment.permission === "denied") {
    elements.enableNotificationsButton.disabled = true;
    elements.enableNotificationsButton.textContent = t("notifications.blocked");
    elements.notificationStatus.textContent = statusOverride
      ?? t("notifications.blockedStatus");
    return;
  }

  elements.enableNotificationsButton.disabled = false;

  if (environment.permission === "granted" && state.pushSubscriptionId) {
    elements.enableNotificationsButton.textContent = t("notifications.disableReminders");
    elements.notificationStatus.textContent = statusOverride ?? getEnabledNotificationStatus();
    return;
  }

  if (environment.permission === "granted") {
    elements.enableNotificationsButton.textContent = t("notifications.enableReminders");
    elements.notificationStatus.textContent = statusOverride
      ?? t("notifications.onButStillOff");
    return;
  }

  elements.enableNotificationsButton.textContent = t("notifications.enableReminders");
  elements.notificationStatus.textContent = statusOverride
    ?? getDefaultNotificationStatus(environment);
}

function getUnsupportedNotificationStatus(environment) {
  if (environment.needsHomeScreenInstall) {
    return t("notifications.unsupportedHomeScreen");
  }

  return t("notifications.unsupportedBrowser");
}

function getDefaultNotificationStatus(environment) {
  if (environment.needsHomeScreenInstall) {
    return t("notifications.homeScreenRequired", { scheduledServer: t("notifications.scheduledServer") });
  }

  return t("notifications.supportedDefault", { scheduledServer: t("notifications.scheduledServer") });
}

function getEnabledNotificationStatus() {
  return t("notifications.enabledOn", { scheduledServer: t("notifications.scheduledServer") });
}

function getReminderRoutineNote(routineStartLabel) {
  const note = t("notifications.routineReminderCopy", { time: routineStartLabel });

  if (state.latestLocation) {
    return t("notifications.routineNoteLocation", { note });
  }

  return note;
}
