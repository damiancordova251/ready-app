// Main browser entry point. Each feature module owns its own DOM wiring; this
// file only initializes them in the right order and wires the few explicit
// cross-feature callbacks that would otherwise create circular imports.
import { initErrorReporting } from "./utils/errorReporting.js";
import { state } from "./state/appState.js";
import { trackPilotEvent } from "./services/pilotAnalytics.js";
import { trackEvent } from "./services/analytics.js";
import { isStandalonePwa } from "./utils/browser.js";
import { applyStaticTranslations } from "./i18n/i18n.js";
import { initLanguageSetting } from "./features/settings/language.js";
import { initFeedbackPrompt } from "./features/feedback/feedbackPrompt.js";
import { initReportIssue } from "./features/feedback/reportIssue.js";
import { initPrivacyControls } from "./features/settings/privacyControls.js";
import { renderWindowRecommendation } from "./features/checklist/checklist.js";
import {
  initializeTimeAwaySetting,
  initTimeAwaySettingListeners
} from "./features/settings/timeAway.js";
import {
  initializeRoutineStartSetting,
  initRoutineStartSettingListeners
} from "./features/settings/routineStart.js";
import {
  handleRoutineStartCommitted,
  handleRoutineStartInputChanged,
  initNotificationSettings
} from "./features/notifications/notificationSettings.js";
import { initClothingPreferencesUI } from "./features/clothingPreferences/clothingPreferencesUI.js";
import { initChecklist } from "./features/checklist/checklist.js";
import { initWeatherScreen } from "./features/weatherScreen/weatherScreen.js";
import { initPwaClient } from "./features/pwa/serviceWorkerClient.js";
import { initOnboarding } from "./features/onboarding/onboarding.js";
import { initShareFab } from "./features/share/shareFab.js";
import { recordReferralVisitIfNeeded } from "./services/referralApi.js";

initErrorReporting();
applyStaticTranslations();

initChecklist();
initWeatherScreen();

initTimeAwaySettingListeners({
  onCommit: () => {
    if (!state.latestWeather) {
      return;
    }

    renderWindowRecommendation(state.latestWeather, new Date(), { source: "time_away_updated" });
  }
});

initRoutineStartSettingListeners({
  onInput: handleRoutineStartInputChanged,
  onCommit: handleRoutineStartCommitted
});

initializeTimeAwaySetting();
initializeRoutineStartSetting();
initNotificationSettings();
initClothingPreferencesUI();
initPwaClient();
initShareFab();
initLanguageSetting();
initFeedbackPrompt();
initReportIssue();
initPrivacyControls();

trackPilotEvent("app_opened", { standalone: isStandalonePwa() });
trackEvent("session_started", { standalone: isStandalonePwa() });
recordReferralVisitIfNeeded();

initOnboarding();
