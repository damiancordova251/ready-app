// Small browser-capability checks reused by both the notification service and
// the app bootstrap, so standalone/PWA detection stays in one place.
export function isStandalonePwa() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

// iPhone notification support depends on the app being opened from the Home
// Screen, so several features branch on this. iPadOS reports itself as a Mac,
// hence the touch-point check.
export function isLikelyIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Links shared through the native share sheet usually land in a messaging
// app's in-app browser rather than Safari or Chrome. Several of those
// webviews block geolocation outright, or never surface the permission
// prompt, which looks to the user like the button simply does nothing.
// Detecting it lets the UI say something true instead of "please allow
// location access", for which there is no prompt to allow.
export function isInAppBrowser() {
  const userAgent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";

  return /Instagram|FBAN|FBAV|FB_IAB|Messenger|Line\/|Snapchat|TikTok|BytedanceWebview|musical_ly|LinkedInApp|Pinterest|Twitter/i
    .test(userAgent);
}
