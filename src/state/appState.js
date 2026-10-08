import { getSavedPushSubscriptionId } from "../services/notificationsApi.js";

// Single shared runtime-state object for the current session. Feature modules
// import and mutate this directly, mirroring the previous single-file
// closure but making the shared shape explicit and easy to find.
export const state = {
  // Guards the one-shot reverse-geocode so a re-render cannot fire a second.
  placeNameLookupInFlight: false,
  latestWeather: null,
  latestRecommendationRequestedAt: null,
  latestLocation: null,
  pushSubscriptionId: getSavedPushSubscriptionId(),
  completedTrackedForChecklist: false,
  weatherScreenTracked: false,
  clothingPreferencesMode: "onboarding",
  onboardingStep: null,
  onboardingSkipOptionalSteps: false,
  onboardingWeather: null,
  onboardingRequestedAt: null,
  onboardingReminderCanContinue: false,
  onboardingCompleting: false,
  startupFlowStarted: false
};
