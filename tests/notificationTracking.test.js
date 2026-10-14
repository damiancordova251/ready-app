import assert from "node:assert/strict";
import { classifyPermissionChange } from "../src/domain/notificationPermission.js";
import { checkSubscriptions } from "../server/scheduler.js";
import { recordSubscriptionExpired } from "../workers/reminder-scheduler/src/index.js";

// --- muting: permission changes between launches ------------------------------

assert.equal(classifyPermissionChange("granted", "denied"), "revoked");
assert.equal(classifyPermissionChange("granted", "default"), "revoked", "Chrome resets a revoked site to default");
assert.equal(classifyPermissionChange("denied", "granted"), "restored");
assert.equal(classifyPermissionChange("default", "granted"), null, "a first opt-in is not a restore");
assert.equal(classifyPermissionChange("granted", "granted"), null);
assert.equal(classifyPermissionChange(null, "denied"), null, "first launch has nothing to compare against");
assert.equal(classifyPermissionChange("granted", "unsupported"), null, "a Safari tab is not a choice anyone made");
assert.equal(classifyPermissionChange("unsupported", "granted"), null);
assert.equal(classifyPermissionChange("nonsense", "denied"), null, "stored junk is ignored");

// --- uninstall: the Node scheduler records before it deletes --------------------

const NOW = new Date("2026-10-14T10:30:00Z");
const due = {
  id: "sub-1",
  installationId: "inst-12345678",
  createdAt: "2026-10-04T10:30:00Z",
  timezone: "UTC",
  routineStartMinutes: 630,
  lastSentDate: null
};

function goneError() {
  const error = new Error("Gone");

  error.subscriptionGone = true;
  error.statusCode = 410;
  return error;
}

{
  const calls = [];

  await checkSubscriptions({
    now: NOW,
    getSubscriptions: async () => [due],
    markSent: async () => calls.push("markSent"),
    removeSubscription: async (id) => calls.push(`remove:${id}`),
    recordExpired: async (record, statusCode) => calls.push(`record:${record.installationId}:${statusCode}`),
    sendReminder: async () => { throw goneError(); }
  });

  assert.deepEqual(calls, ["record:inst-12345678:410", "remove:sub-1"],
    "the expiry is recorded first: after removal nothing says which installation it was");
}

{
  // A recording failure must never leave a dead endpoint to be retried forever.
  const calls = [];
  const quiet = console.error;

  console.error = () => {};
  await checkSubscriptions({
    now: NOW,
    getSubscriptions: async () => [due],
    markSent: async () => {},
    removeSubscription: async (id) => calls.push(`remove:${id}`),
    recordExpired: async () => { throw new Error("db down"); },
    sendReminder: async () => { throw goneError(); }
  });
  console.error = quiet;

  assert.deepEqual(calls, ["remove:sub-1"]);
}

{
  // A healthy send records nothing.
  const calls = [];

  await checkSubscriptions({
    now: NOW,
    getSubscriptions: async () => [due],
    markSent: async () => calls.push("markSent"),
    removeSubscription: async () => calls.push("remove"),
    recordExpired: async () => calls.push("record"),
    sendReminder: async () => {}
  });

  assert.deepEqual(calls, ["markSent"]);
}

// --- uninstall: the Worker's actual payload (this is what runs in production) ---

{
  const realFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 201 });
  };

  const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-key" };

  await recordSubscriptionExpired({ id: "sub-1", installationId: "inst-12345678", createdAt: "2026-10-04T10:30:00Z" }, 410, NOW, env);
  await recordSubscriptionExpired({ id: "sub-2", installationId: null, createdAt: "2026-10-04T10:30:00Z" }, 410, NOW, env);

  globalThis.fetch = realFetch;

  assert.equal(requests.length, 1, "a subscription with no installation link records nothing");
  assert.ok(requests[0].url.includes("/rest/v1/analytics_events"));

  const body = JSON.parse(requests[0].init.body);

  assert.equal(body.installation_id, "inst-12345678");
  assert.equal(body.event_name, "push_subscription_expired");
  assert.deepEqual(body.metadata, { statusCode: 410, daysSubscribed: 10 });
}

{
  // A failed insert is swallowed so the caller still removes the subscription.
  const realFetch = globalThis.fetch;
  const quiet = console.error;

  globalThis.fetch = async () => { throw new Error("network down"); };
  console.error = () => {};

  await assert.doesNotReject(recordSubscriptionExpired(
    { id: "sub-1", installationId: "inst-12345678", createdAt: "2026-10-04T10:30:00Z" }, 410, NOW,
    { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-key" }
  ));

  globalThis.fetch = realFetch;
  console.error = quiet;
}

console.log("Notification tracking examples passed.");
