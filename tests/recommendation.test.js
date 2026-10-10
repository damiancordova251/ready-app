import assert from "node:assert/strict";
import {
  buildWindowWeather,
  createRecommendation,
  getNextForecastWindow
} from "../src/domain/recommendation.js";

const NOW = new Date("2026-05-20T08:00:00-04:00");
const TOP_OPTIONS = [
  "Tank Top",
  "T-shirt",
  "Polo Shirt",
  "Light Long-Sleeve",
  "Button-Up Shirt",
  "Sweater",
  "Hoodie",
  "Light Jacket",
  "Heavy Coat",
  "Thermal Layer"
];
const BOTTOM_OPTIONS = [
  "Shorts",
  "Skirt",
  "Cargo Pants",
  "Jeans",
  "Pants",
  "Joggers",
  "Sweatpants",
  "Thermal Pants"
];
const VALID_WEIGHT_LABELS = ["Light", "Light-Medium", "Medium", "Medium-Heavy", "Heavy"];
const REMOVED_OPTIONS = [
  "Sunglasses or hat",
  "Waterproof Layer",
  "Water-resistant pants",
  "Wind-resistant Layer",
  "Rain boots or waterproof shoes"
];

function recommendationItems(weather, durationHours, now = NOW) {
  const forecastWindow = getNextForecastWindow(weather, now, durationHours);
  const windowWeather = buildWindowWeather(weather, forecastWindow);

  return createRecommendation(windowWeather).items;
}

function makeWeather({
  now = NOW,
  temperature = 72,
  feelsLike = temperature,
  high = Math.max(temperature, 75),
  low = Math.min(temperature, 65),
  weatherCode = 2,
  windSpeed = 5,
  hourlyOverrides = []
} = {}) {
  const hourly = Array.from({ length: 14 }, (_, offset) => ({
    time: addHours(now, offset).toISOString(),
    temperature,
    feelsLike,
    precipitationProbability: 0,
    precipitation: 0,
    rain: 0,
    showers: 0,
    snowfall: 0,
    weatherCode,
    windSpeed
  }));

  hourlyOverrides.forEach(({ offset, ...override }) => {
    Object.assign(hourly[offset], override);
  });

  return {
    current: {
      time: now.toISOString(),
      temperature,
      feelsLike,
      precipitation: 0,
      rain: 0,
      showers: 0,
      snowfall: 0,
      weatherCode,
      windSpeed
    },
    daily: {
      date: "2026-05-20",
      weatherCode,
      high,
      low,
      precipitationProbability: 0,
      windMax: windSpeed
    },
    hourly
  };
}

function rainAt(offset, {
  probability = 70,
  precipitation = 0.03,
  weatherCode = 61
} = {}) {
  return {
    offset,
    precipitationProbability: probability,
    precipitation,
    rain: precipitation,
    weatherCode
  };
}

function snowAt(offset, {
  probability = 70,
  snowfall = 0.2,
  weatherCode = 71
} = {}) {
  return {
    offset,
    precipitationProbability: probability,
    snowfall,
    weatherCode
  };
}

function warmHour(offset, temperature) {
  return {
    offset,
    temperature,
    feelsLike: temperature
  };
}

function addHours(date, hours) {
  const copy = new Date(date);

  copy.setHours(copy.getHours() + hours);
  return copy;
}

// Items are now structured, translatable descriptors (see
// src/domain/recommendation.js) rather than pre-formatted English strings,
// so these helpers assert against `type`/`category`/`weightLabel`/`options`
// directly instead of regex-matching composed copy.
function findClothingGroup(items, category) {
  return items.find((item) => item.type === "clothingGroup" && item.category === category);
}

function findAccessory(items, options) {
  return items.find((item) => item.type === "accessory" && arraysEqual(item.options, options));
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((value, index) => value === b[index]);
}

