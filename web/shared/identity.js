/* The attendee's own phone remembers who they are across pages/booths via
   localStorage, a tab-level mirror, and an attendee-id recovery cookie.
   Kiosk/staff devices should NOT rely on this (each visitor
   is a different person) — kiosk pages ask for a phone number every time
   instead, see identity.lookupByPhone() usage in kiosk-*.html. */
const Identity = (function () {
  const KEY = "eventapp.identity";
  const COOKIE_KEY = "eventapp_attendee_id";
  let memoryIdentity = {};
  let localStorageWritable = null;
  let sessionStorageWritable = null;

  function copy(data) {
    return Object.assign({}, data || {});
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function parsedIdentity(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function cookieAttendeeId() {
    try {
      const prefix = `${COOKIE_KEY}=`;
      const part = String(document.cookie || "").split("; ").find((entry) => entry.startsWith(prefix));
      return part ? decodeURIComponent(part.slice(prefix.length)) : "";
    } catch (error) {
      return "";
    }
  }

  function writeRecoveryCookie(attendeeId) {
    if (!attendeeId) return;
    try {
      const secure = window.location && window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${COOKIE_KEY}=${encodeURIComponent(String(attendeeId))}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
    } catch (error) { /* some embedded browsers block cookies too */ }
  }

  function clearRecoveryCookie() {
    try {
      document.cookie = `${COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
    } catch (error) { /* best effort */ }
  }

  function load() {
    let stored = null;
    try {
      stored = parsedIdentity(localStorage.getItem(KEY));
      localStorageWritable = true;
    } catch (e) {
      localStorageWritable = false;
    }
    if (!stored) {
      try {
        stored = parsedIdentity(sessionStorage.getItem(KEY));
        sessionStorageWritable = true;
      } catch (e) {
        sessionStorageWritable = false;
      }
    }
    if (!stored && memoryIdentity.attendeeId) stored = memoryIdentity;
    if (!stored) {
      const attendeeId = cookieAttendeeId();
      if (attendeeId) stored = { attendeeId };
    }
    memoryIdentity = copy(stored || {});
    return copy(memoryIdentity);
  }

  function save(data) {
    memoryIdentity = copy(data);
    const serialized = JSON.stringify(memoryIdentity);
    try {
      localStorage.setItem(KEY, serialized);
      localStorageWritable = true;
    } catch (e) {
      localStorageWritable = false;
    }
    try {
      sessionStorage.setItem(KEY, serialized);
      sessionStorageWritable = true;
    } catch (e) {
      sessionStorageWritable = false;
    }
    writeRecoveryCookie(memoryIdentity.attendeeId);
  }

  function get() {
    const data = load();
    if (!data.attendeeId) {
      data.attendeeId = uuid();
      save(data);
    }
    return data;
  }

  function peek() {
    return load();
  }

  function set(patch) {
    const data = load();
    Object.assign(data, patch);
    save(data);
    return data;
  }

  function replace(data) {
    save(Object.assign({}, data));
    return load();
  }

  function clear() {
    const current = load();
    const journeyPrefix = current.attendeeId
      ? `eventapp.journey.v1.${encodeURIComponent(String(current.attendeeId))}.`
      : "";
    if (journeyPrefix) {
      try {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const storageKey = localStorage.key(index);
          if (storageKey && storageKey.startsWith(journeyPrefix)) localStorage.removeItem(storageKey);
        }
      } catch (e) { /* storage may be unavailable in an embedded QR browser */ }
    }
    try { localStorage.removeItem(KEY); } catch (e) { /* best effort on restricted browsers */ }
    try { sessionStorage.removeItem(KEY); } catch (e) { /* best effort */ }
    clearRecoveryCookie();
    memoryIdentity = {};
    try {
      sessionStorage.removeItem("eventapp.portal.phase2");
      ["heaven", "trivia", "story", "art", "newsong"].forEach((boothId) => {
        sessionStorage.removeItem(`eventapp.portal.phase2.${boothId}`);
      });
      sessionStorage.removeItem("eventapp.portal.phase3");
      sessionStorage.removeItem("eventapp.chosen");
    } catch (e) { /* session storage is optional */ }
  }

  function restartIfMissing(error, entryUrl) {
    // Kept as a compatibility helper for existing catch blocks. A missing
    // backend record can be caused by a brief outage or an unmounted Render
    // disk, so it must never erase the attendee's saved identity. Only an
    // explicit profile-menu logout or the organizer's deliberate event reset
    // calls clear().
    if (error && error.code === "ATTENDEE_NOT_FOUND") {
      console.warn("Attendee record is temporarily unavailable; retaining device identity.", entryUrl || "");
    }
    return false;
  }

  function isPersistent() {
    return localStorageWritable !== false || sessionStorageWritable !== false || Boolean(cookieAttendeeId());
  }

  return { get, peek, set, replace, clear, restartIfMissing, isPersistent };
})();
