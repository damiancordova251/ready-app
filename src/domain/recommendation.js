import { bestNumber, formatTemp } from "../utils/format.js";

// Weather code groups and thresholds define the checklist rules. Keeping them
// here makes it easier to tune recommendations without hunting through UI code.
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
// Codes 0 (clear) and 1 (mainly clear) only. WMO code 2 is "partly cloudy",
// and it used to live here — which is why sunglasses showed up on grey days.
// The forecast-accuracy data collected in production settled it: of 15 samples
// where code 2 was predicted, the observed condition was overcast 100% of the
// time and clear exactly zero times. Codes 0/1 verified clear 77% of the time.
const CLEAR_SKY_CODES = new Set([0, 1]);
// WMO 2 is counted as neither clear nor cloudy. Dropping it from "clear" is
// well supported; also calling it "cloudy" would push every partly-cloudy day
// toward heavier clothing, and 15 samples from two locations is nowhere near
// enough to justify a change that broad. Neutral until the data says more.
const PARTLY_CLOUDY_CODE = 2;
const FREEZING_PRECIP_CODES = new Set([56, 57, 66, 67]);
const READY_CHECKLIST_TITLE = "Ready Checklist:";
const DEFAULT_FORECAST_WINDOW_HOURS = 12;
const DAYLIGHT_START_HOUR = 6;
const DAYLIGHT_END_HOUR = 20;
const MAX_CHECKLIST_ITEMS = 6;
const RAIN_PROBABILITY_THRESHOLD = 40;
const LONG_RAIN_WINDOW_HOURS = 9;
const LONG_WINDOW_RAIN_PROBABILITY_THRESHOLD = 35;
const MEASURABLE_RAIN_INCHES = 0.01;
const MEANINGFUL_RAIN_PROBABILITY = 60;
const MEANINGFUL_PRECIPITATION_INCHES = 0.03;
const HEAVY_RAIN_INCHES = 0.06;
const SUSTAINED_RAIN_HOURS = 2;
const SUSTAINED_RAIN_PROBABILITY = 50;
const HEAVY_RAIN_CODES = new Set([63, 65, 80, 81, 82, 95, 96, 99]);
const VERY_COLD_TEMP = 32;
const COLD_TEMP = 45;
const COOL_TEMP = 58;
const SWEATSHIRT_TEMP = 66;
const WINDY_MPH = 24;
const COLD_WIND_MPH = 18;
const HOT_TEMP = 86;
const CLOTHING_WEIGHT_LABELS = ["", "Light", "Light-Medium", "Medium", "Medium-Heavy", "Heavy"];
const TOP_CLOTHING_WEIGHTS = new Map([
  ["Tank Top", 1],
  ["T-shirt", 1],
  ["Polo Shirt", 1],
  ["Button-Up Shirt", 2],
  ["Light Long-Sleeve", 2],
  ["Sweater", 3],
  ["Hoodie", 3],
  ["Light Jacket", 4],
  ["Heavy Coat", 5],
  ["Thermal Layer", 5]
]);
const BOTTOM_CLOTHING_WEIGHTS = new Map([
  ["Shorts", 1],
  ["Skirt", 1],
  ["Cargo Pants", 1],
  ["Jeans", 2],
  ["Pants", 3],
  ["Joggers", 4],
  ["Sweatpants", 4],
  ["Thermal Pants", 5]
]);

// Selects the forecast hours that match how long the user expects to be away
// from home, falling back to the nearest hour when no hourly data is available.
export function getNextForecastWindow(weather, now = new Date(), durationHours = DEFAULT_FORECAST_WINDOW_HOURS) {
  const hourly = Array.isArray(weather.hourly) ? weather.hourly : [];
  const normalizedDurationHours = normalizeForecastWindowHours(durationHours);
  const start = new Date(now);
  const end = new Date(start);

  end.setHours(end.getHours() + normalizedDurationHours);

  const hours = hourly.filter((hour) => isWithinWindow(hour, start, end));
  const representativeHour = findNearestHour(hourly, start);

  return {
    title: READY_CHECKLIST_TITLE,
    start,
    end,
    durationHours: normalizedDurationHours,
    hours,
    representativeHour,
    usableHours: hours.length > 0 ? hours : [representativeHour].filter(Boolean),
    containsDaylight: hasDaylightHours(hours)
  };
}