function assertClothingGroup(items, category, weightLabel, options, message) {
  const item = findClothingGroup(items, category);

  assert.ok(item, `${message}: expected a ${category} clothing group.`);
  assert.equal(item.weightLabel, weightLabel, `${message}: expected ${category} weight ${weightLabel}, got ${item.weightLabel}.`);
  assert.deepEqual(item.options, options, `${message}: expected ${category} options ${options.join(" / ")}, got ${item.options.join(" / ")}.`);
}

function assertClothingWeightIn(items, category, weights, message) {
  const item = findClothingGroup(items, category);

  assert.ok(item, `${message}: expected a ${category} clothing group.`);
  assert.equal(weights.includes(item.weightLabel), true, `${message}: got weight ${item.weightLabel}.`);
}

function assertHasAccessory(items, options, message) {
  assert.ok(findAccessory(items, options), message);
}

function assertExcludesAccessory(items, options, message) {
  assert.equal(findAccessory(items, options), undefined, message);
}

function assertHasTopAndBottom(items, message) {
  const top = findClothingGroup(items, "Top");
  const bottom = findClothingGroup(items, "Bottom");

  assert.ok(top, `${message} should include a Top clothing group.`);
  assert.ok(bottom, `${message} should include a Bottom clothing group.`);
  assert.equal(top.options.some((option) => TOP_OPTIONS.includes(option)), true, `${message} should include top options.`);
  assert.equal(bottom.options.some((option) => BOTTOM_OPTIONS.includes(option)), true, `${message} should include bottom options.`);
}

function assertValidWeightLabels(items) {
  items
    .filter((item) => item.type === "clothingGroup")
    .forEach((item) => {
      assert.equal(VALID_WEIGHT_LABELS.includes(item.weightLabel), true, `${item.category} used an unexpected weight label: ${item.weightLabel}.`);
    });
}

function assertNoOption(items, option, message) {
  const found = items.some((item) => (item.options ?? []).includes(option));

  assert.equal(found, false, message);
}

function assertRemovedOptionsAbsent(items) {
  REMOVED_OPTIONS.forEach((option) => {
    assertNoOption(items, option, `${option} should not be emitted.`);
  });
}

{
  const items = recommendationItems(makeWeather({
    temperature: 84,
    feelsLike: 84,
    high: 90,
    low: 78,
    weatherCode: 0
  }), 6);

  assertClothingGroup(items, "Top", "Light", ["T-shirt", "Polo Shirt", "Tank Top"], "Hot sunny dry day should include labelled light tops.");
  assertClothingGroup(items, "Bottom", "Light", ["Shorts", "Skirt", "Cargo Pants"], "Hot sunny dry day should include labelled light bottoms.");
  assertHasAccessory(items, ["Sunglasses", "Hat"], "Hot sunny dry day should include sun protection.");
  assertHasTopAndBottom(items, "Hot sunny dry day");
  assertValidWeightLabels(items);
}

{
  const items = recommendationItems(makeWeather({
    temperature: 64,
    feelsLike: 64,
    high: 72,
    low: 58,
    weatherCode: 1,
    hourlyOverrides: [warmHour(4, 70)]
  }), 6);

  assertClothingGroup(items, "Top", "Light-Medium", ["T-shirt", "Polo Shirt", "Light Long-Sleeve"], "Mild sunny day should include labelled light-medium tops.");
  assertClothingGroup(items, "Bottom", "Light-Medium", ["Shorts", "Cargo Pants", "Jeans"], "Mild sunny day should bridge shorts and pants.");
  assertHasAccessory(items, ["Sunglasses", "Hat"], "Mild sunny daytime forecast should include sun protection.");
  assertValidWeightLabels(items);
}

