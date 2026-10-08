// Restores a device's identity after its localStorage is cleared.
//
// src/services/pilotAnalytics.js mints an anonymous id and keeps it in
// localStorage. That storage is script-writable, which on iOS means Safari's
// ITP deletes it after 7 days without a visit (installed PWAs are exempt).
// A returning person then looks like a brand-new device, and every count built
// on app_installations drifts upward forever.
//
// A cookie set by the SERVER is not script-writable, so it is not part of that
// sweep. We set one, read it back on the next visit, and use it to tie the new
// installation id to the device that already existed.
//
// Deliberately narrow: this adds NO new information about anyone. It carries
// the same anonymous id the app already stored, it is first-party and HttpOnly
// (so no script, ours or anyone else's, can read it), and it is never sent
// anywhere but our own API. It exists to stop double-counting one person, not
// to learn anything new about them.
//
// Pure and dependency-free (no Node built-ins, no network) so this exact file
// is duplicated into functions/_shared/, matching the convention already used
// by server/notificationCopy.js.

export const DEVICE_COOKIE_NAME = "ready_did";

// Chrome caps cookie lifetime at 400 days and silently truncates anything
// longer, so asking for more would just be a lie in the header.
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

// Both id shapes the client can produce: crypto.randomUUID(), and the
// `ready-<base36>-<base36>` fallback for browsers without it. Anything else is
// treated as absent rather than trusted — the value arrives from a request
// header, so it is only ever used after passing this.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function isValidDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

// Minimal RFC 6265 cookie-header parse: enough for one known name, and
// tolerant of the whitespace and stray empty pairs real clients send.
export function readDeviceIdCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() !== DEVICE_COOKIE_NAME) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();

    return isValidDeviceId(value) ? value : null;
  }

  return null;
}

// secure is a parameter rather than a constant because Safari rejects Secure
// cookies over plain http, which would silently disable this on the Express
// dev server.
export function buildDeviceCookie(deviceId, { secure = true } = {}) {
  if (!isValidDeviceId(deviceId)) {
    return null;
  }

  return [
    `${DEVICE_COOKIE_NAME}=${deviceId}`,
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

// Clears the cookie. The privacy policy promises "Delete my data" removes
// everything, and this cookie is HttpOnly — no client script can reach it — so
// the delete endpoints have to expire it server-side or that promise is false.
//
// Attributes other than Max-Age must match buildDeviceCookie exactly, or the
// browser treats this as a different cookie and leaves the original in place.
export function buildExpiredDeviceCookie({ secure = true } = {}) {
  return [
    `${DEVICE_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

// Decides which device this installation id belongs to.
//
// The cookie always holds the ROOT device id and is never rewritten once set,
// so a device wiped repeatedly collapses to one identity rather than a chain:
// wipe A -> B keeps the cookie at A, and a later wipe to C still reads A.
//
// Returns:
//   deviceId      what to store on the installation row
//   setCookie     true when the browser has no usable cookie yet
//   storageWiped  true when the cookie proves this is a returning device whose
//                 local storage was cleared — the signal worth counting
export function resolveDeviceIdentity({ installationId, cookieDeviceId }) {
  if (!isValidDeviceId(installationId)) {
    return { deviceId: null, setCookie: false, storageWiped: false };
  }

  if (!isValidDeviceId(cookieDeviceId)) {
    return { deviceId: installationId, setCookie: true, storageWiped: false };
  }

  return {
    deviceId: cookieDeviceId,
    setCookie: false,
    storageWiped: cookieDeviceId !== installationId
  };
}
