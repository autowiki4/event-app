/* One place to point every page at the backend.
   - For the Node service locally or on Render: leave this as same-origin /api,
     and open these HTML files through that same service so relative fetches to
     /api/* reach its backend.
   - The synchronized Bible Bowl controller and shared rehearsal clock require
     the same-origin Node service. The Apps Script URL option supports the core
     journey only and does not implement those live-control actions. */
window.EVENT_APP_CONFIG = {
  // Default: same-origin /api from demo-server/server.js locally or on Render.
  API_BASE_URL: "/api",
};
