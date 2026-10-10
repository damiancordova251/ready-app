import assert from "node:assert/strict";
import { COMFORT_RATINGS, isAcceptableDate, parseComfortFeedbackPayload } from "../server/comfortFeedback.js";
import {
  COMFORT_PAUSE_DAYS,
  COMFORT_SKIP_LIMIT,
  applyAnswer,
  applySkip,
  daysBetween,
  emptyComfortLog,
  markPrompted,
  normalizeComfortLog,
  pickComfortCandidate,
  recordSnapshot
} from "../src/domain/comfortSchedule.js";

const NOW = new Date("2026-10-10T15:00:00Z");
const ID = "761dbb65-c654-4a1e-9f3d-2b8c7e5a1d40";
const DAY_MS = 24 * 60 * 60 * 1000;

function body(overrides = {}) {
  return {
    installationId: ID,
    rating: "just_right",
    recommendedForDate: "2026-10-09",
    weatherSummary: { feelsLike: 52.37, high: 58, windSpeed: 12 },
    suggestions: [{ category: "Shirts", weight: "Medium", item: "Long-sleeve shirt" }],
    expectedTimeAwayHours: 6,
    appVersion: "0.1.0",
    ...overrides
  };
}

// --- payload validation -----------------------------------------------------

assert.deepEqual([...COMFORT_RATINGS], ["too_cold", "just_right", "too_warm"]);

{
  const parsed = parseComfortFeedbackPayload(body(), NOW);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.rating, "just_right");
  assert.equal(parsed.value.weatherSummary.feelsLike, 52.4, "readings are rounded to one decimal");
  assert.deepEqual(parsed.value.suggestions, [{ category: "Shirts", weight: "Medium", item: "Long-sleeve shirt" }]);
}

// Every rating is accepted; nothing else is.
["too_cold", "just_right", "too_warm"].forEach((rating) => {
  assert.equal(parseComfortFeedbackPayload(body({ rating }), NOW).ok, true, rating);
});
["", "cold", "TOO_COLD", null, 3, undefined].forEach((rating) => {
  assert.equal(parseComfortFeedbackPayload(body({ rating }), NOW).ok, false, `rating ${String(rating)}`);
});

// Installation id has to look like one the client mints.
["", "short", "has spaces in it", "x".repeat(81), null].forEach((installationId) => {
  assert.equal(parseComfortFeedbackPayload(body({ installationId }), NOW).ok, false, `id ${String(installationId)}`);
});

// Dates: real calendar days, recent, and not meaningfully in the future.
assert.equal(isAcceptableDate("2026-10-09", NOW), true, "yesterday");
assert.equal(isAcceptableDate("2026-10-11", NOW), true, "tomorrow in UTC is today somewhere");
assert.equal(isAcceptableDate("2026-09-26", NOW), true, "exactly 14 days old");
assert.equal(isAcceptableDate("2026-09-25", NOW), false, "15 days old is too old to remember");
assert.equal(isAcceptableDate("2026-10-12", NOW), false, "two days ahead is not a timezone");
assert.equal(isAcceptableDate("2026-02-30", NOW), false, "not a real date");
assert.equal(isAcceptableDate("10/09/2026", NOW), false, "wrong format");
assert.equal(isAcceptableDate(20261009, NOW), false, "not a string");

// Unknown weather fields are dropped; null is not stored as 0F.
{
  const parsed = parseComfortFeedbackPayload(body({
    weatherSummary: { feelsLike: null, high: 60, latitude: 42.37, longitude: -71.1, note: "x", low: "50" }
  }), NOW);

  assert.deepEqual(parsed.value.weatherSummary, { high: 60 }, "coordinates and junk must never be stored");
}

// Suggestions are capped, bounded, and malformed entries dropped.
{
  const parsed = parseComfortFeedbackPayload(body({
    suggestions: [
      { category: "Shirts", item: "T-shirt" },
      { category: "Pants" },
      "Jeans",
      null,
      ...Array.from({ length: 12 }, () => ({ category: "Shirts", item: "x".repeat(200) }))
    ]
  }), NOW);

  assert.ok(parsed.value.suggestions.length <= 8);
  assert.equal(parsed.value.suggestions[0].item, "T-shirt");
  assert.ok(parsed.value.suggestions.every((entry) => entry.item.length <= 60));
}

assert.equal(parseComfortFeedbackPayload(body({ expectedTimeAwayHours: 99 }), NOW).value.expectedTimeAwayHours, null);
assert.equal(parseComfortFeedbackPayload(body({ expectedTimeAwayHours: 6.5 }), NOW).value.expectedTimeAwayHours, null);

// --- when to ask ------------------------------------------------------------

const TODAY = "2026-10-10";
const nowMs = NOW.getTime();
const snap = (date) => ({ date, weatherSummary: { feelsLike: 50 }, suggestions: [] });