// Summarizes the selected hourly window into a weather object shaped like the
// original forecast, so the recommendation rules can stay simple.
export function buildWindowWeather(weather, forecastWindow) {
  const windowHours = forecastWindow.usableHours ?? [];
  const representative = forecastWindow.representativeHour ?? weather.current ?? {};

  if (windowHours.length === 0) {
    return {
      ...weather,
      checklistTitle: READY_CHECKLIST_TITLE,
      checklistWindow: forecastWindow
    };
  }

  return {
    ...weather,
    checklistTitle: READY_CHECKLIST_TITLE,
    checklistWindow: forecastWindow,
    current: {
      ...weather.current,
      time: representative.time ?? weather.current.time,
      temperature: bestNumber(representative.temperature, weather.current.temperature),
      feelsLike: bestNumber(representative.feelsLike, weather.current.feelsLike, weather.current.temperature),
      precipitation: maxFromHours(windowHours, "precipitation", weather.current.precipitation),
      rain: maxFromHours(windowHours, "rain", weather.current.rain),
      showers: maxFromHours(windowHours, "showers", weather.current.showers),
      snowfall: maxFromHours(windowHours, "snowfall", weather.current.snowfall),
      weatherCode: bestNumber(representative.weatherCode, weather.current.weatherCode),
      windSpeed: bestNumber(representative.windSpeed, weather.current.windSpeed)
    },
    daily: {
      ...weather.daily,
      weatherCode: getWindowWeatherCode(windowHours, bestNumber(representative.weatherCode, weather.daily.weatherCode)),
      high: maxFromHours(windowHours, "temperature", weather.daily.high),
      low: minFromHours(windowHours, "temperature", weather.daily.low),
      precipitationProbability: maxFromHours(windowHours, "precipitationProbability", weather.daily.precipitationProbability),
      windMax: maxFromHours(windowHours, "windSpeed", weather.daily.windMax)
    }
  };
}

// Converts summarized weather conditions into checklist items. Clothing is
// built from eligible top and bottom options first, then conditional accessories
// are added for weather-specific needs.
//
// Items and reasons are returned as structured, translatable descriptors
// rather than pre-formatted English sentences: `items` entries are
// `{ type: "clothingGroup", category, weightLabel, options }` or
// `{ type: "accessory", options }`, and `reasons` entries are
// `{ key, params }`. The UI layer (features/checklist/checklist.js) is
// responsible for translating and composing the final display strings via
// src/i18n. This keeps the recommendation engine itself language-agnostic
// instead of baking English copy into its output.
export function createRecommendation(windowWeather) {
  const features = getWindowFeatures(windowWeather);
  const topOptions = selectClothingOptions(
    getEligibleTopOptions(features),
    getFallbackTopOptions(features),
    features,
    TOP_CLOTHING_WEIGHTS
  );
  const bottomOptions = selectClothingOptions(
    getEligibleBottomOptions(features),
    getFallbackBottomOptions(features),
    features,
    BOTTOM_CLOTHING_WEIGHTS
  );
  const accessories = getAccessoryActions(features);
  const actions = [
    {
      type: "clothingGroup",
      category: "Top",
      weightLabel: getClothingWeightLabel(topOptions, TOP_CLOTHING_WEIGHTS),
      options: topOptions,
      priority: 200
    },
    {
      type: "clothingGroup",
      category: "Bottom",
      weightLabel: getClothingWeightLabel(bottomOptions, BOTTOM_CLOTHING_WEIGHTS),
      options: bottomOptions,
      priority: 190
    },
    ...accessories
  ];
  const items = actions.slice(0, MAX_CHECKLIST_ITEMS);

  return {
    reasons: buildReasons(features.reasons, features.durationHours),
    items,
    weatherNeeds: createWeatherNeeds(features)
  };
}

