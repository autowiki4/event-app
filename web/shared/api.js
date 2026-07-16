/* Thin fetch wrapper around the backend API. Core journey actions work with
   demo-server/server.js (plain Node + JSON) or apps-script/Code.gs; the Node
   service additionally supplies the shared-clock and reset actions. */
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
    confirmWristband: (attendeeId, wristbandColor) => call("confirmWristband", { attendeeId, wristbandColor }),
    loginAttendee: (name, raffleNumber, portal) => call("loginAttendee", { name, raffleNumber, portal }),
    attendeePortalSession: (attendeeId, portal) => call("attendeePortalSession", { attendeeId, portal }),
    findOrRegisterByPhone: (attendeeId, phone, name, options) => call("findOrRegisterByPhone", {
      attendeeId,
      phone,
      name,
      ...(options || {}),
    }),
    boothCheckin: (data) => call("boothCheckin", data),
    saveSongVote: (attendeeId, songTitle) => call("saveSongVote", { attendeeId, songTitle }),
    submitSignup: (data) => call("submitSignup", data),
    saveSignupSelections: (attendeeId, optionIds) => call("saveSignupSelections", { attendeeId, optionIds }),
    confirmSignupInPerson: (signupId, confirmedBy, organizerKey) => call("confirmSignupInPerson", {
      signupId,
      confirmedBy,
      organizerKey,
    }),
    dashboardData: (organizerKey) => call("dashboardData", { organizerKey }),
    boothDashboardData: (boothId, organizerKey) => call("boothDashboardData", { boothId, organizerKey }),
    boothPresentation: (boothId) => call("boothPresentation", { boothId }),
    updateBoothPresentation: (data) => call("updateBoothPresentation", data),
    triviaState: (attendeeId) => call("triviaState", { attendeeId }),
    submitTriviaAnswer: (attendeeId, questionId, answerIndex) => call("submitTriviaAnswer", {
      attendeeId,
      questionId,
      answerIndex,
    }),
    triviaDashboardData: (organizerKey) => call("triviaDashboardData", { organizerKey }),
    advanceTriviaSession: (sessionNumber, action, version, organizerKey) => call("advanceTriviaSession", {
      sessionNumber,
      action,
      version,
      organizerKey,
    }),
    resetTriviaSession: (sessionNumber, organizerKey) => call("resetTriviaSession", {
      sessionNumber,
      organizerKey,
    }),
    completeTrivia: (attendeeId) => call("completeTrivia", { attendeeId }),
    eventClock: () => call("eventClock", {}),
    setDemoClock: (mode, targetIso, organizerKey) => call("setDemoClock", {
      mode,
      targetIso: targetIso || null,
      organizerKey,
    }),
    setDemoClockAt: (targetIso, organizerKey) => call("setDemoClock", {
      mode: "custom",
      targetIso: targetIso || null,
      organizerKey,
    }),
    verifyOrganizer: (organizerKey) => call("verifyOrganizer", { organizerKey }),
    resetDemo: (organizerKey) => call("resetDemo", { organizerKey }),
    myCheckins: (attendeeId) => call("myCheckins", { attendeeId: attendeeId || "" }),
    mySignupSelections: (attendeeId) => call("mySignupSelections", { attendeeId: attendeeId || "" }),
  };
})();
