import {
  deleteInstallationData,
  isDataDeletionConfigured,
  isValidAnonymousDeviceId,
  json
} from "../../_shared/backend.js";

// Backs the "Delete my data" control in Settings. Unlike the analytics
// endpoints, this one does NOT soft-fail: if deletion did not happen the user
// must be told so, never shown a false confirmation.
export async function onRequestDelete({ params, env }) {
  if (!isDataDeletionConfigured(env)) {
    return json({ error: "Data deletion is not available right now." }, { status: 503 });
  }

  if (!isValidAnonymousDeviceId(params.id)) {
    return json({ error: "A valid installation id is required." }, { status: 400 });
  }

  try {
    const deleted = await deleteInstallationData(params.id, env);
    return json({ ok: true, deleted });
  } catch (error) {
    console.error("Data deletion failed.", error);
    return json({ error: "Data could not be deleted right now. Please try again later." }, { status: 503 });
  }
}