function getWindowFeatures(weather) {
  const durationHours = weather.checklistWindow?.durationHours ?? DEFAULT_FORECAST_WINDOW_HOURS;
  const hours = weather.checklistWindow?.usableHours ?? [];
  const feelsLike = bestNumber(weather.current.feelsLike, weather.current.temperature, weather.daily.high);
  const currentTemp = bestNumber(weather.current.temperature, weather.daily.high, feelsLike);
  const high = bestNumber(weather.daily.high, currentTemp);
  const low = bestNumber(weather.daily.low, feelsLike);
  const maxTemp = maxFromHours(hours, "temperature", high);
  const minTemp = minFromHours(hours, "temperature", low);
  const maxFeels = maxFromHours(hours, "feelsLike", Math.max(feelsLike, high));
  const minFeels = minFromHours(hours, "feelsLike", Math.min(feelsLike, low));
  const wind = Math.max(
    bestNumber(weather.current.windSpeed, 0),
    bestNumber(weather.daily.windMax, 0),
    maxFromHours(hours, "windSpeed", 0)
  );
  const rainProfile = getRainProfile(weather, durationHours);
  const precipProbability = rainProfile.maxProbability;
  const currentCode = weather.current.weatherCode;
  const dailyCode = weather.daily.weatherCode;
  const snowAmount = Math.max(
    bestNumber(weather.current.snowfall, 0),
    maxFromHours(hours, "snowfall", 0)
  );
  const snowRisk = snowAmount > 0
    || hasCode(SNOW_CODES, currentCode, dailyCode)
    || hours.some((hour) => hasCode(SNOW_CODES, hour.weatherCode));
  const freezingPrecipRisk = hasCode(FREEZING_PRECIP_CODES, currentCode, dailyCode)
    || hours.some((hour) => hasCode(FREEZING_PRECIP_CODES, hour.weatherCode))
    || (rainProfile.umbrellaRisk && minFeels <= 34);
  const winterPrecipRisk = snowRisk || freezingPrecipRisk;
  const veryCold = minFeels <= VERY_COLD_TEMP || low <= VERY_COLD_TEMP;
  const cold = minFeels <= COLD_TEMP || low <= COLD_TEMP - 3;
  const cool = minFeels <= COOL_TEMP || low <= COOL_TEMP - 4;
  const coldWind = cold && wind >= COLD_WIND_MPH;
  const windy = wind >= WINDY_MPH || coldWind;
  const daylightHours = getDaylightHours(hours);
  const hot = high >= HOT_TEMP || maxFeels >= HOT_TEMP - 4;
  const cloudy = hours.some(isCloudyHour) || isCloudyCode(currentCode) || isCloudyCode(dailyCode);
  const temperatureRange = Math.max(high, maxTemp) - Math.min(low, minTemp);
  const daylightSunny = hasMeaningfulSun(daylightHours);
  const sunProtection = daylightSunny && !rainProfile.umbrellaRisk && !winterPrecipRisk;
  const reasons = [];

  if (winterPrecipRisk) {
    reasons.push(snowRisk ? { key: "reason.snowLikely" } : { key: "reason.freezingPrecip" });
  } else if (rainProfile.umbrellaRisk) {
    reasons.push(getRainReason(precipProbability, durationHours));
  }

  if (veryCold) {
    reasons.push({ key: "reason.feelsLikeColdest", params: { temp: formatTemp(minFeels) } });
  } else if (cool && !rainProfile.umbrellaRisk) {
    reasons.push({ key: "reason.mayFeelCool", params: { temp: formatTemp(minFeels) } });
  }

  if (windy) {
    reasons.push({ key: "reason.windMayReach", params: { mph: Math.round(wind) } });
  }

  return {
    durationHours,
    feelsLike,
    currentTemp,
    high: Math.max(high, maxTemp),
    low: Math.min(low, minTemp),
    maxTemp,
    minTemp,
    maxFeels,
    minFeels,
    wind,
    precipProbability,
    rainProfile,
    rainRisk: rainProfile.umbrellaRisk,
    snowRisk,
    freezingPrecipRisk,
    winterPrecipRisk,
    veryCold,
    cold,
    cool,
    coldWind,
    windy,
    daylightSunny,
    hot,
    cloudy,
    temperatureRange,
    sunProtection,
    reasons
  };
}

// Wind strips away warmth the thermometer never shows, and overcast skies mean
// the forecast high is rarely reached. Both make the lightest tops a worse call
// than the number alone suggests, so they lose ground to a layer instead of
// tying with one.
//
// Without this, a 70F windy day scored T-shirt and Light Long-Sleeve at exactly
// 98 apiece, and the tie fell to whichever was added first — the T-shirt. That
// is the "why am I being told to wear a t-shirt on a windy day" case.
const WIND_EXPOSURE_PENALTY = 16;
const CLOUD_EXPOSURE_PENALTY = 8;

