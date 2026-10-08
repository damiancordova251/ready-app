import assert from "node:assert/strict";
import { buildNotificationCopy, selectNotificationVariant } from "../server/notificationCopy.js";

// --- variant selection -------------------------------------------------------

// No weather data at all -> always the generic fallback, regardless of language.
assert.equal(selectNotificationVariant(null), "generic");
assert.equal(buildNotificationCopy({ language: "en" }).variant, "generic");
assert.equal(buildNotificationCopy({ language: "en" }).title, "✅ Your checklist is ready");
assert.equal(buildNotificationCopy({ language: "es" }).title, "✅ Tu lista está lista");

// Rain takes priority when the probability clears the threshold.
assert.equal(selectNotificationVariant({ precipitationProbability: 60 }), "rain");

// Below the rain threshold, a cold feels-like wins next.
assert.equal(selectNotificationVariant({ precipitationProbability: 20, feelsLike: 38 }), "cold");

// A big rise from current to today's high surfaces the "warm" variant.
assert.equal(selectNotificationVariant({ currentTemp: 55, highTemp: 75 }), "warm");

// Mild, unremarkable weather falls back to the generic message.
assert.equal(selectNotificationVariant({ precipitationProbability: 10, feelsLike: 65, currentTemp: 65, highTemp: 70 }), "generic");

// Rain outranks cold and warm when multiple thresholds are crossed at once.
assert.equal(selectNotificationVariant({ precipitationProbability: 80, feelsLike: 30, currentTemp: 40, highTemp: 70 }), "rain");

// --- condition in the title, action in the body ------------------------------

const rain = buildNotificationCopy({ language: "en", weatherSummary: { precipitationProbability: 70 } });
assert.equal(rain.title, "🌧️ 70% chance of rain today");
assert.equal(rain.body, "Bring an umbrella — open Ready for your full checklist.");

const cold = buildNotificationCopy({ language: "en", weatherSummary: { feelsLike: 31.4 } });
assert.equal(cold.title, "🧥 Feels like 31° out there");
assert.equal(cold.body, "Bring a warm layer — open Ready for your full checklist.");

const warm = buildNotificationCopy({ language: "en", weatherSummary: { currentTemp: 55, highTemp: 78.6 } });
assert.equal(warm.title, "☀️ Warming up to 79° later");
assert.equal(warm.body, "Dress light — open Ready for your full checklist.");

// Spanish carries the same numbers through its own templates.
const rainEs = buildNotificationCopy({ language: "es", weatherSummary: { precipitationProbability: 55 } });
assert.equal(rainEs.title, "🌧️ 55% de probabilidad de lluvia hoy");
assert.equal(rainEs.body, "Lleva un paraguas — abre Ready para ver tu lista completa.");

// Values are rounded, never shown as long decimals.
assert.equal(
  buildNotificationCopy({ language: "en", weatherSummary: { precipitationProbability: 66.6 } }).title,
  "🌧️ 67% chance of rain today"
);

// No template placeholder may ever survive into a sent notification.
["en", "es"].forEach((language) => {
  [
    null,
    { precipitationProbability: 70 },
    { feelsLike: 20 },
    { currentTemp: 50, highTemp: 80 },
    { precipitationProbability: 5, feelsLike: 70, currentTemp: 70, highTemp: 72 }
  ].forEach((weatherSummary) => {
    const copy = buildNotificationCopy({ language, weatherSummary });

    assert.ok(!copy.title.includes("{"), `unfilled placeholder in title: ${copy.title}`);
    assert.ok(!copy.body.includes("{"), `unfilled placeholder in body: ${copy.body}`);
  });
});

// Unrecognized language falls back to English rather than throwing.
assert.equal(buildNotificationCopy({ language: "fr" }).title, "✅ Your checklist is ready");

console.log("Notification copy examples passed.");
