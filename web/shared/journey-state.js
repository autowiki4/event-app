/* Small per-attendee draft store for refresh/reopen resilience. Canonical
 * completion still lives on the backend; this only keeps unfinished UI state
 * (current question/beat, typed reflections, ratings, and Phase 3 ticks) on
 * the attendee's own device. */
const JourneyState = (() => {
  const PREFIX = "eventapp.journey.v1";
  const memory = new Map();

  function attendeeId() {
    const identity = typeof Identity !== "undefined" && Identity.peek ? Identity.peek() : {};
    return String(identity.attendeeId || "");
  }

  function key(scope, explicitAttendeeId) {
    const owner = String(explicitAttendeeId || attendeeId());
    const name = String(scope || "").trim();
    return owner && name ? `${PREFIX}.${encodeURIComponent(owner)}.${encodeURIComponent(name)}` : "";
  }

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { return value; }
  }

  function load(scope, fallback) {
    const storageKey = key(scope);
    if (!storageKey) return clone(fallback);
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return memory.has(storageKey) ? clone(memory.get(storageKey)) : clone(fallback);
      const parsed = JSON.parse(raw);
      memory.set(storageKey, parsed);
      return clone(parsed);
    } catch (error) {
      return memory.has(storageKey) ? clone(memory.get(storageKey)) : clone(fallback);
    }
  }

  function save(scope, value) {
    const storageKey = key(scope);
    if (!storageKey) return false;
    const snapshot = clone(value);
    memory.set(storageKey, snapshot);
    try { localStorage.setItem(storageKey, JSON.stringify(snapshot)); }
    catch (error) { /* memory fallback lasts for this page */ }
    return true;
  }

  function remove(scope) {
    const storageKey = key(scope);
    if (!storageKey) return;
    memory.delete(storageKey);
    try { localStorage.removeItem(storageKey); } catch (error) { /* optional */ }
  }

  return { load, save, remove };
})();
