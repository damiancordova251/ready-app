import assert from "node:assert/strict";
import {
  buildWindowWeather,
  createRecommendation,
  getNextForecastWindow
} from "../src/domain/recommendation.js";
import { createPersonalizedChecklist } from "../src/domain/personalizedChecklist.js";

const NOW = new Date("2026-05-20T08:00:00-04:00");
const CLOTHING_LABEL_PATTERN = /^(Footwear|Pants|Shirts|Outerwear) \((Light|Light-Medium|Medium|Medium-Heavy|Heavy)\)$/;
const WEATHER_PURPOSE_LABEL_PATTERN = /^(Footwear|Pants|Shirts|Outerwear) \((Rain|Snow|Sun|Wind|Cold|Rain\/Sun|Cold\/Wind|Rain\/Wind)\)$/;

function personalizedItems(weather, preferences = completePreferences(), durationHours = 6) {
  const forecastWindow = getNextForecastWindow(weather, NOW, durationHours);
  const recommendation = createRecommendation(buildWindowWeather(weather, forecastWindow));

  return createPersonalizedChecklist(recommendation, preferences, {
    completionStatus: "saved"
  });
}

function makeWeather({
  temperature = 72,
  feelsLike = temperature,
  high = Math.max(temperature, 75),
  low = Math.min(temperature, 65),
  weatherCode = 2,
  windSpeed = 5,
  hourlyOverrides = []
} = {}) {
  const hourly = Array.from({ length: 14 }, (_, offset) => ({
    time: addHours(NOW, offset).toISOString(),
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
      time: NOW.toISOString(),
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
  precipitation = 0.04,
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

function snowAt(offset) {
  return {
    offset,
    precipitationProbability: 70,
    snowfall: 0.2,
    weatherCode: 71
  };
}

function addHours(date, hours) {
  const copy = new Date(date);

  copy.setHours(copy.getHours() + hours);
  return copy;
}

function completePreferences(overrides = {}) {
  return {
    footwear: ["Sandals", "Sneakers", "Rain boots", "Snow boots", "Ankle boots"],
    pants: ["Shorts", "Cargo pants", "Jeans", "Trousers", "Thermal leggings/base layer"],
    shirts: ["T-shirt", "Tank top", "Long-sleeve shirt", "Turtleneck", "Thermal top/base layer"],
    outerwear: ["Rain jacket", "Windbreaker", "Puffer jacket", "Heavy coat"],
    accessories: ["Sunglasses", "Sun hat", "Umbrella", "Beanie", "Scarf", "Gloves"],
    ...overrides
  };
}

function findSection(checklist, category) {
  return checklist.sections.find((section) => section.category === category);
}

function assertSection(checklist, category, label, items) {
  const section = findSection(checklist, category);

  assert.ok(section, `${category} section should exist.`);

  const labels = getSectionItemLabels(section);

  assert.equal(section.title, `${category} (${label})`);
  items.forEach((item) => {
    assert.equal(labels.includes(item), true, `${section.title} should include ${item}.`);
  });
}

function getSectionItemLabels(section) {
  return section.items.map(getItemLabel);
}

function getItemLabel(item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? item.label
    : item;
}

function assertItemWarning(checklist, category, itemLabel, warning) {
  const section = findSection(checklist, category);

  assert.ok(section, `${category} section should exist.`);

  const item = section.items.find((sectionItem) => getItemLabel(sectionItem) === itemLabel);

  assert.ok(item, `${section.title} should include ${itemLabel}.`);
  assert.equal(typeof item, "object", `${itemLabel} should include warning metadata.`);
  assert.equal(item.warning, warning);
}

function assertNoItemWarnings(checklist, category) {
  const section = findSection(checklist, category);

  assert.ok(section, `${category} section should exist.`);
  section.items.forEach((item) => {
    const hasWarning = item && typeof item === "object" && Boolean(item.warning);

    assert.equal(hasWarning, false, `${getItemLabel(item)} should not show a warning.`);
  });
}

function assertClothingLabelsUseWeights(checklist) {
  checklist.sections
    .filter((section) => section.category !== "Accessories")
    .forEach((section) => {
      assert.equal(CLOTHING_LABEL_PATTERN.test(section.title), true, `${section.title} should use a weight label.`);
      assert.equal(WEATHER_PURPOSE_LABEL_PATTERN.test(section.title), false, `${section.title} should not use a weather-purpose label.`);
    });
}

function assertMaxThreeItems(checklist) {
  checklist.sections.forEach((section) => {
    assert.equal(section.items.length <= 3, true, `${section.title} should stay compact.`);
  });
}

{
  const recommendation = createRecommendation(buildWindowWeather(
    makeWeather(),
    getNextForecastWindow(makeWeather(), NOW, 6)
  ));
  const checklist = createPersonalizedChecklist(recommendation, completePreferences(), {
    completionStatus: "skipped"
  });

  assert.equal(checklist.personalized, false);
  assert.equal(checklist.usesDefaultPreferences, true);
  assertSection(checklist, "Shirts", "Light", ["T-shirt", "Tank top"]);
  assertSection(checklist, "Pants", "Light-Medium", ["Shorts", "Cargo pants"]);
  assertSection(checklist, "Footwear", "Medium", ["Sandals", "Sneakers"]);
  assertClothingLabelsUseWeights(checklist);
}

{
  const recommendation = createRecommendation(buildWindowWeather(
    makeWeather(),
    getNextForecastWindow(makeWeather(), NOW, 6)
  ));
  const checklist = createPersonalizedChecklist(recommendation, null, {
    completionStatus: null
  });

  assert.equal(checklist.personalized, false);
  assert.equal(checklist.usesDefaultPreferences, true);
  assertSection(checklist, "Shirts", "Light", ["T-shirt", "Tank top"]);
  assertSection(checklist, "Pants", "Light-Medium", ["Shorts", "Cargo pants"]);
  assertClothingLabelsUseWeights(checklist);
}

{
  const recommendation = createRecommendation(buildWindowWeather(
    makeWeather({
      temperature: 55,
      feelsLike: 55,
      high: 59,
      low: 51,
      weatherCode: 3,
      hourlyOverrides: [rainAt(2)]
    }),
    getNextForecastWindow(makeWeather({
      temperature: 55,
      feelsLike: 55,
      high: 59,
      low: 51,
      weatherCode: 3,
      hourlyOverrides: [rainAt(2)]
    }), NOW, 6)
  ));
  const checklist = createPersonalizedChecklist(recommendation, {
    footwear: [],
    pants: ["Jeans"],
    shirts: ["Long-sleeve shirt"],
    outerwear: [],
    accessories: []
  }, {
    completionStatus: "saved"
  });

  assert.equal(checklist.personalized, false);
  assertSection(checklist, "Outerwear", "Light-Medium", ["Rain jacket"]);
  assertSection(checklist, "Footwear", "Medium", ["Rain boots"]);
  assertSection(checklist, "Accessories", "Rain", ["Umbrella"]);
  assertClothingLabelsUseWeights(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 84,
    feelsLike: 84,
    high: 90,
    low: 78,
    weatherCode: 0
  }));

  assertSection(checklist, "Shirts", "Light", ["T-shirt", "Tank top"]);
  assertSection(checklist, "Pants", "Light", ["Shorts"]);
  assertSection(checklist, "Footwear", "Light", ["Sandals", "Sneakers"]);
  assertSection(checklist, "Accessories", "Sun", ["Sunglasses", "Sun hat"]);
  assertClothingLabelsUseWeights(checklist);
  assertMaxThreeItems(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 55,
    feelsLike: 55,
    high: 59,
    low: 51,
    weatherCode: 3,
    hourlyOverrides: [rainAt(2)]
  }));

  assertSection(checklist, "Shirts", "Light-Medium", ["Long-sleeve shirt"]);
  assertSection(checklist, "Pants", "Medium", ["Jeans"]);
  assertSection(checklist, "Outerwear", "Light-Medium", ["Rain jacket"]);
  assertSection(checklist, "Footwear", "Medium", ["Rain boots"]);
  assertSection(checklist, "Accessories", "Rain", ["Umbrella"]);
  assertNoItemWarnings(checklist, "Outerwear");
  assertNoItemWarnings(checklist, "Footwear");
  assertNoItemWarnings(checklist, "Accessories");
  assertClothingLabelsUseWeights(checklist);
  assertMaxThreeItems(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 30,
    feelsLike: 25,
    high: 32,
    low: 24,
    weatherCode: 71,
    hourlyOverrides: [snowAt(1)]
  }));

  assertSection(checklist, "Shirts", "Heavy", ["Thermal top/base layer", "Turtleneck"]);
  assertSection(checklist, "Pants", "Heavy", ["Thermal leggings/base layer"]);
  assertSection(checklist, "Outerwear", "Heavy", ["Heavy coat", "Puffer jacket"]);
  assertSection(checklist, "Footwear", "Heavy", ["Snow boots"]);
  assertSection(checklist, "Accessories", "Snow", ["Beanie", "Scarf", "Gloves"]);
  assertClothingLabelsUseWeights(checklist);
  assertMaxThreeItems(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 44,
    feelsLike: 39,
    high: 47,
    low: 38,
    weatherCode: 3,
    windSpeed: 24
  }));

  assertSection(checklist, "Accessories", "Cold/Wind", ["Scarf", "Gloves"]);
  assertClothingLabelsUseWeights(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 55,
    feelsLike: 55,
    high: 59,
    low: 51,
    weatherCode: 3,
    hourlyOverrides: [rainAt(2)]
  }), completePreferences({
    footwear: ["Sneakers"],
    pants: ["Jeans"],
    shirts: ["Long-sleeve shirt"],
    outerwear: ["Hoodie"],
    accessories: ["Beanie"]
  }));

  assertSection(checklist, "Outerwear", "Light-Medium", ["Hoodie"]);
  assertSection(checklist, "Footwear", "Medium", ["Sneakers"]);
  assertSection(checklist, "Accessories", "Rain", ["Beanie"]);
  assertItemWarning(checklist, "Footwear", "Sneakers", "May not be ideal for rain.");
  assertNoItemWarnings(checklist, "Outerwear");
  assertNoItemWarnings(checklist, "Accessories");
  assertClothingLabelsUseWeights(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 30,
    feelsLike: 25,
    high: 32,
    low: 24,
    weatherCode: 3
  }), completePreferences({
    footwear: ["Sandals"],
    pants: ["Shorts"],
    shirts: ["Tank top"],
    outerwear: ["Cardigan"],
    accessories: ["Sunglasses"]
  }));

  assertSection(checklist, "Outerwear", "Heavy", ["Cardigan"]);
  assertSection(checklist, "Accessories", "Cold", ["Sunglasses"]);
  assertItemWarning(checklist, "Outerwear", "Cardigan", "May be too light for the cold.");
  assertItemWarning(checklist, "Accessories", "Sunglasses", "May not help much with the cold.");
  assertClothingLabelsUseWeights(checklist);
}

