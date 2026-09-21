import { createClient } from "@supabase/supabase-js";

// Backs DELETE /api/installations/:id — the user-facing "delete all my data"
// control in Settings. Because Ready has no accounts, the anonymous
// installation id is the only handle that ties rows to one device, so this
// deletes every row keyed to that id across every table.
//
// Deletion order matters: children before parents, or Postgres rejects the
// delete on a foreign-key constraint. app_installations is always last.
const TABLES = {
  appInstallations: ["SUPABASE_APP_INSTALLATIONS_TABLE", "app_installations"],
  analyticsEvents: ["SUPABASE_ANALYTICS_EVENTS_TABLE", "analytics_events"],
  recommendationEvents: ["SUPABASE_RECOMMENDATION_EVENTS_TABLE", "recommendation_events"],
  notificationEvents: ["SUPABASE_NOTIFICATION_EVENTS_TABLE", "notification_events"],
  feedbackSubmissions: ["SUPABASE_FEEDBACK_SUBMISSIONS_TABLE", "feedback_submissions"],
  clientErrors: ["SUPABASE_CLIENT_ERRORS_TABLE", "client_errors"],
  apiPerformanceEvents: ["SUPABASE_API_PERFORMANCE_EVENTS_TABLE", "api_performance_events"],
  referrals: ["SUPABASE_REFERRALS_TABLE", "referrals"],
  referralVisits: ["SUPABASE_REFERRAL_VISITS_TABLE", "referral_visits"],
  pushSubscriptions: ["SUPABASE_PUSH_SUBSCRIPTIONS_TABLE", "push_subscriptions"],
  pilotEvents: ["SUPABASE_PILOT_EVENTS_TABLE", "pilot_events"]
};

let supabaseClient = null;

export function isDataDeletionConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Returns a per-table count of what was removed, so the caller can confirm to
// the user that the request actually did something.
export async function deleteInstallationData(installationId) {
  const client = getClient();
  const deleted = {};

  // Referral visits come first: they reference both app_installations (as the
  // visitor) and referrals (by code). Both directions have to go before the
  // referrals row itself can be removed.
  deleted.referralVisits = await deleteWhere(client, TABLES.referralVisits, "new_installation_id", installationId);

  const ownedCodes = await getOwnedReferralCodes(client, installationId);

  if (ownedCodes.length > 0) {
    deleted.referralVisits += await deleteWhereIn(client, TABLES.referralVisits, "referral_code", ownedCodes);
  }

  deleted.referrals = await deleteWhere(client, TABLES.referrals, "owner_installation_id", installationId);
  deleted.analyticsEvents = await deleteWhere(client, TABLES.analyticsEvents, "installation_id", installationId);
  deleted.recommendationEvents = await deleteWhere(client, TABLES.recommendationEvents, "installation_id", installationId);
  deleted.notificationEvents = await deleteWhere(client, TABLES.notificationEvents, "installation_id", installationId);
  deleted.feedbackSubmissions = await deleteWhere(client, TABLES.feedbackSubmissions, "installation_id", installationId);
  deleted.clientErrors = await deleteWhere(client, TABLES.clientErrors, "installation_id", installationId);
  deleted.apiPerformanceEvents = await deleteWhere(client, TABLES.apiPerformanceEvents, "installation_id", installationId);
  deleted.pushSubscriptions = await deleteWhere(client, TABLES.pushSubscriptions, "installation_id", installationId);

  // pilot_events predates app_installations and stores the same id in its own
  // column with no foreign key, so it has to be matched by name, not by FK.
  deleted.pilotEvents = await deleteWhere(client, TABLES.pilotEvents, "anonymous_device_id", installationId);

  deleted.appInstallations = await deleteWhere(client, TABLES.appInstallations, "id", installationId);

  return deleted;
}

async function getOwnedReferralCodes(client, installationId) {
  const { data, error } = await client
    .from(tableName(TABLES.referrals))
    .select("code")
    .eq("owner_installation_id", installationId);

  if (error) {
    throw new DataDeletionError(error.message);
  }

  return (data ?? []).map((row) => row.code);
}

async function deleteWhere(client, table, column, value) {
  const { data, error } = await client
    .from(tableName(table))
    .delete()
    .eq(column, value)
    .select("*", { count: "exact" });

  if (error) {
    throw new DataDeletionError(`${tableName(table)}: ${error.message}`);
  }

  return data?.length ?? 0;
}

async function deleteWhereIn(client, table, column, values) {
  const { data, error } = await client
    .from(tableName(table))
    .delete()
    .in(column, values)
    .select("*", { count: "exact" });

  if (error) {
    throw new DataDeletionError(`${tableName(table)}: ${error.message}`);
  }

  return data?.length ?? 0;
}

function tableName([envVar, defaultName]) {
  return process.env[envVar] || defaultName;
}

function getClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new DataDeletionError(
      "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return supabaseClient;
}

class DataDeletionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DataDeletionError";
  }
}