// Above this, wind and cloud stop arguing for more clothing. A 26mph breeze at
// 92F is relief, not a chill, and overcast skies at 85F still leave a t-shirt
// day. Without this bound the exposure rules recommended a long-sleeve at 92F.
const EXPOSURE_RELEVANT_MAX_FEELS = 72;

// Below this, a light long-sleeve is no longer the right answer to cold — a
// sweater is. The boost used to apply at any temperature, which made an
// overcast 45F day recommend a *lighter* top than a partly cloudy one.
const LIGHT_LAYER_MIN_FEELS = 63;

function isExposureRelevant(features) {
  return features.maxFeels <= EXPOSURE_RELEVANT_MAX_FEELS;
}

function getExposurePenalty(features) {
  if (!isExposureRelevant(features)) {
    return 0;
  }

  if (features.windy) {
    return WIND_EXPOSURE_PENALTY;
  }

  return features.cloudy ? CLOUD_EXPOSURE_PENALTY : 0;
}

function getEligibleTopOptions(features) {
  const options = [];
  const dryEnoughForLightTops = !features.rainRisk && !features.winterPrecipRisk;
  const coldWetOrWindy = (features.rainRisk || features.windy || features.cloudy)
    && isExposureRelevant(features);
  const mildRange = features.maxFeels >= 55 && features.minFeels <= 72;
  const exposurePenalty = getExposurePenalty(features);

  if (features.winterPrecipRisk || features.minFeels <= 35) {
    addOption(options, "Thermal Layer", 120);
    addOption(options, "Heavy Coat", 116);
    return options;
  }

  if (features.maxFeels >= 78 && dryEnoughForLightTops && !features.coldWind) {
    addOption(options, "Tank Top", 86 + Math.min(features.maxFeels - 78, 8) - exposurePenalty);
  }

  if (features.maxFeels >= 62 && features.minFeels >= 54 && !features.coldWind && !features.winterPrecipRisk) {
    const score = features.maxFeels >= 68 ? 98 : 88;

    addOption(options, "T-shirt", score - exposurePenalty);
  }

  if (features.maxFeels >= 60 && features.minFeels >= 52 && !features.winterPrecipRisk) {
    addOption(options, "Polo Shirt", (features.maxFeels >= 68 ? 94 : 86) - exposurePenalty);
  }

  if (mildRange || features.cloudy || features.windy || features.temperatureRange >= 10) {
    addOption(
      options,
      "Light Long-Sleeve",
      coldWetOrWindy && features.maxFeels >= LIGHT_LAYER_MIN_FEELS ? 98 : 82
    );
  }

  if (features.maxFeels >= 58 && features.maxFeels <= 78 && features.minFeels >= 52 && !features.winterPrecipRisk) {
    addOption(options, "Button-Up Shirt", features.temperatureRange >= 10 || features.cloudy ? 76 : 72);
  }

  if (features.minFeels <= 62 || (features.maxFeels <= 66 && (features.cloudy || features.windy))) {
    addOption(options, "Sweater", features.minFeels <= 58 || coldWetOrWindy ? 94 : 80);
    addOption(options, "Hoodie", features.minFeels <= 55 || features.windy ? 90 : 78);
  }

  if (features.minFeels <= 60 || features.low <= 58 || (features.rainRisk && features.maxFeels <= 72) || features.coldWind) {
    addOption(options, "Light Jacket", features.rainRisk || features.windy || features.minFeels <= 52 ? 92 : 84);
  }

  if (features.minFeels <= 38 || features.low <= 38 || (features.minFeels <= 42 && (features.coldWind || features.rainRisk))) {
    addOption(options, "Heavy Coat", 104);
  }

  return options;
}

