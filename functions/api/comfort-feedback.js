import {
  empty,
  isSubscriptionStoreConfigured,
  json,
  readJson,
  recordComfortFeedback
} from "../_shared/backend.js";
import { parseComfortFeedbackPayload } from "../_shared/comfortFeedback.js";

// Backs the one-tap "how did your last visit feel?" check. Not soft-failed
// like analytics: the person tapped a button and should be told if it did not
// save.
export async function onRequestPost({ request, env }) {
  if (!isSubscriptionStoreConfigured(env)) {
    return json({ error: "Feedback storage is not configured." }, { status: 503 });
  }

  const body = await readJson(request);

  if (!body.ok) {
    return json({ error: body.error }, { status: body.status });
  }

  const parsed = parseComfortFeedbackPayload(body.value);

  if (!parsed.ok) {
    return json({ error: parsed.error }, { status: 400 });
  }

  try {
    await recordComfortFeedback(parsed.value, env);
    return empty();
  } catch (error) {
    console.error("Comfort feedback failed.", error);
    return json({ error: "Feedback could not be saved right now." }, { status: 503 });
  }
}
