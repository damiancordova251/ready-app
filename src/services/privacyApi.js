import { APP_CONFIG } from "../config.js";
import {
  INSTALLATION_ID_STORAGE_KEY,
  PUSH_SUBSCRIPTION_ID_STORAGE_KEY
} from "../constants/storageKeys.js";
import { unsubscribeFromPushReminders } from "./notificationsApi.js";

// Every localStorage key this app writes starts with one of these. Clearing by
// prefix (rather than an explicit list) means a key added later can't be
// silently left behind by a "delete everything" request.
const STORAGE_KEY_PREFIXES = ["ready", "morningWear"];

// Deletes this device's data from the server, stops any scheduled reminders,
// and wipes local state. Deliberately strict: if the server delete fails, this
// throws instead of clearing local data, so the user is never shown a
// confirmation for something that only half happened.
export async function deleteAllMyData() {
  const installationId = readStorage(INSTALLATION_ID_STORAGE_KEY);

  if (installationId) {
    const response = await fetch(apiUrl(`/api/installations/${installationId}`), {
      method: "DELETE"
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      throw new Error(data.error ?? "Data could not be deleted right now.");
    }
  }

  // Best-effort: the push subscription row is already gone from the database
  // above, so this is really about telling the browser to drop its own
  // subscription. A failure here must not fail the whole request.
  try {
    await unsubscribeFromPushReminders(readStorage(PUSH_SUBSCRIPTION_ID_STORAGE_KEY));
  } catch (error) {
    // Ignored; server-side rows are already deleted.
  }

  clearLocalData();
}

function clearLocalData() {
  try {
    const keys = Object.keys(window.localStorage)
      .filter((key) => STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));

    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    // Best-effort; the server-side delete is the part that actually matters.
  }
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function apiUrl(path) {
  const baseUrl = APP_CONFIG.pushApiBaseUrl || window.location.origin;

  return new URL(path, baseUrl).toString();
}
