// Service worker mínimo de Vecinity.
// Su único propósito hoy es habilitar la instalación de la PWA (Chrome/Android
// exige un service worker con handler de fetch para ofrecer "Instalar app").
// NO cachea ni intercepta respuestas: deja pasar todo a la red, para no
// introducir bugs de caché. El caché offline puede agregarse después.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // passthrough: la presencia del handler basta para la instalabilidad.
});