{
  const items = recommendationItems(makeWeather({
    temperature: 60,
    feelsLike: 60,
    high: 64,
    low: 56,
    weatherCode: 3,
    windSpeed: 25
  }), 6);

  // A light long-sleeve no longer leads here: at 60F with 25mph wind the
  // warmer layers win, which is the point of the warmth bias.
  assertClothingGroup(items, "Top", "Medium-Heavy", ["Sweater", "Light Jacket", "Hoodie"], "Cloudy windy 60s should bias toward labelled layers.");
  // Jeans lead Cargo Pants: the two score identically here, and ties now break
  // toward the warmer garment rather than toward whichever was listed first.
  assertClothingGroup(items, "Bottom", "Medium", ["Jeans", "Cargo Pants", "Pants"], "Cloudy windy 60s should bias away from shorts.");
  assertNoOption(items, "Shorts", "Cloudy windy 60s should not suggest shorts.");
  assertValidWeightLabels(items);
}

{
  const items = recommendationItems(makeWeather({
    temperature: 55,
    feelsLike: 55,
    high: 59,
    low: 51,
    weatherCode: 3,
    hourlyOverrides: [rainAt(2, { probability: 70, precipitation: 0.04, weatherCode: 61 })]
  }), 6);

  assertClothingGroup(items, "Top", "Medium-Heavy", ["Sweater", "Light Jacket", "Hoodie"], "Cool rain should include normal labelled layer options.");
  assertClothingGroup(items, "Bottom", "Medium", ["Jeans", "Cargo Pants", "Pants"], "Cool rain should include normal labelled bottom options.");
  assertHasAccessory(items, ["Umbrella", "Rain Jacket"], "Rain should use umbrella/rain jacket copy.");
  assertExcludesAccessory(items, ["Sunglasses", "Hat"], "Rainy/cloudy-only forecast should not include sun protection.");
  assertRemovedOptionsAbsent(items);
  assertValidWeightLabels(items);
}

{
  const items = recommendationItems(makeWeather({
    temperature: 42,
    feelsLike: 38,
    high: 45,
    low: 36,
    weatherCode: 3,
    windSpeed: 16
  }), 6);

  assertClothingWeightIn(items, "Top", ["Medium-Heavy", "Heavy"], "Cold forecast should use medium-heavy or heavy top guidance.");
  assertClothingWeightIn(items, "Bottom", ["Medium-Heavy", "Heavy"], "Cold forecast should use medium-heavy or heavy bottom guidance.");
  assertHasTopAndBottom(items, "Cold forecast");
  assertValidWeightLabels(items);
}

{
  const items = recommendationItems(makeWeather({
    temperature: 30,
    feelsLike: 25,
    high: 32,
    low: 24,
    weatherCode: 71,
    windSpeed: 18,
    hourlyOverrides: [snowAt(1)]
  }), 6);

  assertClothingGroup(items, "Top", "Heavy", ["Thermal Layer", "Heavy Coat"], "Snow/freezing should include serious labelled upper-body layers.");
  assertClothingGroup(items, "Bottom", "Heavy", ["Thermal Pants", "Sweatpants"], "Snow/freezing should include serious labelled bottom layers.");
  assertHasAccessory(items, ["Winter shoes", "Snow boots"], "Snow/freezing should include winter footwear.");
  assertNoOption(items, "Shorts", "Snow/freezing should not suggest shorts.");
  assertNoOption(items, "Tank Top", "Snow/freezing should not suggest tank tops.");
  assertNoOption(items, "Sandals", "Snow/freezing should not suggest sandals.");
  assertValidWeightLabels(items);
}

{
  const weather = makeWeather({ hourlyOverrides: [rainAt(8)] });

  assertExcludesAccessory(recommendationItems(weather, 3), ["Umbrella", "Rain Jacket"], "3h window should ignore rain starting 8 hours later.");
  assertExcludesAccessory(recommendationItems(weather, 6), ["Umbrella", "Rain Jacket"], "6h window should ignore rain starting 8 hours later.");
  assertHasAccessory(recommendationItems(weather, 9), ["Umbrella", "Rain Jacket"], "9h window should catch rain starting 8 hours later.");
  assertHasAccessory(recommendationItems(weather, 12), ["Umbrella", "Rain Jacket"], "12h window should catch rain starting 8 hours later.");
}

