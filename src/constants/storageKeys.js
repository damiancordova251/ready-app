// Central registry for the localStorage keys the app bootstrap and feature
// modules read/write, so key names live in one place instead of as scattered
// magic strings. Clothing-preference keys stay colocated with
// domain/clothingPreferences.js since they are only ever used there.
export const ROUTINE_START_STORAGE_KEY = "morningWearRoutineStartMinutes";
export const LEGACY_WAKE_TIME_STORAGE_KEY = "morningWearWakeTimeMinutes";
export const PUSH_SUBSCRIPTION_ID_STORAGE_KEY = "morningWearPushSubscriptionId";
export const SAVED_LOCATION_STORAGE_KEY = "readySavedLocation";
export const TIME_AWAY_STORAGE_KEY = "readyExpectedTimeAwayHours";
export const ONBOARDING_COMPLETED_STORAGE_KEY = "readyOnboardingCompleted";
export const ONBOARDING_STARTED_STORAGE_KEY = "readyOnboardingStarted";
export const LANGUAGE_STORAGE_KEY = "readyLanguage";
export const ACTIVE_DAYS_LOG_STORAGE_KEY = "readyActiveDaysLog";
export const FEEDBACK_PROMPT_STATE_STORAGE_KEY = "readyFeedbackPromptState";
export const INSTALLATION_ID_STORAGE_KEY = "readyPilotAnonymousDeviceId";
export const REFERRAL_CODE_STORAGE_KEY = "readyReferralCode";
export const PENDING_REFERRAL_VISIT_STORAGE_KEY = "readyPendingReferralVisit";
export const INSTALL_PROMPT_STATE_STORAGE_KEY = "readyInstallPromptState";
