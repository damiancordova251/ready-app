import { APP_CONFIG } from "../config.js";
import { PUSH_SUBSCRIPTION_ID_STORAGE_KEY } from "../constants/storageKeys.js";
import { isStandalonePwa } from "./browser.js";

// Coarse device context sent alongside analytics events so app_installations
// describes itself at a glance — which platform, whether the PWA was actually
// installed to the home screen, whether reminders are on.
//
// Deliberately coarse: this records "ios"/"safari"/"mobile", never the raw
// user-agent string, so the row stays a rough device description rather than
// something closer to a fingerprint.
export function getDeviceContext() {
  const userAgent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";

  return {
    timezone: getTimezone(),
    platform: getPlatform(userAgent),
    os: getOsWithVersion(userAgent),
    browser: getBrowser(userAgent),
    deviceType: getDeviceType(userAgent),
    pwaInstalled: isStandalonePwa(),
    notificationPermission: getNotificationPermission(),
    remindersEnabled: hasSavedPushSubscription(),
    appVersion: APP_CONFIG.appVersion
  };
}

function getTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch (error) {
    return null;
  }
}

// iPadOS reports itself as a Mac, so a touch-capable "Mac" is really an iPad.
function getPlatform(userAgent) {
  if (/iPhone|iPod/i.test(userAgent)) {
    return "ios";
  }

  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)) {
    return "ios";
  }

  if (/Android/i.test(userAgent)) {
    return "android";
  }

  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return "macos";
  }

  if (/Windows/i.test(userAgent)) {
    return "windows";
  }

  if (/Linux|X11|CrOS/i.test(userAgent)) {
    return "linux";
  }

  return "other";
}

// Only iOS and Android expose a version reliably enough to be worth recording.
function getOsWithVersion(userAgent) {
  const platform = getPlatform(userAgent);
  const ios = userAgent.match(/OS (\d+)[_.](\d+)/);

  if (platform === "ios" && ios) {
    return `iOS ${ios[1]}.${ios[2]}`;
  }

  const android = userAgent.match(/Android (\d+(?:\.\d+)?)/);

  if (platform === "android" && android) {
    return `Android ${android[1]}`;
  }

  return platform;
}

// Order matters: Edge and Chrome both claim "Safari", Edge also claims "Chrome".
function getBrowser(userAgent) {
  if (/Edg\//i.test(userAgent)) {
    return "edge";
  }

  if (/FxiOS|Firefox/i.test(userAgent)) {
    return "firefox";
  }

  if (/CriOS|Chrome/i.test(userAgent)) {
    return "chrome";
  }

  if (/Safari/i.test(userAgent)) {
    return "safari";
  }

  return "other";
}

function getDeviceType(userAgent) {
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)) {
    return "tablet";
  }

  if (/Tablet|PlayBook|Silk/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent))) {
    return "tablet";
  }

  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(userAgent)) {
    return "mobile";
  }

  return "desktop";
}

function getNotificationPermission() {
  try {
    return "Notification" in window ? Notification.permission : "unsupported";
  } catch (error) {
    return null;
  }
}

// The saved subscription id is what the app itself treats as "reminders are
// on", so it is the same source of truth the Settings toggle reads.
function hasSavedPushSubscription() {
  try {
    return Boolean(window.localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY));
  } catch (error) {
    return false;
  }
}