function getEligibleBottomOptions(features) {
  const options = [];
  const dryWarmEnough = !features.winterPrecipRisk && !features.rainRisk;
  const shortsBridgeWeather = features.maxFeels >= 65
    && features.maxFeels <= 72
    && features.daylightSunny
    && !features.windy
    && dryWarmEnough
    && features.minFeels >= 58;

  if (features.winterPrecipRisk || features.minFeels <= 35) {
    addOption(options, "Thermal Pants", 120);
    addOption(options, "Sweatpants", 112);
    return options;
  }

  if ((features.maxFeels >= 70 && dryWarmEnough && features.minFeels >= 60) || shortsBridgeWeather) {
    addOption(options, "Shorts", features.maxFeels >= 75 ? 98 : 92);
  }

  if (features.maxFeels >= 72 && dryWarmEnough && features.minFeels >= 60) {
    addOption(options, "Skirt", features.maxFeels >= 78 ? 94 : 86);
  }

  if (features.maxFeels >= 55 && features.maxFeels <= 80 && features.minFeels >= 45 && !features.winterPrecipRisk) {
    addOption(options, "Cargo Pants", features.maxFeels >= 64 ? 90 : 88);
  }

  if (features.maxFeels >= 45 && features.maxFeels <= 74 && !features.winterPrecipRisk) {
    addOption(options, "Jeans", features.maxFeels >= 55 ? 88 : 84);
    addOption(options, "Pants", features.maxFeels <= 52 ? 96 : 86);
  }

  if (features.minFeels <= 62 || (features.cloudy && features.maxFeels <= 66)) {
    addOption(options, "Joggers", features.minFeels <= 52 ? 92 : 78);
  }

  if (features.minFeels <= 55 || features.coldWind) {
    addOption(options, "Sweatpants", features.minFeels <= 45 || features.coldWind ? 88 : 82);
  }

  if (features.minFeels <= 38 || features.low <= 38) {
    addOption(options, "Thermal Pants", 104);
  }

  return options;
}

function getAccessoryActions(features) {
  const accessories = [];

  if (features.rainRisk && !features.winterPrecipRisk) {
    accessories.push({ type: "accessory", options: ["Umbrella", "Rain Jacket"], priority: 80 });
  }

  if (features.sunProtection) {
    // Ranked below the cold-weather accessories: on a clear 25F morning,
    // gloves and a beanie matter more than glare, and sun protection used to
    // head the list on exactly those days.
    accessories.push({ type: "accessory", options: ["Sunglasses", "Hat"], priority: 62 });
  }

  if (features.minFeels <= 40 || (features.windy && features.minFeels <= 45)) {
    accessories.push({ type: "accessory", options: ["Beanie"], priority: 66 });
  }

  if (features.minFeels <= 38 || (features.windy && features.minFeels <= 42)) {
    accessories.push({ type: "accessory", options: ["Gloves"], priority: 65 });
  }

  if (features.minFeels <= 36 || (features.coldWind && features.minFeels <= 40)) {
    accessories.push({ type: "accessory", options: ["Scarf"], priority: 64 });
  }

  if (features.winterPrecipRisk) {
    accessories.push({ type: "accessory", options: ["Winter shoes", "Snow boots"], priority: 63 });
  }

  return accessories.sort((a, b) => b.priority - a.priority);
}

function selectClothingOptions(candidates, fallbackOptions, features, weightMap) {
  // Ties break toward the warmer garment. Equal scores used to be settled by
  // whichever option happened to be added first, which is arbitrary — and the
  // two mistakes are not equally bad. Being underdressed is uncomfortable for
  // the whole time you are out; being slightly overdressed means carrying a
  // layer. The forecast-accuracy data backs this up too: day-ahead forecasts
  // ran 4.6F warmer than observed, so the error already leans toward
  // under-dressing people.
  const ranked = dedupeOptions([...candidates, ...fallbackOptions])
    .sort((a, b) => (
      b.score - a.score
      || getClothingWeight(b.item, weightMap) - getClothingWeight(a.item, weightMap)
    ));
  const preferredCount = features.winterPrecipRisk || features.minFeels <= 35 ? 2 : 3;
  const selected = [];

  ranked.forEach((option) => {
    const nextOptions = [...selected.map((selectedOption) => selectedOption.item), option.item];

    if (selected.length < preferredCount && hasReasonableWeightSpread(nextOptions, weightMap)) {
      selected.push(option);
    }
  });

  if (selected.length === 0 && ranked.length > 0) {
    selected.push(ranked[0]);
  }

  return selected.map((option) => option.item);
}