// Nothing recorded yet: nothing to ask about.
assert.equal(pickComfortCandidate(emptyComfortLog(), TODAY, nowMs), null);

// Only today's visit exists: ask tomorrow, not today.
assert.equal(pickComfortCandidate(recordSnapshot(emptyComfortLog(), snap(TODAY)), TODAY, nowMs), null);

// Yesterday's visit is the candidate.
{
  const log = recordSnapshot(recordSnapshot(emptyComfortLog(), snap("2026-10-09")), snap(TODAY));

  assert.equal(pickComfortCandidate(log, TODAY, nowMs)?.date, "2026-10-09");
}

// The first checklist of a day is kept; a later re-render does not replace it.
{
  const first = { ...snap("2026-10-09"), weatherSummary: { feelsLike: 40 } };
  const later = { ...snap("2026-10-09"), weatherSummary: { feelsLike: 65 } };
  const log = recordSnapshot(recordSnapshot(emptyComfortLog(), first), later);

  assert.equal(log.snapshots["2026-10-09"].weatherSummary.feelsLike, 40, "the morning decision is what gets rated");
}

// Only the most recent previous visit is ever asked about — no backlog.
{
  let log = recordSnapshot(emptyComfortLog(), snap("2026-10-07"));
  log = recordSnapshot(log, snap("2026-10-09"));
  log = applyAnswer(log, "2026-10-09");

  assert.equal(pickComfortCandidate(log, TODAY, nowMs), null, "answered the latest; older visits are not dredged up");
}

// More than a week old is too long ago to remember reliably.
assert.equal(daysBetween("2026-10-02", TODAY), 8);
assert.equal(pickComfortCandidate(recordSnapshot(emptyComfortLog(), snap("2026-10-02")), TODAY, nowMs), null);
assert.equal(pickComfortCandidate(recordSnapshot(emptyComfortLog(), snap("2026-10-03")), TODAY, nowMs)?.date, "2026-10-03");

// At most once per day, even across reloads.
{
  const log = markPrompted(recordSnapshot(emptyComfortLog(), snap("2026-10-09")), TODAY);

  assert.equal(pickComfortCandidate(log, TODAY, nowMs), null);
}

// A skipped visit is not asked about again.
{
  const log = applySkip(recordSnapshot(emptyComfortLog(), snap("2026-10-09")), "2026-10-09", nowMs);

  assert.equal(pickComfortCandidate(log, TODAY, nowMs), null);
  assert.equal(log.skipStreak, 1);
}

// Repeated skips pause the question entirely, then it comes back.
{
  let log = emptyComfortLog();

  for (let i = 0; i < COMFORT_SKIP_LIMIT; i += 1) {
    log = applySkip(log, `2026-10-0${i + 1}`, nowMs);
  }

  assert.equal(log.skipStreak, 0, "streak resets once the pause starts");
  assert.equal(log.pausedUntil, nowMs + COMFORT_PAUSE_DAYS * DAY_MS);

  const withVisit = recordSnapshot(log, snap("2026-10-09"));

  assert.equal(pickComfortCandidate(withVisit, TODAY, nowMs), null, "paused");
  assert.equal(
    pickComfortCandidate(withVisit, "2026-10-18", nowMs + COMFORT_PAUSE_DAYS * DAY_MS + 1),
    null,
    "after the pause, a visit 9 days old is still too old"
  );

  const fresh = recordSnapshot(withVisit, snap("2026-10-17"));

  assert.equal(
    pickComfortCandidate(fresh, "2026-10-18", nowMs + COMFORT_PAUSE_DAYS * DAY_MS + 1)?.date,
    "2026-10-17",
    "asks again once the pause ends"
  );
}

// Answering resets the skip streak.
assert.equal(applyAnswer({ ...emptyComfortLog(), skipStreak: 2 }, "2026-10-09").skipStreak, 0);

// Storage is untrusted: garbage normalizes to an empty, working log.
[null, "nonsense", 42, [], { snapshots: [], resolved: "x", skipStreak: "2", pausedUntil: "soon" }].forEach((raw) => {
  const log = normalizeComfortLog(raw);

  assert.deepEqual(log.snapshots, {});
  assert.deepEqual(log.resolved, []);
  assert.equal(log.skipStreak, 0);
  assert.equal(log.pausedUntil, null);
});

// Snapshots are capped so storage cannot grow without bound.
{
  let log = emptyComfortLog();

  for (let day = 1; day <= 20; day += 1) {
    log = recordSnapshot(log, snap(`2026-09-${String(day).padStart(2, "0")}`));
  }

  assert.equal(Object.keys(log.snapshots).length, 10);
  assert.ok(log.snapshots["2026-09-20"], "the newest are the ones kept");
}

console.log("Comfort feedback examples passed.");
