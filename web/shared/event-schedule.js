/* Shared, timezone-safe event clock. The schedule timestamps in
 * booths-config.js contain Nashville's event-day UTC offset. A backend
 * response can periodically call sync() so phones count from server time;
 * between syncs the countdown runs locally without extra requests.
 */
const EventSchedule = (() => {
  let serverOffsetMs = 0;
  let lastSyncedAt = null;

  function sync(serverNow, requestStartedMs, responseReceivedMs) {
    const serverMs = new Date(serverNow).getTime();
    if (!Number.isFinite(serverMs)) return false;
    const received = Number.isFinite(responseReceivedMs) ? responseReceivedMs : Date.now();
    const started = Number.isFinite(requestStartedMs) ? requestStartedMs : received;
    serverOffsetMs = serverMs - ((started + received) / 2);
    lastSyncedAt = received;
    return true;
  }

  function previewOverride() {
    if (typeof window === "undefined" || !window.location) return null;
    const hostname = String(window.location.hostname || "").toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return null;
    const preview = new URLSearchParams(window.location.search).get("preview");
    const firstStart = new Date(BOOTH_SESSIONS[0].startsAt).getTime();
    const lastEnd = new Date(BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1].endsAt).getTime();
    const values = {
      before: firstStart - (5 * 60 * 1000),
      "1": firstStart + (5 * 60 * 1000),
      "2": new Date(BOOTH_SESSIONS[1].startsAt).getTime() + (5 * 60 * 1000),
      "3": new Date(BOOTH_SESSIONS[2].startsAt).getTime() + (5 * 60 * 1000),
      ended: lastEnd + (60 * 1000),
    };
    return Object.prototype.hasOwnProperty.call(values, preview) ? values[preview] : null;
  }

  function nowMs() {
    const preview = previewOverride();
    return preview === null ? Date.now() + serverOffsetMs : preview;
  }

  function stateAt(value) {
    const valueMs = value instanceof Date ? value.getTime() : Number(value);
    const currentMs = Number.isFinite(valueMs) ? valueMs : nowMs();
    const sessions = BOOTH_SESSIONS.map((session, index) => ({
      ...session,
      index,
      startMs: new Date(session.startsAt).getTime(),
      endMs: new Date(session.endsAt).getTime(),
    }));
    const first = sessions[0];
    const last = sessions[sessions.length - 1];

    if (currentMs < first.startMs) {
      return {
        phase: "before",
        nowMs: currentMs,
        session: null,
        sessionIndex: null,
        targetMs: first.startMs,
        remainingMs: first.startMs - currentMs,
        nextSession: first,
      };
    }

    const active = sessions.find((session) => currentMs >= session.startMs && currentMs < session.endMs);
    if (active) {
      return {
        phase: "active",
        nowMs: currentMs,
        session: active,
        sessionIndex: active.index,
        targetMs: active.endMs,
        remainingMs: active.endMs - currentMs,
        nextSession: sessions[active.index + 1] || null,
      };
    }

    return {
      phase: "ended",
      nowMs: currentMs,
      session: null,
      sessionIndex: null,
      targetMs: last.endMs,
      remainingMs: 0,
      nextSession: null,
    };
  }

  function current() {
    return stateAt(nowMs());
  }

  function route(colorId) {
    return routeForWristband(colorId).slice();
  }

  function boothFor(colorId, sessionIndex) {
    const boothId = route(colorId)[sessionIndex];
    return boothId ? boothById(boothId) : null;
  }

  function currentBooth(colorId, state) {
    const snapshot = state || current();
    if (snapshot.phase === "before") return boothFor(colorId, 0);
    if (snapshot.phase !== "active") return null;
    return boothFor(colorId, snapshot.sessionIndex);
  }

  function groupForBooth(boothId, sessionIndex) {
    return wristbandForBoothSession(boothId, sessionIndex);
  }

  function formatCountdown(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
    return [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function formattedTime(isoValue) {
    const date = new Date(isoValue);
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
    }).format(date);
  }

  function syncAgeMs() {
    return lastSyncedAt === null ? null : Math.max(0, Date.now() - lastSyncedAt);
  }

  return {
    sync,
    nowMs,
    stateAt,
    current,
    route,
    boothFor,
    currentBooth,
    groupForBooth,
    formatCountdown,
    formattedTime,
    syncAgeMs,
  };
})();
