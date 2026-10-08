// Generates bilingual, weather-aware scheduled-reminder copy. Pure and
// dependency-free by design (no Node built-ins, no Supabase/network calls) so
// the exact same file can be duplicated into
// workers/reminder-scheduler/src/, matching the project's existing
// server/functions duplication convention.
//
// Deliberately NOT the full recommendation engine: it surfaces the single most
// notable condition plus the one item that condition calls for. Phrased with
// "may"/"likely" rather than certainty, per the requirement to avoid alarming
// or overly certain wording.
//
// The title carries the condition and the body carries the action, because
// phones truncate the body long before the title — the weather is the part
// that must survive truncation.
const RAIN_PROBABILITY_THRESHOLD = 45;
const COLD_FEELS_LIKE_F = 45;
const WARM_TEMP_RISE_F = 15;

const COPY = {
  en: {
    rain: {
      title: "🌧️ {percent}% chance of rain today",
      body: "Bring an umbrella — open Ready for your full checklist."
    },
    cold: {
      title: "🧥 Feels like {temp}° out there",
      body: "Bring a warm layer — open Ready for your full checklist."
    },
    warm: {
      title: "☀️ Warming up to {temp}° later",
      body: "Dress light — open Ready for your full checklist."
    },
    generic: {
      title: "✅ Your checklist is ready",
      body: "Open Ready to see what to wear today."
    }
  },
  es: {
    rain: {
      title: "🌧️ {percent}% de probabilidad de lluvia hoy",
      body: "Lleva un paraguas — abre Ready para ver tu lista completa."
    },
    cold: {
      title: "🧥 Se siente como {temp}° afuera",
      body: "Lleva una capa abrigada — abre Ready para ver tu lista completa."
    },
    warm: {
      title: "☀️ Subirá a {temp}° más tarde",
      body: "Vístete ligero — abre Ready para ver tu lista completa."
    },
    generic: {
      title: "✅ Tu lista está lista",
      body: "Abre Ready para ver qué ponerte hoy."
    }
  }
};

// weatherSummary is intentionally a small, coarse shape — never exact
// location, never the full forecast — just what's needed to pick one variant:
// { precipitationProbability, feelsLike, currentTemp, highTemp }
export function selectNotificationVariant(weatherSummary) {
  if (!weatherSummary) {
    return "generic";
  }

  const { precipitationProbability, feelsLike, currentTemp, highTemp } = weatherSummary;

  if (Number.isFinite(precipitationProbability) && precipitationProbability >= RAIN_PROBABILITY_THRESHOLD) {
    return "rain";
  }

  if (Number.isFinite(feelsLike) && feelsLike <= COLD_FEELS_LIKE_F) {
    return "cold";
  }

  if (Number.isFinite(currentTemp) && Number.isFinite(highTemp) && (highTemp - currentTemp) >= WARM_TEMP_RISE_F) {
    return "warm";
  }

  return "generic";
}

// language should be the subscription's saved preferred_language ("en"/"es");
// falls back to English for anything unrecognized so a bad/legacy value never
// breaks a send.
export function buildNotificationCopy({ language = "en", weatherSummary = null } = {}) {
  const dictionary = COPY[language] ?? COPY.en;
  const variant = selectNotificationVariant(weatherSummary);
  const entry = dictionary[variant];
  const values = getTemplateValues(variant, weatherSummary);

  // A variant is only chosen when its own numbers are finite, so a template
  // placeholder can never survive into a sent notification. Falling back to
  // generic rather than shipping a literal "{temp}" is still worth the guard.
  if (!values) {
    return {
      title: dictionary.generic.title,
      body: dictionary.generic.body,
      variant: "generic"
    };
  }

  return {
    title: fill(entry.title, values),
    body: entry.body,
    variant
  };
}

function getTemplateValues(variant, weatherSummary) {
  if (variant === "generic") {
    return {};
  }

  if (variant === "rain") {
    return { percent: Math.round(weatherSummary.precipitationProbability) };
  }

  if (variant === "cold") {
    return { temp: Math.round(weatherSummary.feelsLike) };
  }

  if (variant === "warm") {
    return { temp: Math.round(weatherSummary.highTemp) };
  }

  return null;
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    key in values ? String(values[key]) : match
  ));
}
