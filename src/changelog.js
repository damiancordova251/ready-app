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
  },
  {
    version: "device-context",
    en: "Behind the scenes, Ready now records which platform and browser it is running on so we can test and support them properly. No new personal information \u2014 see the Privacy Policy in Settings.",
    es: "Internamente, Ready ahora registra en qu\u00e9 plataforma y navegador se ejecuta para poder probarlos y mantenerlos. Ninguna informaci\u00f3n personal nueva \u2014 consulta la Pol\u00edtica de Privacidad en Configuraci\u00f3n."
  },
  {
    version: "city-location-fallback",
    en: "If your device can't share a location \u2014 which often happens when Ready is opened inside another app \u2014 you can now type in a city instead of being stuck on the setup screen.",
    es: "Si tu dispositivo no puede compartir la ubicaci\u00f3n \u2014 algo com\u00fan cuando Ready se abre dentro de otra aplicaci\u00f3n \u2014 ahora puedes escribir una ciudad en lugar de quedarte atascado en la pantalla de configuraci\u00f3n."
  },
  {
    version: "collapsible-checklist-install-prompt",
    en: "Your checklist is now compact \u2014 each category shows its best option, with alternatives one tap away. You can also set a city from the main screen, and Ready will show you how to add it to your home screen so reminders work.",
    es: "Tu lista ahora es compacta: cada categor\u00eda muestra su mejor opci\u00f3n y las alternativas est\u00e1n a un toque. Tambi\u00e9n puedes elegir una ciudad desde la pantalla principal, y Ready te mostrar\u00e1 c\u00f3mo agregarlo a tu pantalla de inicio para que funcionen los recordatorios."
  }
];
