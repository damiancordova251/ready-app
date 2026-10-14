// EXACT DUPLICATE of src/domain/notificationCopy.js — edit both together.
// Workers cannot import from outside their own directory, so this copy exists
// for the reminder-scheduler alone. Pure and dependency-free by design.

// Shared thresholds. Wind, cold and freezing match the in-app engine
// (domain/recommendation.js) so the reminder and the checklist agree.
const RAIN_PROBABILITY_THRESHOLD = 45;
const SNOW_MIN_INCHES = 0.1;
const SNOW_CODE_MIN_PROBABILITY = 40;
const FREEZING_FEELS_LIKE_F = 32;
const COLD_FEELS_LIKE_F = 45;
const WINDY_MPH = 24;
const LAYERS_TEMP_RISE_F = 15;
// The layers copy says "it starts cool". Below this the claim is true; above
// it, a big rise is just a hot day, which the sun variant covers.
const LAYERS_MAX_START_F = 60;
const HOT_HIGH_F = 82;

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
// Clear and mainly clear only; partly cloudy (2) is not sun. See the
// CLEAR_SKY_CODES note in domain/recommendation.js for the data behind this.
const CLEAR_CODES = new Set([0, 1]);

// Priority order: the first condition that applies wins, so each reminder
// carries exactly one action. Snow outranks rain because snow boots also cover
// wet ground; freezing outranks cold because gloves imply the jacket; sun
// outranks layers because nearly every hot day starts cooler, and "dress in
// layers" is the wrong advice on a day heading for 88F.
const VARIANT_ORDER = ["snow", "rain", "freezing", "cold", "wind", "sun", "layers"];

const COPY = {
  en: {
    snow: { title: "❄️ You might want snow boots today", body: "Snow is in the forecast. Open Ready for your full checklist." },
    rain: { title: "☂️ You might want to bring an umbrella", body: "Rain is in today's forecast. Open Ready for your full checklist." },
    freezing: { title: "🧤 You might want gloves and a hat today", body: "It'll feel below freezing. Open Ready for your full checklist." },
    cold: { title: "🧥 You might want a warm jacket today", body: "It'll feel cold out. Open Ready for your full checklist." },
    wind: { title: "💨 You might want a windbreaker today", body: "It's going to be windy. Open Ready for your full checklist." },
    layers: { title: "👕 You might want to dress in layers", body: "It starts cool and warms up later. Open Ready for your full checklist." },
    sun: { title: "🕶️ You might want sunglasses and water", body: "It's going to be hot and sunny. Open Ready for your full checklist." },
    generic: { title: "✅ Your checklist is ready", body: "Open Ready to see what to wear today." }
  },
  es: {
    snow: { title: "❄️ Quizás quieras botas de nieve hoy", body: "Se pronostica nieve. Abre Ready para ver tu lista completa." },
    rain: { title: "☂️ Quizás quieras llevar un paraguas", body: "Se pronostica lluvia hoy. Abre Ready para ver tu lista completa." },
    freezing: { title: "🧤 Quizás quieras guantes y gorro hoy", body: "Se sentirá bajo cero. Abre Ready para ver tu lista completa." },
    cold: { title: "🧥 Quizás quieras una chaqueta abrigada hoy", body: "Se sentirá frío. Abre Ready para ver tu lista completa." },
    wind: { title: "💨 Quizás quieras un cortavientos hoy", body: "Va a hacer viento. Abre Ready para ver tu lista completa." },
    layers: { title: "👕 Quizás quieras vestirte en capas", body: "Empieza fresco y luego sube la temperatura. Abre Ready para ver tu lista completa." },
    sun: { title: "🕶️ Quizás quieras gafas de sol y agua", body: "Va a hacer calor y sol. Abre Ready para ver tu lista completa." },
    generic: { title: "✅ Tu lista está lista", body: "Abre Ready para ver qué ponerte hoy." }
  }
};

