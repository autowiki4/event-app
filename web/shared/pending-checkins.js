/* Durable two-minute retry queue for booth completion taps. The attendee may
 * tap Finish during the final seconds of a session and lose connectivity just
 * as every other phone is saving. Staging the idempotent check-in locally lets
 * the app retry after the visible booth window closes without reopening it. */
const PendingCheckins = (() => {
  const STORAGE_KEY = "eventapp.pending-booth-checkins.v1";
  const MAX_AGE_MS = 2 * 60 * 1000;
  const FIRST_RETRY_MS = 2500;
  const RETRY_INTERVAL_MS = 5000;
  let memoryEntries = [];
  const retryLoops = new Map();

  function read() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return memoryEntries.slice();
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return memoryEntries.slice();
    }
  }

  function write(entries) {
    memoryEntries = entries.slice();
    try {
      if (entries.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (error) { /* memory fallback remains available */ }
  }

  function entryKey(payload) {
    return `${String(payload && payload.attendeeId || "")}:${String(payload && payload.boothId || "")}`;
  }

  function freshEntries(entries, now = Date.now()) {
    return entries.filter((entry) => (
      entry && entry.payload && entryKey(entry.payload) !== ":"
      && Number.isFinite(Number(entry.queuedAt))
      && now - Number(entry.queuedAt) <= MAX_AGE_MS
    ));
  }

  function entryToken(entry) {
    if (entry && entry.queueId) return String(entry.queueId);
    return `${entryKey(entry && entry.payload)}:${Number(entry && entry.queuedAt) || 0}:${JSON.stringify(entry && entry.payload || {})}`;
  }

  function attendeePendingCount(attendeeId, entries = freshEntries(read())) {
    const attendeeKey = String(attendeeId || "");
    return entries.filter((entry) => String(entry.payload.attendeeId || "") === attendeeKey).length;
  }

  function stage(payload) {
    const key = entryKey(payload);
    if (key === ":") return null;
    const entries = freshEntries(read()).filter((entry) => entryKey(entry.payload) !== key);
    const queuedAt = Date.now();
    const queueId = `${queuedAt}-${Math.random().toString(36).slice(2)}`;
    entries.push({ payload, queuedAt, queueId });
    write(entries.slice(-6));
    // Schedule a no-op-safe retry immediately. A normal request removes the
    // item before this fires; a hung or failed request gets repeated without
    // relying on another tap, focus event, or page reload.
    retry(payload.attendeeId);
    return queueId;
  }

  function remove(payload, queueId) {
    const key = entryKey(payload);
    write(freshEntries(read()).filter((entry) => (
      entryKey(entry.payload) !== key || (queueId && entryToken(entry) !== String(queueId))
    )));
  }

  async function flush(attendeeId) {
    const attendeeKey = String(attendeeId || "");
    const entries = freshEntries(read());
    const completedBoothIds = [];
    const succeededTokens = new Set();
    for (const entry of entries) {
      if (String(entry.payload.attendeeId || "") !== attendeeKey) continue;
      try {
        await EventAPI.boothCheckin(entry.payload);
        completedBoothIds.push(entry.payload.boothId);
        succeededTokens.add(entryToken(entry));
      } catch (error) { /* keep the latest queued version for another attempt */ }
    }
    // Re-read after awaiting the network. This preserves any new completion
    // staged while an older request was in flight and only removes the exact
    // queue revisions that the backend accepted.
    const remaining = freshEntries(read()).filter((entry) => !succeededTokens.has(entryToken(entry)));
    write(remaining);
    return {
      completedBoothIds,
      pendingCount: remaining.length,
      attendeePendingCount: attendeePendingCount(attendeeKey, remaining),
    };
  }

  function retry(attendeeId, onResult) {
    const attendeeKey = String(attendeeId || "");
    if (!attendeeKey || !attendeePendingCount(attendeeKey)) return false;
    let state = retryLoops.get(attendeeKey);
    if (state) {
      if (typeof onResult === "function") state.onResult = onResult;
      return true;
    }

    state = { timer: null, onResult: typeof onResult === "function" ? onResult : null };
    const attempt = async () => {
      state.timer = null;
      const result = await flush(attendeeKey);
      if (state.onResult) {
        try { state.onResult(result); } catch (error) { console.error(error); }
      }
      if (result.attendeePendingCount > 0) {
        state.timer = setTimeout(attempt, RETRY_INTERVAL_MS);
      } else {
        retryLoops.delete(attendeeKey);
      }
    };
    state.timer = setTimeout(attempt, FIRST_RETRY_MS);
    retryLoops.set(attendeeKey, state);
    return true;
  }

  return { stage, remove, flush, retry };
})();
