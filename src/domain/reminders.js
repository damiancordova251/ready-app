// Centralized notification copy keeps local test notifications, server push
// payloads, and Settings text consistent.
export const REMINDER_COPY = {
  title: "✅ Your checklist is ready",
  body: "Open Ready to see what to wear today.",
  scheduledServer: "The server will send a simple daily reminder at your routine start time."
};

// Produces the reminder object used by both browser test notifications and the
// backend Web Push payload.
export function createChecklistReminder({ url = "./" } = {}) {
  return {
    title: REMINDER_COPY.title,
    body: REMINDER_COPY.body,
    tag: "ready-checklist",
    url
  };
}

// Formats the helper sentence that explains routine start time as reminder
// timing, separate from the checklist forecast window.
export function getRoutineReminderCopy(routineStartLabel) {
  return `Scheduled reminders will use your ${routineStartLabel} routine start.`;
}