function getFallbackTopOptions(features) {
  if (features.winterPrecipRisk || features.minFeels <= 35) {
    return [
      { item: "Thermal Layer", score: 80 },
      { item: "Heavy Coat", score: 78 }
    ];
  }

  if (features.maxFeels >= 75) {
    return [
      { item: "T-shirt", score: 70 },
      { item: "Polo Shirt", score: 68 }
    ];
  }

  if (features.maxFeels >= 60) {
    return [
      { item: "T-shirt", score: 70 },
      { item: "Polo Shirt", score: 68 },
      { item: "Light Long-Sleeve", score: 66 }
    ];
  }

  if (features.maxFeels >= 48) {
    return [
      { item: "Light Long-Sleeve", score: 70 },
      { item: "Sweater", score: 68 },
      { item: "Light Jacket", score: 66 }
    ];
  }

  return [
    { item: "Sweater", score: 70 },
    { item: "Hoodie", score: 68 },
    { item: "Light Jacket", score: 66 }
  ];
}

function getFallbackBottomOptions(features) {
  if (features.winterPrecipRisk || features.minFeels <= 35) {
    return [
      { item: "Thermal Pants", score: 80 },
      { item: "Sweatpants", score: 78 }
    ];
  }

  if (features.maxFeels >= 72 && !features.rainRisk) {
    return [
      { item: "Shorts", score: 70 },
      { item: "Cargo Pants", score: 68 },
      { item: "Jeans", score: 66 }
    ];
  }

  if (features.maxFeels >= 55) {
    return [
      { item: "Cargo Pants", score: 70 },
      { item: "Jeans", score: 68 },
      { item: "Pants", score: 66 }
    ];
  }

  return [
    { item: "Pants", score: 70 },
    { item: "Joggers", score: 68 },
    { item: "Sweatpants", score: 66 }
  ];
}

function addOption(options, item, score) {
  options.push({ item, score });
}

function dedupeOptions(options) {
  const bestOptions = new Map();

  options.forEach((option) => {
    const current = bestOptions.get(option.item);

    if (!current || option.score > current.score) {
      bestOptions.set(option.item, option);
    }
  });

  return [...bestOptions.values()];
}

function getClothingWeightLabel(options, weightMap) {
  const maxWeight = Math.max(...options.map((option) => getClothingWeight(option, weightMap)));

  return CLOTHING_WEIGHT_LABELS[maxWeight] ?? "Medium";
}

function hasReasonableWeightSpread(options, weightMap) {
  const weights = options.map((option) => getClothingWeight(option, weightMap));

  return Math.max(...weights) - Math.min(...weights) <= 2;
}

function getClothingWeight(option, weightMap) {
  return weightMap.get(option) ?? 3;
}

// Structured needs let personalization map the same weather judgment to saved
// local clothing preferences while keeping the generic checklist text intact.
function createWeatherNeeds(features) {
  const snow = features.winterPrecipRisk;
  const rain = features.rainRisk && !snow;
  const sun = features.daylightSunny && !snow;
  const cold = features.cold || features.veryCold;
  const wind = features.windy;

  return {
    weights: {
      shirts: getPersonalizedShirtWeight(features),
      pants: getPersonalizedPantsWeight(features),
      footwear: getPersonalizedFootwearWeight(features),
      outerwear: getPersonalizedOuterwearWeight(features)
    },
    conditions: {
      rain,
      snow,
      sun,
      wind,
      cold,
      cool: features.cool,
      hot: features.hot,
      veryCold: features.veryCold
    },
    categoryNeeds: {
      shirts: true,
      pants: true,
      footwear: true,
      outerwear: snow || rain || wind || features.cool || cold
    }
  };
}

function getPersonalizedShirtWeight(features) {
  if (features.winterPrecipRisk || features.veryCold || features.minFeels <= 35) {
    return "Heavy";
  }

  if (features.coldWind || features.minFeels <= 45) {
    return "Medium-Heavy";
  }

  if (features.rainRisk || features.cool || features.cloudy || features.windy) {
    return features.minFeels <= 50 ? "Medium" : "Light-Medium";
  }

  return features.hot || features.maxFeels >= 70 ? "Light" : "Light-Medium";
}

function getPersonalizedPantsWeight(features) {
  if (features.winterPrecipRisk || features.veryCold || features.minFeels <= 35) {
    return "Heavy";
  }

  if (features.coldWind || features.minFeels <= 45) {
    return "Medium-Heavy";
  }

  if (features.rainRisk || features.cool || features.cloudy || features.windy) {
    return "Medium";
  }

  return features.hot || features.maxFeels >= 74 ? "Light" : "Light-Medium";
}

