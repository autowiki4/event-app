/* Thin fetch wrapper around the backend API. Same shape works against
   demo-server/server.js (Express + JSON file) or apps-script/Code.gs
   (Google Apps Script Web App) — only EVENT_APP_CONFIG.API_BASE_URL changes. */
const EventAPI = (function () {
  function base() {
    return window.EVENT_APP_CONFIG.API_BASE_URL;
  }

  async function parseResponse(action, res) {
    let data;
    try {
      data = await res.json();
    } catch (e) {
      const err = new Error(action + " returned an invalid response.");
      err.code = "INVALID_RESPONSE";
      err.status = res.status;
      throw err;
    }
    if (!res.ok || (data && data.error)) {
      const err = new Error((data && data.error) || (action + " failed: " + res.status));
      err.code = (data && data.code) || "REQUEST_FAILED";
      err.status = res.status;
      throw err;
    }
    return data;
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
    return parseResponse(action, res);
  }

  return {
    registerAttendee: (attendeeId, name) => call("registerAttendee", { attendeeId, name }),
    confirmWristband: (attendeeId) => call("confirmWristband", { attendeeId }),
    findOrRegisterByPhone: (attendeeId, phone, name, options) => call("findOrRegisterByPhone", {
      attendeeId,
      phone,
      name,
      ...(options || {}),
    }),
    boothCheckin: (data) => call("boothCheckin", data),
    submitSignup: (data) => call("submitSignup", data),
    confirmSignupInPerson: (signupId, confirmedBy, organizerKey) => call("confirmSignupInPerson", {
      signupId,
      confirmedBy,
      organizerKey,
    }),
    dashboardData: (organizerKey) => call("dashboardData", { organizerKey }),
    verifyOrganizer: (organizerKey) => call("verifyOrganizer", { organizerKey }),
    resetDemo: (organizerKey) => call("resetDemo", { organizerKey }),
    myCheckins: (attendeeId) => call("myCheckins", { attendeeId: attendeeId || "" }),
  };
})();
