/* Phase 2 and Phase 3 are separate attendee portals. Each keeps its own
 * tab-level sign-in marker while sharing the canonical attendee record. */
const AttendeePortal = (() => {
  function markerKey(portal) {
    return `eventapp.portal.${portal}`;
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
    sessionStorage.setItem(markerKey(portal), attendeeId);
  }

  function saveSession(result, previous) {
    const sameAttendee = previous.attendeeId === result.attendeeId;
    if (!sameAttendee) {
      try { sessionStorage.removeItem("eventapp.chosen"); } catch (e) { /* optional recap state */ }
    }
    return Identity.replace({
      attendeeId: result.attendeeId,
      name: result.name,
      raffleNumber: String(result.raffleNumber),
      phone: sameAttendee ? previous.phone || "" : "",
      phoneLinked: !!result.phoneLinked,
      email: sameAttendee ? previous.email || "" : "",
    });
  }

  async function signIn(portal, name, raffleNumber) {
    const previous = Identity.peek();
    const result = await EventAPI.loginAttendee(name, raffleNumber, portal);
    const identity = saveSession(result, previous);
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
    const result = await EventAPI.attendeePortalSession(previous.attendeeId, portal);
    const identity = saveSession(result, previous);
    setAccess(portal, identity.attendeeId);
    return identity;
  }

  function signOut(loginUrl) {
    Identity.clear();
    try { sessionStorage.removeItem("eventapp.chosen"); } catch (e) { /* optional recap state */ }
    window.location.href = loginUrl;
  }

  return { hasAccess, signIn, restore, signOut };
})();