{
  const nightNow = new Date("2026-05-20T21:00:00-04:00");
  const items = recommendationItems(makeWeather({
    now: nightNow,
    temperature: 78,
    feelsLike: 78,
    high: 82,
    low: 74,
    weatherCode: 0
  }), 3, nightNow);

  assertExcludesAccessory(items, ["Sunglasses", "Hat"], "Night-only forecast should not include sun protection.");
  assertValidWeightLabels(items);
}

{
  [
    makeWeather(),
    makeWeather({ temperature: 48, feelsLike: 45, high: 50, low: 42 }),
    makeWeather({ temperature: 82, feelsLike: 82, high: 86, low: 75 }),
    makeWeather({ temperature: 36, feelsLike: 32, high: 38, low: 30 })
  ].forEach((weather, index) => {
    const items = recommendationItems(weather, 6);

    assertHasTopAndBottom(items, `Normal forecast ${index + 1}`);
    assertRemovedOptionsAbsent(items);
    assertValidWeightLabels(items);
  });
}

// --- sun protection must mean actual sun ----------------------------------

function hourWithCode(offset, weatherCode) {
  return { offset, weatherCode };
}

// WMO code 2 is "partly cloudy", not sun. It used to sit in the clear-sky set,
// which is how sunglasses appeared on grey days. Production forecast-accuracy
// data: 15 predictions of code 2, observed overcast 100% of the time.
{
  const items = recommendationItems(makeWeather({
    temperature: 66,
    feelsLike: 66,
    high: 70,
    low: 62,
    weatherCode: 2
  }), 6);

  assertExcludesAccessory(items, ["Sunglasses", "Hat"], "Partly cloudy (code 2) should not count as sun.");
}

// One bright hour in an otherwise overcast window is not a sunny day.
{
  const items = recommendationItems(makeWeather({
    temperature: 66,
    feelsLike: 66,
    high: 70,
    low: 62,
    weatherCode: 3,
    hourlyOverrides: [hourWithCode(2, 0)]
  }), 6);

  assertExcludesAccessory(items, ["Sunglasses", "Hat"], "A single clear hour in a grey window should not trigger sun protection.");
}

// The other direction still has to work: a genuinely clear window keeps it.
{
  const items = recommendationItems(makeWeather({
    temperature: 74,
    feelsLike: 74,
    high: 78,
    low: 70,
    weatherCode: 0
  }), 6);

  assertHasAccessory(items, ["Sunglasses", "Hat"], "A fully clear daytime window should still include sun protection.");
}

// --- wind should not leave you in a t-shirt --------------------------------

// A 70F day with 26mph wind previously scored T-shirt and Light Long-Sleeve at
// 98 apiece, and the tie fell to whichever was added to the list first, so the
// headline suggestion was a t-shirt in strong wind.
{
  const items = recommendationItems(makeWeather({
    temperature: 70,
    feelsLike: 70,
    high: 72,
    low: 66,
    weatherCode: 1,
    windSpeed: 26
  }), 6);
  const top = findClothingGroup(items, "Top");

  assert.ok(top, "Windy mild day should produce a Top group.");
  assert.equal(
    top.options[0],
    "Light Long-Sleeve",
    `Windy 70F should lead with a layer, got ${top.options[0]}.`
  );
  assert.notEqual(top.options[0], "T-shirt", "Windy 70F should not lead with a t-shirt.");
}

// Ties break toward the warmer garment rather than toward list order.
{
  const items = recommendationItems(makeWeather({
    temperature: 55,
    feelsLike: 55,
    high: 59,
    low: 51,
    weatherCode: 3,
    hourlyOverrides: [rainAt(2, { probability: 70, precipitation: 0.04, weatherCode: 61 })]
  }), 6);
  const bottom = findClothingGroup(items, "Bottom");

  assert.equal(
    bottom.options.indexOf("Jeans") < bottom.options.indexOf("Cargo Pants"),
    true,
    "Equal-scoring bottoms should list the warmer one first."
  );
}

console.log("Recommendation examples passed.");
