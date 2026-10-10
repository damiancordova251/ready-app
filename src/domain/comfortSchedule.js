// Decides when to ask "how did your last visit feel?" — and, as importantly,
// when not to. Pure (no DOM, no storage, no clock reads) so the rules can be
// tested directly; features/feedback/comfortCheck.js owns persistence and UI.
//
// The rules, in priority order:
//   - at most once per calendar day
//   - only ever about the MOST RECENT previous visit, never an older backlog
//   - not if that visit is more than a week old (memory is unreliable by then)
//   - three skips in a row pause the question for a week, so someone who
//     doesn't want to answer stops being asked instead of being nagged daily

export const COMFORT_MAX_LOOKBACK_DAYS = 7;
export const COMFORT_SKIP_LIMIT = 3;
export const COMFORT_PAUSE_DAYS = 7;

const MAX_SNAPSHOTS = 10;
const MAX_RESOLVED = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyComfortLog() {
  return {
    snapshots: {},
    resolved: [],
    skipStreak: 0,
    pausedUntil: null,
    lastPromptDate: null
  };
}

// Storage can hold anything (an old format, a hand edit, a partial write), so
// every field is re-checked rather than trusted.
export function normalizeComfortLog(raw) {
  const log = emptyComfortLog();

  if (!raw || typeof raw !== "object") {
    return log;
  }

  if (raw.snapshots && typeof raw.snapshots === "object" && !Array.isArray(raw.snapshots)) {
    log.snapshots = { ...raw.snapshots };
  }

  if (Array.isArray(raw.resolved)) {
    log.resolved = raw.resolved.filter((date) => typeof date === "string");
  }

  log.skipStreak = Number.isInteger(raw.skipStreak) ? raw.skipStreak : 0;
  log.pausedUntil = Number.isFinite(raw.pausedUntil) ? raw.pausedUntil : null;
  log.lastPromptDate = typeof raw.lastPromptDate === "string" ? raw.lastPromptDate : null;

  return log;
}

// Keeps the FIRST checklist of each day. The first one is what someone
// actually dressed by; later renders the same day (a time-away tweak, a
// re-check at lunch) come after the decision the answer will be about.
export function recordSnapshot(log, snapshot) {
  if (!snapshot?.date || log.snapshots[snapshot.date]) {
    return log;
  }

  const snapshots = { ...log.snapshots, [snapshot.date]: snapshot };
  const kept = Object.keys(snapshots).sort().slice(-MAX_SNAPSHOTS);

  return {
    ...log,
    snapshots: Object.fromEntries(kept.map((date) => [date, snapshots[date]]))
  };
}

export function pickComfortCandidate(log, today, nowMs) {
  if (log.lastPromptDate === today) {
    return null;
  }

  if (log.pausedUntil && nowMs < log.pausedUntil) {
    return null;
  }

  // YYYY-MM-DD sorts correctly as a string.
  const previous = Object.keys(log.snapshots).filter((date) => date < today).sort().at(-1);

  if (!previous || log.resolved.includes(previous)) {
    return null;
  }

  if (daysBetween(previous, today) > COMFORT_MAX_LOOKBACK_DAYS) {
    return null;
  }

  return log.snapshots[previous];
}

export function markPrompted(log, today) {
  return { ...log, lastPromptDate: today };
}

export function applyAnswer(log, date) {
  return { ...log, resolved: addResolved(log.resolved, date), skipStreak: 0 };
}

export function applySkip(log, date, nowMs) {
  const skipStreak = log.skipStreak + 1;

  if (skipStreak >= COMFORT_SKIP_LIMIT) {
    return {
      ...log,
      resolved: addResolved(log.resolved, date),
      skipStreak: 0,
      pausedUntil: nowMs + COMFORT_PAUSE_DAYS * DAY_MS
    };
  }

  return { ...log, resolved: addResolved(log.resolved, date), skipStreak };
}

export function daysBetween(earlier, later) {
  return Math.round((toUtcDay(later) - toUtcDay(earlier)) / DAY_MS);
}

function toUtcDay(date) {
  const [year, month, day] = date.split("-").map(Number);

  return Date.UTC(year, month - 1, day);
}

function addResolved(resolved, date) {
  return resolved.includes(date)
    ? resolved
    : [...resolved, date].slice(-MAX_RESOLVED);
}
