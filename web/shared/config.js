/* One place to point every page at the backend.
   - For the local demo: leave as-is, run the demo-server (see demo-server/README.md),
     and open these HTML files through that same server (or any static server) so
     relative fetches to /api/* work.
   - For the real event: replace API_BASE_URL with your deployed Apps Script Web App
     URL (ends in /exec), or your `?base=` override query param — see below. */
window.EVENT_APP_CONFIG = {
  // Default: same-origin /api (works when served by demo-server/server.js).
  API_BASE_URL: "/api",
};

/* Lets you point a specific device at a different backend without editing files —
   handy on the day of the demo/event if you need to repoint a kiosk quickly:
   e.g. kiosk-art.html?base=https://script.google.com/macros/s/XXXX/exec */
(function () {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("base");
  if (override) window.EVENT_APP_CONFIG.API_BASE_URL = override;
})();