function getPersonalizedFootwearWeight(features) {
  if (features.winterPrecipRisk || features.veryCold || features.minFeels <= 35) {
    return "Heavy";
  }

  // A cold day is not a snowstorm. "Heavy" footwear is reserved for the branch
  // above (snow, ice, or freezing); a merely cold day is one step lighter, which
  // also steers the fallback to ankle boots instead of snow boots.
  if (features.rainRisk || features.cold || features.coldWind || features.minFeels <= 45) {
    return features.rainRisk && features.minFeels > 45 ? "Medium" : "Medium-Heavy";
  }

  return features.hot || features.maxFeels >= 74 ? "Light" : "Medium";
}

function getPersonalizedOuterwearWeight(features) {
  if (features.winterPrecipRisk || features.veryCold || features.minFeels <= 35) {
    return "Heavy";
  }

  if (features.coldWind || features.minFeels <= 45) {
    return "Heavy";
  }

  if (features.rainRisk) {
    return features.minFeels <= 50 ? "Medium-Heavy" : "Light-Medium";
  }

  if (features.windy || features.cool || features.cloudy) {
    return features.minFeels <= 52 ? "Medium-Heavy" : "Medium";
  }

  return "Light-Medium";
}

// Rain uses a window-level profile so an umbrella can be recommended before
// later rain starts, while shoes stay reserved for heavier or sustained wetness.
function getRainProfile(weather, durationHours) {
  const hours = weather.checklistWindow?.usableHours ?? [];
  const probabilityThreshold = durationHours >= LONG_RAIN_WINDOW_HOURS
    ? LONG_WINDOW_RAIN_PROBABILITY_THRESHOLD
    : RAIN_PROBABILITY_THRESHOLD;
  const maxProbability = maxFromHours(hours, "precipitationProbability", weather.daily.precipitationProbability);
  const maxPrecipitation = Math.max(
    maxFromHours(hours, "precipitation", weather.current.precipitation),
    maxFromHours(hours, "rain", weather.current.rain),
    maxFromHours(hours, "showers", weather.current.showers)
  );
  const wetHours = hours.filter((hour) => isRainyHour(hour, probabilityThreshold));
  const hasRainCode = hasCode(RAIN_CODES, weather.current.weatherCode, weather.daily.weatherCode)
    || hours.some((hour) => hasCode(RAIN_CODES, hour.weatherCode));
  const heavyRain = maxPrecipitation >= HEAVY_RAIN_INCHES
    || hasCode(HEAVY_RAIN_CODES, weather.current.weatherCode, weather.daily.weatherCode)
    || hours.some((hour) => hasCode(HEAVY_RAIN_CODES, hour.weatherCode));
  const sustainedRain = wetHours.length >= SUSTAINED_RAIN_HOURS
    && (maxProbability >= SUSTAINED_RAIN_PROBABILITY || maxPrecipitation >= MEASURABLE_RAIN_INCHES);
  const umbrellaRisk = maxProbability >= probabilityThreshold
    || maxPrecipitation >= MEASURABLE_RAIN_INCHES
    || hasRainCode;
  const meaningfulRain = umbrellaRisk
    && (
      maxProbability >= MEANINGFUL_RAIN_PROBABILITY
      || maxPrecipitation >= MEANINGFUL_PRECIPITATION_INCHES
      || sustainedRain
    );

  return {
    umbrellaRisk,
    meaningfulRain,
    heavyRain,
    sustainedRain,
    maxProbability,
    maxPrecipitation
  };
}

function isRainyHour(hour, probabilityThreshold) {
  const hourPrecipitation = Math.max(
    bestNumber(hour.precipitation, 0),
    bestNumber(hour.rain, 0),
    bestNumber(hour.showers, 0)
  );

  return hourPrecipitation >= MEASURABLE_RAIN_INCHES
    || bestNumber(hour.precipitationProbability, 0) >= probabilityThreshold
    || hasCode(RAIN_CODES, hour.weatherCode);
}

// Daylight helpers support window-level reasoning without depending on a
// separate sunrise API.
export function hasDaylightHours(hours) {
  return getDaylightHours(Array.isArray(hours) ? hours : []).length > 0;
}