// weatherSummary is deliberately small and coarse — never a location, never
// the full forecast. Every field is optional; a missing one simply cannot
// trigger its variant:
// { currentTemp, feelsLike, lowFeelsLike, highTemp, precipitationProbability,
//   snowfall, windMax, weatherCode }
const RULES = {
  snow: (w) => (isNumber(w.snowfall) && w.snowfall >= SNOW_MIN_INCHES)
    || (SNOW_CODES.has(w.weatherCode) && isNumber(w.precipitationProbability) && w.precipitationProbability >= SNOW_CODE_MIN_PROBABILITY),
  rain: (w) => isNumber(w.precipitationProbability) && w.precipitationProbability >= RAIN_PROBABILITY_THRESHOLD,
  freezing: (w) => isNumber(coldestFeel(w)) && coldestFeel(w) <= FREEZING_FEELS_LIKE_F,
  cold: (w) => isNumber(coldestFeel(w)) && coldestFeel(w) <= COLD_FEELS_LIKE_F,
  wind: (w) => isNumber(w.windMax) && w.windMax >= WINDY_MPH,
  layers: (w) => isNumber(w.currentTemp) && isNumber(w.highTemp)
    && w.currentTemp <= LAYERS_MAX_START_F
    && (w.highTemp - w.currentTemp) >= LAYERS_TEMP_RISE_F,
  sun: (w) => isNumber(w.highTemp) && w.highTemp >= HOT_HIGH_F && CLEAR_CODES.has(w.weatherCode)
};

export function selectNotificationVariant(weatherSummary) {
  if (!weatherSummary || typeof weatherSummary !== "object") {
    return "generic";
  }

  return VARIANT_ORDER.find((variant) => RULES[variant](weatherSummary)) ?? "generic";
}

// language should be the subscription's saved preferred_language ("en"/"es");
// anything unrecognized falls back to English so a bad or legacy value never
// breaks a send.
export function buildNotificationCopy({ language = "en", weatherSummary = null } = {}) {
  const dictionary = COPY[language] ?? COPY.en;
  const variant = selectNotificationVariant(weatherSummary);

  return {
    title: dictionary[variant].title,
    body: dictionary[variant].body,
    variant
  };
}

// The one Open-Meteo request both reminder senders make. Coordinates arrive
// already coarse (~11km) and are rounded again here, so a precise location can
// never leave through this path even if a caller passes one.
export function buildReminderWeatherUrl(baseUrl, latitude, longitude) {
  const url = new URL(baseUrl);

  url.search = new URLSearchParams({
    latitude: latitude.toFixed(1),
    longitude: longitude.toFixed(1),
    current: "temperature_2m,apparent_temperature",
    daily: "temperature_2m_max,apparent_temperature_min,precipitation_probability_max,snowfall_sum,wind_speed_10m_max,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: "1"
  }).toString();

  return url.toString();
}

export function parseReminderWeather(data) {
  return {
    currentTemp: toNumber(data?.current?.temperature_2m),
    feelsLike: toNumber(data?.current?.apparent_temperature),
    lowFeelsLike: toNumber(data?.daily?.apparent_temperature_min?.[0]),
    highTemp: toNumber(data?.daily?.temperature_2m_max?.[0]),
    precipitationProbability: toNumber(data?.daily?.precipitation_probability_max?.[0]),
    snowfall: toNumber(data?.daily?.snowfall_sum?.[0]),
    windMax: toNumber(data?.daily?.wind_speed_10m_max?.[0]),
    weatherCode: toNumber(data?.daily?.weather_code?.[0])
  };
}

// The coldest the day will feel. Prefers the daily minimum, because the
// reminder arrives in the morning and the current reading can be the warmest
// moment someone will see before heading out into an evening that is not.
function coldestFeel(w) {
  const values = [w.lowFeelsLike, w.feelsLike].filter(isNumber);

  return values.length > 0 ? Math.min(...values) : null;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Guards null/undefined before coercing: Number(null) is 0, which would turn a
// missing reading into a real 0F and fire the freezing variant.
function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}
