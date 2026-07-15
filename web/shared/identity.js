/* The attendee's own phone remembers who they are across pages/booths via
   localStorage. Kiosk/staff devices should NOT rely on this (each visitor
   is a different person) — kiosk pages ask for a phone number every time
   instead, see identity.lookupByPhone() usage in kiosk-*.html. */
const Identity = (function () {
  const KEY = "eventapp.identity";

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function get() {
    const data = load();
    if (!data.attendeeId) {
      data.attendeeId = uuid();
      save(data);
    }
    return data;
  }

  function set(patch) {
    const data = load();
    Object.assign(data, patch);
    save(data);
    return data;
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  return { get, set, clear };
})();
