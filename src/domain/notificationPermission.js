// Decides whether a change in notification permission is worth recording.
// Pure, so it can be tested without a browser.
//
// Browsers raise no event when someone turns notifications off in their
// settings; the only way to notice is to compare against the value seen last
// time the app was open. That means a change is detected on the NEXT launch,
// and never at all for someone who mutes Ready and does not come back.
//
// "unsupported" is not a state change worth reporting: it is what an iOS Safari
// tab says (Web Push only exists in the installed app), not a choice anyone
// made.
const MEANINGFUL = new Set(["granted", "denied", "default"]);

export function classifyPermissionChange(previous, current) {
  if (!MEANINGFUL.has(previous) || !MEANINGFUL.has(current) || previous === current) {
    return null;
  }

  // Both "denied" and "default" mean reminders can no longer be shown. Chrome
  // resets a revoked site to "default" rather than "denied", so both count.
  if (previous === "granted") {
    return "revoked";
  }

  // Only a return from an explicit block counts as restored. default ->
  // granted is a first-time opt-in, which notification_opt_in already records.
  if (previous === "denied" && current === "granted") {
    return "restored";
  }

  return null;
}
