import {
  empty,
  isSubscriptionStoreConfigured,
  json,
  parseAnalyticsEventPayload,
  readJson,
  recordAnalyticsEvent
} from "../../_shared/backend.js";
import {
  buildDeviceCookie,
  readDeviceIdCookie,
  resolveDeviceIdentity
} from "../../_shared/deviceCookie.js";

// Backs src/services/analytics.js's trackEvent(). Soft-fails like
// pilot-events.js: analytics must never break the app experience.
export async function onRequestPost({ request, env }) {
  if (!isSubscriptionStoreConfigured(env)) {
    return json({ ok: false }, { status: 202 });
  }

  const body = await readJson(request);

  if (!body.ok) {
    return json({ error: body.error }, { status: body.status });
  }

  const parsed = parseAnalyticsEventPayload(body.value);

  if (!parsed.ok) {
    return json({ error: parsed.error }, { status: 400 });
  }

  // Recovers the device behind this installation id when localStorage was
  // cleared since the last visit — on iOS, Safari deletes it after 7 days
  // without a visit — so one person does not keep arriving as a new device.
  const identity = resolveDeviceIdentity({
    installationId: parsed.value.installationId,
    cookieDeviceId: readDeviceIdCookie(request.headers.get("Cookie"))
  });

  try {
    await recordAnalyticsEvent({ ...parsed.value, deviceId: identity.deviceId }, env);
    return withDeviceCookie(empty(), identity);
  } catch (error) {
    console.error("Analytics event logging failed.", error);
    return withDeviceCookie(json({ ok: false }, { status: 202 }), identity);
  }
}

// Pages always serves over https, so the cookie is unconditionally Secure here.
// The Express dev server is the only runtime that needs the http exception.
function withDeviceCookie(response, identity) {
  if (!identity.setCookie) {
    return response;
  }

  const cookie = buildDeviceCookie(identity.deviceId, { secure: true });

  if (cookie) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}
