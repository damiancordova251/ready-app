import { getLocale } from "../i18n/i18n.js";

// City lookup for people who can't or won't use GPS — most often because the
// link was opened inside an app's in-app browser, where geolocation is
// frequently blocked, or because location permission was denied once and iOS
// stops prompting.
//
// Uses Open-Meteo's geocoding API: free, no key, same provider already used
// for forecasts, so this adds no new third party.
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const RESULT_LIMIT = 5;
const MIN_QUERY_LENGTH = 2;

export class CitySearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CitySearchError";
    this.code = code;
  }
}

// Returns up to five matches, each already shaped like the location objects
// the rest of the app passes around, so a chosen city flows through weather
// fetching and reminder storage exactly like a GPS fix would.
export async function searchCities(query) {
  const trimmed = String(query ?? "").trim();

  if (trimmed.length < MIN_QUERY_LENGTH) {
    throw new CitySearchError("TOO_SHORT", "Enter at least two characters.");
  }

  const url = new URL(GEOCODING_URL);

  url.search = new URLSearchParams({
    name: trimmed,
    count: String(RESULT_LIMIT),
    language: getLocale(),
    format: "json"
  }).toString();

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new CitySearchError("NETWORK", "City search is unavailable right now.");
  }

  if (!response.ok) {
    throw new CitySearchError("NETWORK", "City search is unavailable right now.");
  }

  const data = await response.json().catch(() => ({}));
  const results = Array.isArray(data.results) ? data.results : [];

  return results
    .filter((result) => Number.isFinite(result.latitude) && Number.isFinite(result.longitude))
    .map((result) => ({
      id: result.id,
      name: result.name,
      label: buildLabel(result),
      latitude: result.latitude,
      longitude: result.longitude,
      // A city centroid is nothing like a GPS fix, so accuracy stays null
      // rather than implying a precision this does not have.
      accuracy: null
    }));
}

// "Quito, Pichincha, Ecuador" — region included because city names repeat
// across countries and the user needs to tell them apart.
function buildLabel(result) {
  return [result.name, result.admin1, result.country]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(", ");
}
