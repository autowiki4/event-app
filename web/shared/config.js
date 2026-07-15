/* One place to point every page at the backend.
   - For the local demo: leave as-is, run the demo-server (see demo-server/README.md),
     and open these HTML files through that same server (or any static server) so
     relative fetches to /api/* work.
   - For the real event: replace API_BASE_URL with your deployed Apps Script Web App
     URL (ends in /exec). */
window.EVENT_APP_CONFIG = {
  // Default: same-origin /api (works when served by demo-server/server.js).
  API_BASE_URL: "/api",
};