// Sun protection needs the window to be *mostly* clear, not to contain one
// bright hour. This used to be a plain .some(), so a single clear hour in an
// otherwise grey afternoon produced a sunglasses recommendation.
//
// Being strict here is worth it twice over: condition codes verified against
// observations only 55-69% of the time in production, so one hour's code is
// weak evidence; and the cost of the two errors is lopsided — missing
// sunglasses on a bright day is a minor annoyance, while recommending them on
// an overcast one makes the whole checklist look broken.
const SUN_PROTECTION_MIN_CLEAR_SHARE = 0.5;
const SUN_PROTECTION_MIN_CLEAR_HOURS = 2;

function hasMeaningfulSun(daylightHours) {
  if (daylightHours.length === 0) {
    return false;
  }

  const clearHours = daylightHours.filter((hour) => hasCode(CLEAR_SKY_CODES, hour.weatherCode));

  // The share carries the judgment; the hour count stops a one-hour window
  // from passing on a single clear reading, while still allowing a genuinely
  // short window to qualify when all of it is clear.
  return clearHours.length >= Math.min(SUN_PROTECTION_MIN_CLEAR_HOURS, daylightHours.length)
    && (clearHours.length / daylightHours.length) >= SUN_PROTECTION_MIN_CLEAR_SHARE;
}

function getDaylightHours(hours) {
  return hours.filter((hour) => {
    const forecastHour = parseForecastTime(hour.time).getHours();

    return forecastHour >= DAYLIGHT_START_HOUR && forecastHour < DAYLIGHT_END_HOUR;
  });
}

// Window and aggregation helpers turn a list of hourly objects into max/min
// values for rain, wind, temperature, and condition codes.
function isWithinWindow(hour, start, end) {
  const hourTime = parseForecastTime(hour.time);

  return hourTime >= start && hourTime < end;
}

function findNearestHour(hourly, targetTime) {
  return hourly.reduce((nearest, hour) => {
    const hourTime = parseForecastTime(hour.time);
    const distance = Math.abs(hourTime.getTime() - targetTime.getTime());

    if (!nearest || distance < nearest.distance) {
      return { hour, distance };
    }

    return nearest;
  }, null)?.hour ?? null;
}

function maxFromHours(hours, key, fallback) {
  const values = hours.map((hour) => hour[key]).filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return bestNumber(fallback, 0);
  }

  return Math.max(...values);
}

function minFromHours(hours, key, fallback) {
  const values = hours.map((hour) => hour[key]).filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return bestNumber(fallback, 0);
  }

  return Math.min(...values);
}

// Chooses the most important weather code in a window, preferring snow and rain
// over calmer conditions because those affect checklist items more.
function getWindowWeatherCode(hours, fallback) {
  const codes = hours.map((hour) => hour.weatherCode).filter((code) => Number.isFinite(code));

  return codes.find((code) => hasCode(SNOW_CODES, code))
    ?? codes.find((code) => hasCode(RAIN_CODES, code))
    ?? codes[0]
    ?? fallback;
}

function parseForecastTime(value) {
  return new Date(value);
}

function hasCode(codeSet, ...codes) {
  return codes.some((code) => codeSet.has(Number(code)));
}

function isCloudyHour(hour) {
  return isCloudyCode(hour.weatherCode);
}

function isCloudyCode(code) {
  const normalizedCode = Number(code);

  return Number.isFinite(normalizedCode)
    && normalizedCode !== PARTLY_CLOUDY_CODE
    && !CLEAR_SKY_CODES.has(normalizedCode)
    && !RAIN_CODES.has(normalizedCode)
    && !SNOW_CODES.has(normalizedCode);
}

// Returns up to two structured {key, params} reasons for the UI layer to
// translate and join, falling back to a generic "manageable" reason key when
// nothing notable applies.
function buildReasons(reasons, durationHours) {
  if (reasons.length === 0) {
    return [{ key: "reason.manageable", params: { hours: durationHours } }];
  }

  return reasons.slice(0, 2);
}

function getRainReason(precipProbability, durationHours) {
  if (precipProbability > 0) {
    return { key: "reason.rainRiskPercent", params: { percent: Math.round(precipProbability) } };
  }

  return { key: "reason.rainInForecast", params: { hours: durationHours } };
}

function normalizeForecastWindowHours(value) {
  const durationHours = Number(value);

  return Number.isFinite(durationHours) && durationHours > 0
    ? durationHours
    : DEFAULT_FORECAST_WINDOW_HOURS;
}
