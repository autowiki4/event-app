/* Thin fetch wrapper around the backend API. Same shape works against
   demo-server/server.js (Express + JSON file) or apps-script/Code.gs
   (Google Apps Script Web App) — only EVENT_APP_CONFIG.API_BASE_URL changes. */
const EventAPI = (function () {
  function base() {
    return window.EVENT_APP_CONFIG.API_BASE_URL;
  }

  async function call(action, payload) {
    const url = base() + "/" + action;
    const isAppsScript = base().includes("script.google.com");
    const res = await fetch(url, {
      method: "POST",
      // Apps Script Web Apps choke on custom Content-Type headers with
      // simple requests; text/plain avoids an extra CORS preflight.
      headers: { "Content-Type": isAppsScript ? "text/plain;charset=utf-8" : "application/json" },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error(action + " failed: " + res.status);
    return res.json();
  }

  async function get(action, query) {
    const q = query ? "?" + new URLSearchParams(query).toString() : "";
    const res = await fetch(base() + "/" + action + q, { method: "GET" });
    if (!res.ok) throw new Error(action + " failed: " + res.status);
    return res.json();
  }

  return {
    registerAttendee: (attendeeId, name) => call("registerAttendee", { attendeeId, name }),
    confirmWristband: (attendeeId) => call("confirmWristband", { attendeeId }),
    findOrRegisterByPhone: (attendeeId, phone, name) => call("findOrRegisterByPhone", { attendeeId, phone, name }),
    boothCheckin: (data) => call("boothCheckin", data),
    submitSignup: (data) => call("submitSignup", data),
    confirmSignupInPerson: (signupId, confirmedBy) => call("confirmSignupInPerson", { signupId, confirmedBy }),
    dashboardData: () => get("dashboardData"),
    myCheckins: (attendeeId, phone) => get("myCheckins", { attendeeId: attendeeId || "", phone: phone || "" }),
  };
})();
