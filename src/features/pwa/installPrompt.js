import { elements } from "../../dom/elements.js";
import { t } from "../../i18n/i18n.js";
import {
  INSTALL_PROMPT_STATE_STORAGE_KEY,
  ONBOARDING_COMPLETED_STORAGE_KEY
} from "../../constants/storageKeys.js";
import { isInAppBrowser, isLikelyIos, isStandalonePwa } from "../../utils/browser.js";
import { trackEvent } from "../../services/analytics.js";

// Nudges people to add Ready to their home screen. This matters more than it
// looks: on iOS, Web Push only works from an installed PWA, so anyone using
// Ready in a Safari tab can never receive a reminder — the feature most likely
// to turn a one-time visit into a habit.
const SHOW_DELAY_MS = 6000;
const DISMISS_COOLDOWN_DAYS = 7;

export function initInstallPrompt() {
  if (!elements.installBanner || isStandalonePwa()) {
    return;
  }

  elements.installDismissButton.addEventListener("click", dismiss);
  listenForAndroidInstallPrompt();

  // Delayed so it never competes with onboarding or the first checklist.
  window.setTimeout(() => {
    if (shouldShow()) {
      show();
    }
  }, SHOW_DELAY_MS);
}

let deferredPrompt = null;

// Chrome/Android can trigger a real install dialog. Safari cannot, which is
// why the iOS path below has to be written instructions instead.
function listenForAndroidInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
  });
}

function shouldShow() {
  if (isStandalonePwa()) {
    return false;
  }

  if (!hasCompletedOnboarding()) {
    return false;
  }

  const state = readState();

  if (state.dismissedUntil && Date.now() < state.dismissedUntil) {
    return false;
  }

  return true;
}

function show() {
  const copy = getCopyForPlatform();

  elements.installBannerTitle.textContent = copy.title;
  elements.installBannerBody.textContent = copy.body;
  elements.installDismissButton.textContent = t("install.dismiss");

  // Only Android/Chrome gets a working button; on iOS a button would imply an
  // action the browser does not actually offer.
  if (copy.canPrompt && deferredPrompt) {
    elements.installActionButton.hidden = false;
    elements.installActionButton.textContent = t("install.action");
    elements.installActionButton.onclick = runAndroidInstall;
  } else {
    elements.installActionButton.hidden = true;
  }

  elements.installBanner.hidden = false;
  trackEvent("install_instructions_viewed", { platform: copy.platform });
}

function getCopyForPlatform() {
  if (isInAppBrowser()) {
    return {
      platform: "in_app_browser",
      title: t("install.inAppTitle"),
      body: t("install.inAppBody"),
      canPrompt: false
    };
  }

  if (isLikelyIos()) {
    return {
      platform: "ios",
      title: t("install.iosTitle"),
      body: t("install.iosBody"),
      canPrompt: false
    };
  }

  return {
    platform: "other",
    title: t("install.genericTitle"),
    body: t("install.genericBody"),
    canPrompt: true
  };
}

async function runAndroidInstall() {
  if (!deferredPrompt) {
    return;
  }

  deferredPrompt.prompt();

  const choice = await deferredPrompt.userChoice.catch(() => null);

  deferredPrompt = null;
  elements.installBanner.hidden = true;

  if (choice?.outcome === "accepted") {
    writeState({});
    return;
  }

  dismiss();
}

function dismiss() {
  elements.installBanner.hidden = true;
  writeState({ dismissedUntil: Date.now() + DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000 });
}

function hasCompletedOnboarding() {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY) === "true";
  } catch (error) {
    return false;
  }
}

function readState() {
  try {
    const raw = window.localStorage.getItem(INSTALL_PROMPT_STATE_STORAGE_KEY);

    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function writeState(state) {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Best-effort; worst case the prompt reappears sooner than intended.
  }
}
