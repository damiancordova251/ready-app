// A short, human-written note per app update, shown under the "Refresh"
// button in the update-available banner (see
// features/pwa/serviceWorkerClient.js). Newest entry goes at the end of the
// array; the banner always shows the last one. `version` should match
// whatever sw.js's APP_VERSION was bumped to for that round, for traceability
// — it isn't read programmatically, since the banner just wants "whatever
// shipped most recently."
//
// Convention going forward: whenever APP_VERSION in sw.js is bumped, add one
// new entry here (both languages) summarizing that round's fixes/features.
export const CHANGELOG = [
  {
    version: "report-issue-settings",
    en: "Added Spanish language support, a way to share Ready with friends, weather-aware reminders, and a \"Report a problem\" option in Settings.",
    es: "Se agregó soporte en español, una forma de compartir Ready con amigos, recordatorios según el clima, y una opción para \"Reportar un problema\" en Configuración."
  },
  {
    version: "update-notes",
    en: "You'll now see a short note like this one whenever Ready has an update, explaining what changed.",
    es: "Ahora verás una breve nota como esta cada vez que Ready tenga una actualización, explicando qué cambió."
  },
  {
    version: "privacy-consent-data-controls",
    en: "Added a Privacy Policy and Terms of Service, clearer detail about what Ready stores, and a \"Delete my data\" button in Settings that erases everything tied to your device.",
    es: "Se agregó una Política de Privacidad y Términos de Servicio, más detalle sobre qué guarda Ready, y un botón \"Borrar mis datos\" en Configuración que elimina todo lo vinculado a tu dispositivo."
  }
];