{
  const checklist = personalizedItems(makeWeather({
    temperature: 84,
    feelsLike: 84,
    high: 90,
    low: 78,
    weatherCode: 0
  }), completePreferences({
    accessories: ["Beanie"]
  }));

  assertSection(checklist, "Accessories", "Sun", ["Beanie"]);
  assertNoItemWarnings(checklist, "Accessories");
  assertClothingLabelsUseWeights(checklist);
}

// A clear but cool morning must not pair sandals with a jacket. Sun used to
// promote light footwear on its own, independent of temperature.
{
  const checklist = personalizedItems(makeWeather({
    temperature: 55,
    feelsLike: 55,
    high: 60,
    low: 50,
    weatherCode: 0
  }));
  const footwear = findSection(checklist, "Footwear");
  const labels = getSectionItemLabels(footwear);

  assert.notEqual(labels[0], "Sandals", `Clear 55F should not lead with sandals, got ${labels[0]}.`);

  // The warm case still has to work in the other direction.
  const warm = personalizedItems(makeWeather({
    temperature: 84,
    feelsLike: 84,
    high: 90,
    low: 78,
    weatherCode: 0
  }));

  assert.equal(
    getSectionItemLabels(findSection(warm, "Footwear")).includes("Sandals"),
    true,
    "A hot clear day should still offer sandals."
  );
}

console.log("Personalized checklist examples passed.");
