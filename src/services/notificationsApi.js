import { APP_CONFIG } from "../config.js";
import { INSTALLATION_ID_STORAGE_KEY, PUSH_SUBSCRIPTION_ID_STORAGE_KEY } from "../constants/storageKeys.js";
import { isLikelyIos, isStandalonePwa } from "../utils/browser.js";

const APP_ICON_URL = "./icons/app-icon-192.png";

// Capability checks are kept together because iOS, installed PWAs, and desktop
// browsers expose slightly different pieces of the notification APIs.
export function areNotificationsSupported() {
  return "Notification" in window
    && "serviceWorker" in navigator
    && "ServiceWorkerRegistration" in window
    && "showNotification" in ServiceWorkerRegistration.prototype;
}

export function getNotificationPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

export function getNotificationEnvironment() {
  return {
    supported: areNotificationsSupported(),
    permission: getNotificationPermission(),
    needsHomeScreenInstall: isLikelyIos() && !isStandalonePwa()
  };
}

// Permission and local test notification helpers power the Settings controls
// without touching the backend subscription store.
export async function requestNotificationPermission() {
  if (!areNotificationsSupported()) {
    return "unsupported";
  }

  return Notification.requestPermission();
}

export async function sendTestNotification(reminder) {
  if (!areNotificationsSupported()) {
    throw new Error("Notifications are not supported in this browser.");
  }

  if (getNotificationPermission() !== "granted") {
    throw new Error("Notification permission is not granted yet.");
  }

  const registration = await navigator.serviceWorker.ready;

  await registration.showNotification(reminder.title, {
    body: reminder.body,
    tag: reminder.tag,
    renotify: true,
    icon: APP_ICON_URL,
    badge: APP_ICON_URL,
    data: {
      url: reminder.url
    }
  });
}

// Creates or reuses the browser PushSubscription, then saves the subscription
// details to the backend for scheduled Web Push reminders. `location`, if
// provided, is rounded to 1 decimal degree (~11km) right here, before it's
// ever sent — the exact coordinates never leave the device for this purpose.
// Letting the scheduler mention weather context in a reminder is the only
// reason any location is sent to the server at all; omit `location` (or pass
// none) and the subscription is saved exactly as before, with the scheduler
// falling back to its existing generic message.
export async function subscribeToPushReminders({ routineStartMinutes, timezone, location, preferredLanguage }) {
  if (!areNotificationsSupported()) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  if (getNotificationPermission() !== "granted") {
    throw new Error("Notification permission is not granted yet.");
  }

  const registration = await navigator.serviceWorker.ready;
  const vapidPublicKey = await fetchVapidPublicKey();
  const subscription = await getOrCreatePushSubscription(registration, vapidPublicKey);
  const coarseLocation = roundToCoarseLocation(location);
  const installationId = getInstallationId();
  const response = await postJson("/api/push/subscriptions", {
    subscription: subscription.toJSON(),
    routineStartMinutes,
    timezone,
    ...(coarseLocation ?? {}),
    ...(preferredLanguage ? { preferredLanguage } : {}),
    ...(installationId ? { installationId } : {})
  });

  return response.subscription;
}

// Links the subscription back to the same anonymous id used elsewhere in
// analytics, so a sent reminder can be recorded as a notification_events row.
// Omitted (never blocking subscribe) if unavailable for any reason.
function getInstallationId() {
  try {
    return window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

function roundToCoarseLocation(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    coarseLatitude: Math.round(latitude * 10) / 10,
    coarseLongitude: Math.round(longitude * 10) / 10
  };
}

// Removes the browser PushSubscription and deletes the matching server row so
// scheduled reminders stop immediately. Re-enabling later goes through
// subscribeToPushReminders again, which recreates whatever is missing.
export async function unsubscribeFromPushReminders(subscriptionId) {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        await existingSubscription.unsubscribe();
      }
    } catch (error) {
      // Browser-side unsubscribe is best-effort; the server row is still
      // removed below so scheduled reminders stop either way.
    }
  }

  if (subscriptionId) {
    await deleteJson(`/api/push/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
}

// Backend helpers wrap small JSON API calls and keep URL construction compatible
// with both local development and hosted deployments.
export async function sendServerTestNotification(subscriptionId) {
  const response = await postJson("/api/push/test", { subscriptionId });

  return response;
}

export function getBrowserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Persists which browser PushSubscription this device last saved, so the
// Settings toggle can tell "subscribed" from "not subscribed" across restarts.
export function getSavedPushSubscriptionId() {
  try {
    return window.localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

export function savePushSubscriptionId(subscriptionId) {
  try {
    window.localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, subscriptionId);
    return true;
  } catch (error) {
    return false;
  }
}

export function clearSavedPushSubscriptionId() {
  try {
    window.localStorage.removeItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY);
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchVapidPublicKey() {
  const response = await fetch(apiUrl("/api/push/public-key"));

  if (!response.ok) {
    throw new Error("Reminder server is missing VAPID keys.");
  }

  const data = await response.json();

  if (!data.publicKey) {
    throw new Error("Reminder server did not return a VAPID public key.");
  }

  return data.publicKey;
}

async function getOrCreatePushSubscription(registration, vapidPublicKey) {
  const existingSubscription = await registration.pushManager.getSubscription();

  if (existingSubscription) {
    return existingSubscription;
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
  });
}

async function postJson(path, payload) {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? "Reminder server request failed.");
  }

  return data;
}

async function deleteJson(path) {
  const response = await fetch(apiUrl(path), {
    method: "DELETE"
  });

  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => ({}));

    throw new Error(data.error ?? "Reminder server request failed.");
  }
}

// Resolves relative API paths against either an override base URL or the current
// app origin.
function apiUrl(path) {
  const baseUrl = APP_CONFIG.pushApiBaseUrl || window.location.origin;

  return new URL(path, baseUrl).toString();
}

// Browser Push expects the VAPID key as bytes, while the backend exposes it as
// URL-safe base64 text.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}
