/* The unified journey shares one persistent attendee identity. Tab-level
 * markers are optional fast-path hints only; refresh/reopen recovery uses the
 * saved identity even when sessionStorage was cleared by a mobile browser. */
const AttendeePortal = (() => {
  const DATA_RESET_KEY = "eventapp.data-reset-at";
  let memoryDataResetAt = null;
  let resetRedirecting = false;

  function acceptDataReset(dataResetAt) {
    const marker = typeof dataResetAt === "string" ? dataResetAt.trim() : "";
    if (!marker) return false;
    memoryDataResetAt = marker;
    try { localStorage.setItem(DATA_RESET_KEY, marker); } catch (error) { /* in-memory fallback remains */ }
    return true;
  }

  function rememberDataReset(event) {
    const dataResetAt = event && event.detail && typeof event.detail.dataResetAt === "string"
      ? event.detail.dataResetAt.trim()
      : "";
    if (!dataResetAt || resetRedirecting) return;

    let previous = memoryDataResetAt;
    try {
      previous = localStorage.getItem(DATA_RESET_KEY) || previous;
    } catch (error) {
      // Restricted embedded browsers use the in-memory baseline for the
      // current page. A normal browser also persists it across reopen.
    }
    acceptDataReset(dataResetAt);
    if (!previous || previous === dataResetAt || !Identity.peek().attendeeId) return;

    // This is the deliberate organizer reset, not ordinary missing-backend
    // recovery. Connected attendee devices return to a clean registration so
    // a rehearsal can genuinely start again.
    resetRedirecting = true;
    try { localStorage.removeItem("eventapp.pending-booth-checkins.v1"); } catch (error) { /* best effort */ }
    Identity.clear();
    const entryUrl = "/phase1-entry/index.html?eventReset=1";
    if (window.location && typeof window.location.replace === "function") window.location.replace(entryUrl);
    else window.location.href = entryUrl;
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("eventapp:data-reset", rememberDataReset);
  }
  // EventSchedule normally finishes its first network sample after this file
  // loads and announces it through the listener above. If a cached/very fast
  // sample already completed, consume its state here so Phase 1 cannot resume
  // an identity that the organizer deliberately reset.
  if (typeof EventSchedule !== "undefined" && typeof EventSchedule.demoClockState === "function") {
    const existingClockState = EventSchedule.demoClockState();
    if (existingClockState && existingClockState.available) {
      rememberDataReset({ detail: { dataResetAt: existingClockState.dataResetAt } });
    }
  }

  function markerKey(portal) {
    return `eventapp.portal.${portal}`;
  }

  function backendPortal(portal) {
    return String(portal || "").startsWith("phase2.") ? "phase2" : portal;
  }

  function hasAccess(portal) {
    const identity = Identity.peek();
    if (!identity.attendeeId) return false;
    try {
      return sessionStorage.getItem(markerKey(portal)) === identity.attendeeId;
    } catch (e) {
      return false;
    }
  }

  function setAccess(portal, attendeeId) {
    try { sessionStorage.setItem(markerKey(portal), attendeeId); } catch (e) { /* optional tab session */ }
  }

  function clearAccess(portal) {
    try { sessionStorage.removeItem(markerKey(portal)); } catch (e) { /* optional tab session */ }
  }

  function saveSession(result, previous, requestStartedMs, responseReceivedMs, submittedPhone) {
    acceptDataReset(result.dataResetAt);
    if (result.serverNow && typeof EventSchedule !== "undefined" && EventSchedule.sync) {
      EventSchedule.sync(result.serverNow, requestStartedMs, responseReceivedMs);
    }
    const sameAttendee = previous.attendeeId === result.attendeeId;
    if (!sameAttendee) {
      try { sessionStorage.removeItem("eventapp.chosen"); } catch (e) { /* optional recap state */ }
    }
    const loginPhone = String(submittedPhone || "").replace(/\D/g, "").slice(0, 10);
    const savedPhone = loginPhone || (sameAttendee ? previous.phone || "" : "");
    return Identity.replace({
      attendeeId: result.attendeeId,
      name: result.name,
      raffleNumber: String(result.raffleNumber),
      wristbandColor: result.wristbandColor || (sameAttendee ? previous.wristbandColor || "" : ""),
      phone: savedPhone,
      phoneLinked: !!result.phoneLinked || savedPhone.length === 10,
      phoneVerified: result.phoneVerified !== false && (!!result.phoneLinked || savedPhone.length === 10),
      email: sameAttendee ? previous.email || "" : "",
    });
  }

  async function signIn(portal, name, phone) {
    const previous = Identity.peek();
    const requestStartedMs = Date.now();
    const result = await EventAPI.loginAttendee(name, phone, backendPortal(portal));
    const identity = saveSession(result, previous, requestStartedMs, Date.now(), phone);
    setAccess(portal, identity.attendeeId);
    return identity;
  }

  async function restore(portal) {
    if (!hasAccess(portal)) {
      const error = new Error("Portal sign-in required.");
      error.code = "PORTAL_LOGIN_REQUIRED";
      throw error;
    }
    const previous = Identity.peek();
    const requestStartedMs = Date.now();
    const result = await EventAPI.attendeePortalSession(previous.attendeeId, backendPortal(portal));
    const identity = saveSession(result, previous, requestStartedMs, Date.now());
    setAccess(portal, identity.attendeeId);
    return identity;
  }

  async function continueAs(portal) {
    const previous = Identity.peek();
    if (!previous.attendeeId) {
      const error = new Error("Attendee registration is required.");
      error.code = "PORTAL_LOGIN_REQUIRED";
      throw error;
    }
    const requestStartedMs = Date.now();
    const result = await EventAPI.attendeePortalSession(previous.attendeeId, backendPortal(portal));
    const identity = saveSession(result, previous, requestStartedMs, Date.now());
    setAccess(portal, identity.attendeeId);
    return identity;
  }

  function signOut(loginUrl) {
    Identity.clear();
    try { sessionStorage.removeItem("eventapp.chosen"); } catch (e) { /* optional recap state */ }
    window.location.href = loginUrl;
  }

  return {
    hasAccess,
    clearAccess,
    signIn,
    restore,
    continueAs,
    signOut,
    rememberDataReset,
    acceptDataReset,
  };
})();
