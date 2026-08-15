/**
 * Registers the service worker so RelayOne is installable (Add to Home screen)
 * and opens offline. Safe no-op where service workers aren't supported.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* registration is best-effort; the app works without it */
    });
  });
}
