// Bump APP_VERSION whenever cached app shell or icon assets need to be refreshed
// for installed PWAs. Also add a matching entry to src/changelog.js each time —
// that's what the update-available banner's "what's new" line shows.
const APP_VERSION = "privacy-consent-data-controls";
const CACHE_NAME = `ready-${APP_VERSION}`;

// Core assets use network-first caching so pilot deployments are less likely to
// get stuck on stale HTML, JS, or CSS. Kept in sync with the src/ module tree
// (constants/state/dom/utils/services/domain/features).
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./privacy.html",
  "./terms.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./src/app.js",
  "./src/config.js",
  "./src/changelog.js",
  "./src/constants/storageKeys.js",
  "./src/state/appState.js",
  "./src/dom/elements.js",
  "./src/utils/format.js",
  "./src/utils/browser.js",
  "./src/utils/errorReporting.js",
  "./src/services/weather.js",
  "./src/services/location.js",
  "./src/services/notificationsApi.js",
  "./src/services/pilotAnalytics.js",
  "./src/services/analytics.js",
  "./src/services/referralApi.js",
  "./src/services/privacyApi.js",
  "./src/domain/recommendation.js",
  "./src/domain/personalizedChecklist.js",
  "./src/domain/clothingPreferences.js",
  "./src/domain/reminders.js",
  "./src/i18n/i18n.js",
  "./src/i18n/domainStrings.js",
  "./src/i18n/translations/en.js",
  "./src/i18n/translations/es.js",
  "./src/features/onboarding/onboarding.js",
  "./src/features/checklist/checklist.js",
  "./src/features/weatherScreen/weatherScreen.js",
  "./src/features/settings/timeAway.js",
  "./src/features/settings/routineStart.js",
  "./src/features/settings/language.js",
  "./src/features/settings/privacyControls.js",
  "./src/features/notifications/notificationSettings.js",
  "./src/features/clothingPreferences/clothingPreferencesUI.js",
  "./src/features/feedback/feedbackPrompt.js",
  "./src/features/feedback/reportIssue.js",
  "./src/features/pwa/serviceWorkerClient.js",
  "./src/features/share/shareFab.js"
];

// Icon assets can safely use cache-first behavior because they are versioned by
// the service worker cache name and change less often than app code.
const ICON_ASSETS = [
  "./icons/app-icon.svg",
  "./icons/app-icon-180.png",
  "./icons/app-icon-192.png",
  "./icons/app-icon-512.png"
];
const ICON_PATHS = new Set(ICON_ASSETS.map(toAssetPath));

// During install, pre-cache the app shell and ask the browser to activate this
// worker without waiting for old tabs to close.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([
      ...CORE_ASSETS,
      ...ICON_ASSETS
    ]))
  );
  self.skipWaiting();
});

// Activation removes all older Ready caches and lets this worker control open
// clients so refreshes use the newest cached assets.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) {
          return caches.delete(key);
        }

        return null;
      })))
      .then(() => self.clients.claim())
  );
});

// Fetch handling skips API and cross-origin requests, uses network-first for app
// pages/code, and keeps icons cache-first.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith("/api/")) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, "./index.html"));
    return;
  }

  if (ICON_PATHS.has(requestUrl.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

// Push events display the reminder payload from the backend, with safe default
// copy if the payload is missing or malformed.
self.addEventListener("push", (event) => {
  const reminder = getPushReminder(event);

  event.waitUntil(
    self.registration.showNotification(reminder.title, {
      body: reminder.body,
      tag: reminder.tag ?? "ready-checklist",
      icon: "./icons/app-icon-192.png",
      badge: "./icons/app-icon-192.png",
      data: {
        url: reminder.url ?? "./",
        notificationEventId: reminder.notificationEventId ?? null
      }
    })
  );
});

// Notification clicks focus an existing app window when possible, otherwise they
// open a new app window and mark the launch as notification-driven. Also
// reports back to notification_events (best-effort; a fetch failure here
// never blocks focusing/opening the app).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(Promise.all([
    openOrFocusAppFromNotification(event.notification.data?.url),
    reportNotificationEvent(event.notification.data?.notificationEventId, "opened")
  ]));
});

// Fires only when a notification is explicitly dismissed/swiped away (not on
// click), and isn't supported in every browser — best-effort signal only.
self.addEventListener("notificationclose", (event) => {
  event.waitUntil(reportNotificationEvent(event.notification.data?.notificationEventId, "dismissed"));
});

// Network-first caching gives fresh deployments priority while preserving a
// cached fallback for offline or flaky network moments.
async function networkFirst(request, fallbackUrl = null) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);

    if (response.ok) {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request);

    if (cached) {
      return cached;
    }

    if (fallbackUrl) {
      return caches.match(fallbackUrl);
    }

    throw error;
  }
}

// Cache-first is reserved for stable icon files so they load quickly after
// install without risking stale app behavior.
async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }

  return response;
}

// Best-effort only: swallows every failure so a missing id, offline device,
// or backend hiccup never affects notification click/close behavior.
async function reportNotificationEvent(notificationEventId, outcome) {
  if (!notificationEventId) {
    return;
  }

  try {
    await fetch(`/api/notifications/events/${notificationEventId}/${outcome}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
  } catch (error) {
    // Ignored — see comment above.
  }
}

function getPushReminder(event) {
  if (!event.data) {
    return getDefaultReminder();
  }

  try {
    return {
      ...getDefaultReminder(),
      ...event.data.json()
    };
  } catch (error) {
    return {
      ...getDefaultReminder(),
      body: event.data.text() || getDefaultReminder().body
    };
  }
}

function getDefaultReminder() {
  return {
    title: "Ready Checklist",
    body: "Your weather checklist is ready.",
    tag: "ready-checklist",
    url: "./"
  };
}

// Focuses an existing Ready window, or opens one if no app window is available.
async function openOrFocusAppFromNotification(notificationUrl = "./") {
  const targetUrl = getNotificationClickUrl(notificationUrl);
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  const matchingClient = windowClients.find((client) => {
    const clientUrl = new URL(client.url);

    return clientUrl.origin === new URL(targetUrl).origin;
  });

  if (matchingClient) {
    matchingClient.postMessage({ type: "notification_clicked" });
    return matchingClient.focus();
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl);
  }

  return null;
}

// Adds a URL marker so the frontend can track notification opens anonymously.
function getNotificationClickUrl(notificationUrl) {
  const targetUrl = new URL(notificationUrl, self.registration.scope);

  targetUrl.searchParams.set("notification", "clicked");
  return targetUrl.href;
}

// Normalizes relative asset paths into pathnames for fetch-route matching.
function toAssetPath(asset) {
  return new URL(asset, self.registration.scope).pathname;
}
