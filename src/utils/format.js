import { getLocale, t } from "../i18n/i18n.js";

// Shared formatting helpers used across recommendation output, checklist
// rendering, and weather details so every feature module formats numbers and
// times the same way instead of each defining its own copy.
export function bestNumber(...values) {
  return values.find((value) => Number.isFinite(value)) ?? 0;
}

export function formatTemp(value) {
  return `${Math.round(value)}°F`;
}

// Locale-aware: uses the app's selected language (not just the browser's own
// locale, which can differ from what the user picked in Settings).
export function formatTime(value) {
  return new Intl.DateTimeFormat(getLocale(), {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatTimeLabel(minutes) {
  const date = new Date();
  date.setHours(0, minutes, 0, 0);

  return new Intl.DateTimeFormat(getLocale(), {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatHourLabel(hours) {
  return t(hours === 1 ? "checklist.hourSingular" : "checklist.hourPlural", { n: hours });
}

const WEATHER_CODE_KEYS = {
  0: "clear",
  1: "mostlyClear",
  2: "partlyCloudy",
  3: "cloudy",
  45: "fog",
  48: "fog",
  51: "lightDrizzle",
  53: "drizzle",
  55: "heavyDrizzle",
  56: "freezingDrizzle",
  57: "freezingDrizzle",
  61: "lightRain",
  63: "rain",
  65: "heavyRain",
  66: "freezingRain",
  67: "freezingRain",
  71: "lightSnow",
  73: "snow",
  75: "heavySnow",
  77: "snowGrains",
  80: "rainShowers",
  81: "rainShowers",
  82: "heavyShowers",
  85: "snowShowers",
  86: "heavySnowShowers",
  95: "thunderstorm",
  96: "thunderstormHail",
  99: "thunderstormHail"
};

export function formatWeatherCode(code) {
  const key = WEATHER_CODE_KEYS[code];

  return key ? t(`weatherCode.${key}`) : t("weatherCode.unavailable");
}

// Emoji for the same Open-Meteo codes above, so the headline condition reads
// at a glance. Grouped rather than one-per-code: the distinction between
// drizzle and light rain does not need two different pictures.
const WEATHER_CODE_EMOJI = {
  clear: "☀️",
  mostlyClear: "🌤️",
  partlyCloudy: "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  lightDrizzle: "🌦️",
  drizzle: "🌦️",
  heavyDrizzle: "🌧️",
  freezingDrizzle: "🌨️",
  lightRain: "🌦️",
  rain: "🌧️",
  heavyRain: "🌧️",
  freezingRain: "🌨️",
  lightSnow: "🌨️",
  snow: "❄️",
  heavySnow: "❄️",
  snowGrains: "🌨️",
  rainShowers: "🌦️",
  heavyShowers: "🌧️",
  snowShowers: "🌨️",
  heavySnowShowers: "❄️",
  thunderstorm: "⛈️",
  thunderstormHail: "⛈️"
};

export function formatWeatherEmoji(code) {
  const key = WEATHER_CODE_KEYS[code];

  return (key && WEATHER_CODE_EMOJI[key]) || "🌡️";
}
