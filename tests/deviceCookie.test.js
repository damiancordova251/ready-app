import assert from "node:assert/strict";
import {
  DEVICE_COOKIE_NAME,
  buildDeviceCookie,
  buildExpiredDeviceCookie,
  isValidDeviceId,
  readDeviceIdCookie,
  resolveDeviceIdentity
} from "../server/deviceCookie.js";

const UUID = "761dbb65-c654-4a1e-9f3d-2b8c7e5a1d40";
const FALLBACK = "ready-m2x9q1-ab12cd34ef";

// --- id validation -----------------------------------------------------------

// Both shapes src/services/pilotAnalytics.js can mint.
assert.equal(isValidDeviceId(UUID), true);
assert.equal(isValidDeviceId(FALLBACK), true);

// The value arrives from a request header, so anything unexpected is refused
// rather than written to the database.
assert.equal(isValidDeviceId(""), false);
assert.equal(isValidDeviceId("short"), false);
assert.equal(isValidDeviceId("a".repeat(65)), false);
assert.equal(isValidDeviceId("has spaces here"), false);
assert.equal(isValidDeviceId("semi;colon;injection"), false);
assert.equal(isValidDeviceId("quote\"break"), false);
assert.equal(isValidDeviceId(null), false);
assert.equal(isValidDeviceId(undefined), false);
assert.equal(isValidDeviceId(12345678), false);
assert.equal(isValidDeviceId({ toString: () => UUID }), false);

// --- cookie parsing ----------------------------------------------------------

assert.equal(readDeviceIdCookie(`${DEVICE_COOKIE_NAME}=${UUID}`), UUID);

// Real headers carry other cookies, inconsistent spacing, and trailing junk.
assert.equal(readDeviceIdCookie(`a=1; ${DEVICE_COOKIE_NAME}=${UUID}; b=2`), UUID);
assert.equal(readDeviceIdCookie(`a=1;${DEVICE_COOKIE_NAME}=${UUID}`), UUID);
assert.equal(readDeviceIdCookie(`  ${DEVICE_COOKIE_NAME}  =  ${UUID}  `), UUID);
assert.equal(readDeviceIdCookie(`novalue; ${DEVICE_COOKIE_NAME}=${FALLBACK}`), FALLBACK);

// Absent, empty, malformed, or non-string headers all mean "no cookie".
assert.equal(readDeviceIdCookie(""), null);
assert.equal(readDeviceIdCookie(null), null);
assert.equal(readDeviceIdCookie(undefined), null);
assert.equal(readDeviceIdCookie("other=value"), null);
assert.equal(readDeviceIdCookie(`${DEVICE_COOKIE_NAME}=`), null);
assert.equal(readDeviceIdCookie(`${DEVICE_COOKIE_NAME}=not valid`), null);

// A near-miss name must not match the real one.
assert.equal(readDeviceIdCookie(`x${DEVICE_COOKIE_NAME}=${UUID}`), null);

// --- cookie construction -----------------------------------------------------

const cookie = buildDeviceCookie(UUID);

assert.ok(cookie.startsWith(`${DEVICE_COOKIE_NAME}=${UUID}`));

// HttpOnly is the point: no script, ours or a third party's, can read this.
assert.ok(cookie.includes("HttpOnly"));
assert.ok(cookie.includes("SameSite=Lax"));
assert.ok(cookie.includes("Secure"));
assert.ok(cookie.includes("Path=/"));

// 400 days is Chrome's ceiling; asking for more would be silently truncated.
assert.ok(cookie.includes(`Max-Age=${400 * 24 * 60 * 60}`));

// Safari refuses Secure cookies over plain http, which would disable this
// entirely on the Express dev server.
assert.ok(!buildDeviceCookie(UUID, { secure: false }).includes("Secure"));

// Never emit a header for a value we would refuse to read back.
assert.equal(buildDeviceCookie("bad id"), null);
assert.equal(buildDeviceCookie(null), null);

// A built cookie must survive its own parser.
assert.equal(readDeviceIdCookie(buildDeviceCookie(UUID).split(";")[0]), UUID);

// --- cookie expiry -----------------------------------------------------------

const expired = buildExpiredDeviceCookie();

assert.ok(expired.startsWith(`${DEVICE_COOKIE_NAME}=`));
assert.ok(expired.includes("Max-Age=0"));

// A browser only replaces a cookie when Path and the other attributes match the
// original, so a mismatch here would silently leave the real cookie in place
// and make the "Delete my data" promise false.
const attributes = (value) => value.split("; ").slice(1).filter((part) => !part.startsWith("Max-Age")).sort();

assert.deepEqual(
  attributes(expired),
  attributes(buildDeviceCookie(UUID)),
  "expiry must match the set cookie on every attribute except Max-Age"
);

assert.deepEqual(
  attributes(buildExpiredDeviceCookie({ secure: false })),
  attributes(buildDeviceCookie(UUID, { secure: false }))
);

// The expired value must not parse back as a usable id.
assert.equal(readDeviceIdCookie(expired.split(";")[0]), null);

// --- identity resolution -----------------------------------------------------

// First ever visit: no cookie yet, so the installation id becomes the device id
// and the browser is handed the cookie.
assert.deepEqual(
  resolveDeviceIdentity({ installationId: UUID, cookieDeviceId: null }),
  { deviceId: UUID, setCookie: true, storageWiped: false }
);

// Normal return visit: cookie and installation id agree, nothing to do.
assert.deepEqual(
  resolveDeviceIdentity({ installationId: UUID, cookieDeviceId: UUID }),
  { deviceId: UUID, setCookie: false, storageWiped: false }
);

// The case this whole module exists for: localStorage was cleared, the client
// minted a fresh id, but the cookie proves it is the same device.
const wiped = resolveDeviceIdentity({ installationId: FALLBACK, cookieDeviceId: UUID });

assert.equal(wiped.deviceId, UUID, "a wiped device keeps its original identity");
assert.equal(wiped.storageWiped, true);
assert.equal(wiped.setCookie, false, "the cookie must not be rewritten");

// Wiped a second time: still collapses to the ROOT id, not a chain of ids.
// This is why the cookie is never rewritten once set.
const wipedAgain = resolveDeviceIdentity({
  installationId: "ready-zzzzzz-999888777a",
  cookieDeviceId: UUID
});

assert.equal(wipedAgain.deviceId, UUID, "repeat wipes must not fork the identity");

// A junk cookie is ignored rather than trusted, and the browser gets a good one.
assert.deepEqual(
  resolveDeviceIdentity({ installationId: UUID, cookieDeviceId: "../../etc/passwd" }),
  { deviceId: UUID, setCookie: true, storageWiped: false }
);

// An unusable installation id yields no device and no cookie, so a malformed
// request can never write a bogus device_id.
assert.deepEqual(
  resolveDeviceIdentity({ installationId: "nope", cookieDeviceId: UUID }),
  { deviceId: null, setCookie: false, storageWiped: false }
);

console.log("Device cookie examples passed.");
