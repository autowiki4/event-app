/* One place to point every page at the backend.
   - For the Node service locally or on Render: leave this as same-origin /api,
     and open these HTML files through that same service so relative fetches to
     /api/* reach its backend.
   - For the real event: replace API_BASE_URL with your deployed Apps Script Web App
     URL (ends in /exec). */
window.EVENT_APP_CONFIG = {
  // Default: same-origin /api from demo-server/server.js locally or on Render.
  API_BASE_URL: "/api",
};
