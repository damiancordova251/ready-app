import assert from "node:assert/strict";
import {
  buildNotificationCopy,
  buildReminderWeatherUrl,
  parseReminderWeather,
  selectNotificationVariant
} from "../src/domain/notificationCopy.js";

const pick = (summary) => selectNotificationVariant(summary);
const calm = { currentTemp: 64, feelsLike: 64, lowFeelsLike: 58, highTemp: 70, precipitationProbability: 10, snowfall: 0, windMax: 8, weatherCode: 3 };

// --- one variant per condition ----------------------------------------------

assert.equal(pick(null), "generic");
assert.equal(pick({}), "generic");
assert.equal(pick(calm), "generic", "a mild overcast day has nothing worth bringing");

assert.equal(pick({ ...calm, precipitationProbability: 60 }), "rain");
assert.equal(pick({ ...calm, precipitationProbability: 44 }), "generic", "just under the rain threshold");
assert.equal(pick({ ...calm, snowfall: 0.4 }), "snow");
assert.equal(pick({ ...calm, snowfall: 0.03, weatherCode: 71, precipitationProbability: 20 }), "generic",
  "a coded dusting with a low chance is not a snow-boots day");
assert.equal(pick({ ...calm, weatherCode: 73, precipitationProbability: 50, lowFeelsLike: 30 }), "snow",
  "a confident snow forecast counts even before accumulation is known");
assert.equal(pick({ ...calm, lowFeelsLike: 28 }), "freezing");
assert.equal(pick({ ...calm, lowFeelsLike: 41 }), "cold");
assert.equal(pick({ ...calm, windMax: 27 }), "wind");
assert.equal(pick({ ...calm, currentTemp: 50, highTemp: 70 }), "layers");
assert.equal(pick({ ...calm, highTemp: 88, weatherCode: 0 }), "sun",
  "a cool morning on a hot sunny day is a sun day, not a layers day");
assert.equal(pick({ ...calm, currentTemp: 70, highTemp: 86, weatherCode: 3 }), "generic",
  "a big rise from a warm start is not a layers day — the copy says it starts cool");
assert.equal(pick({ ...calm, highTemp: 88, weatherCode: 2 }), "generic",
  "partly cloudy is not sun — the same rule the checklist uses");

// The reminder arrives in the morning, so the coldest feel of the day matters
// more than the reading at send time.
assert.equal(pick({ ...calm, feelsLike: 60, lowFeelsLike: 40 }), "cold");
assert.equal(pick({ ...calm, feelsLike: 40, lowFeelsLike: null }), "cold", "falls back to the current feel");

// --- priority: one reminder, one action ---------------------------------------

assert.equal(pick({ ...calm, snowfall: 2, precipitationProbability: 90, lowFeelsLike: 20, windMax: 30 }), "snow");
assert.equal(pick({ ...calm, precipitationProbability: 80, lowFeelsLike: 30, windMax: 30 }), "rain");
assert.equal(pick({ ...calm, lowFeelsLike: 25, windMax: 30 }), "freezing", "gloves imply the jacket");
assert.equal(pick({ ...calm, lowFeelsLike: 40, windMax: 30 }), "cold");
assert.equal(pick({ ...calm, windMax: 30, highTemp: 90, weatherCode: 0 }), "wind");

// --- the copy itself ------------------------------------------------------------

{
  const rain = buildNotificationCopy({ language: "en", weatherSummary: { ...calm, precipitationProbability: 70 } });

  assert.equal(rain.title, "☂️ You might want to bring an umbrella");
  assert.equal(rain.variant, "rain");
}

assert.equal(buildNotificationCopy({ language: "es", weatherSummary: { ...calm, precipitationProbability: 70 } }).title,
  "☂️ Quizás quieras llevar un paraguas");
assert.equal(buildNotificationCopy({ language: "en" }).title, "✅ Your checklist is ready");
assert.equal(buildNotificationCopy({ language: "fr" }).title, "✅ Your checklist is ready", "unknown language falls back to English");

// Every variant in both languages: an action in the title, no numbers, no
// leftover template placeholders.
const SAMPLES = {
  snow: { snowfall: 1 },
  rain: { precipitationProbability: 80 },
  freezing: { lowFeelsLike: 20 },
  cold: { lowFeelsLike: 40 },
  wind: { windMax: 30 },
  layers: { currentTemp: 50, highTemp: 70 },
  sun: { highTemp: 90, weatherCode: 0 },
  generic: {}
};

["en", "es"].forEach((language) => {
  Object.entries(SAMPLES).forEach(([expected, overrides]) => {
    const copy = buildNotificationCopy({ language, weatherSummary: { ...calm, ...overrides } });

    assert.equal(copy.variant, expected, `${language}/${expected}`);
    assert.ok(copy.title.length > 0 && copy.body.length > 0);
    assert.ok(!/[{}]/.test(copy.title + copy.body), `placeholder leaked: ${copy.title}`);
    assert.ok(!/\d+\s*%/.test(copy.title), `the title should name an item, not a likelihood: ${copy.title}`);

    if (expected !== "generic") {
      assert.ok(/might want|Quizás quieras/.test(copy.title), `${language}/${expected} should suggest something to bring`);
    }
  });
});

// --- the weather request and its parsing ------------------------------------

{
  const url = new URL(buildReminderWeatherUrl("https://api.open-meteo.com/v1/forecast", 42.37361, -71.10972));

  assert.equal(url.searchParams.get("latitude"), "42.4", "coordinates are rounded to ~11km before they leave");
  assert.equal(url.searchParams.get("longitude"), "-71.1");
  assert.equal(url.searchParams.get("wind_speed_unit"), "mph");
  assert.equal(url.searchParams.get("precipitation_unit"), "inch");
  ["apparent_temperature_min", "snowfall_sum", "wind_speed_10m_max", "weather_code"].forEach((field) => {
    assert.ok(url.searchParams.get("daily").includes(field), `daily should request ${field}`);
  });
}

{
  // Shape taken from a real Open-Meteo response.
  const parsed = parseReminderWeather({
    current: { temperature_2m: 67.7, apparent_temperature: 66.9 },
    daily: {
      temperature_2m_max: [74.5], apparent_temperature_min: [53.9], precipitation_probability_max: [37],
      snowfall_sum: [0], wind_speed_10m_max: [11.9], weather_code: [3]
    }
  });

  assert.deepEqual(parsed, {
    currentTemp: 67.7, feelsLike: 66.9, lowFeelsLike: 53.9, highTemp: 74.5,
    precipitationProbability: 37, snowfall: 0, windMax: 11.9, weatherCode: 3
  });
}

// A missing reading must stay missing. Number(null) is 0, and a 0F feels-like
// would send "gloves and a hat" on a mild day.
{
  const parsed = parseReminderWeather({ current: {}, daily: { apparent_temperature_min: [null] } });

  assert.equal(parsed.lowFeelsLike, null);
  assert.equal(pick(parsed), "generic");
}

assert.equal(pick(parseReminderWeather(null)), "generic", "a failed or empty response sends the generic reminder");

console.log("Notification copy examples passed.");
