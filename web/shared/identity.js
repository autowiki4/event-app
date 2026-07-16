/* The attendee's own phone remembers who they are across pages/booths via
   localStorage. Kiosk/staff devices should NOT rely on this (each visitor
   is a different person) — kiosk pages ask for a phone number every time
   instead, see identity.lookupByPhone() usage in kiosk-*.html. */
const Identity = (function () {
  const KEY = "eventapp.identity";
  let memoryIdentity = {};
  let storageWritable = null;

  function copy(data) {
    return Object.assign({}, data || {});
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return copy(memoryIdentity);
      memoryIdentity = JSON.parse(raw);
      storageWritable = true;
      return copy(memoryIdentity);
    } catch (e) {
      storageWritable = false;
      return copy(memoryIdentity);
    }
  }

  function save(data) {
    memoryIdentity = copy(data);
    try {
      localStorage.setItem(KEY, JSON.stringify(memoryIdentity));
      storageWritable = true;
    } catch (e) {
      storageWritable = false;
    }
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
    // disk, so it must never erase the attendee's saved phone identity. Only
    // the explicit profile-menu logout path calls clear().
    if (error && error.code === "ATTENDEE_NOT_FOUND") {
      console.warn("Attendee record is temporarily unavailable; retaining device identity.", entryUrl || "");
    }
    return false;
  }

  function isPersistent() {
    return storageWritable !== false;
  }

  return { get, peek, set, replace, clear, restartIfMissing, isPersistent };
})();
