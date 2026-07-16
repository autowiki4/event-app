/* Shared, timezone-safe event clock. The schedule timestamps in
 * booths-config.js contain Nashville's event-day UTC offset. A backend
 * response can periodically call sync() so phones count from server time;
 * between syncs the countdown runs locally without extra requests.
 */
const EventSchedule = (() => {
  const DEMO_CLOCK_MODES = new Set([
    "live",
    "before",
    "session1",
    "session2",
    "session3",
    "session1-final15",
    "session2-final15",
    "session3-final15",
    "ended",
  ]);
  let serverOffsetMs = 0;
  let lastSyncedAt = null;
  let remoteDemoClock = {
    available: false,
    controlled: false,
    mode: "live",
    targetIso: null,
    updatedAt: null,
  };
  let demoClockPollTimer = null;
  let demoClockRequest = null;
  let demoClockFirstSync = null;

  function sync(serverNow, requestStartedMs, responseReceivedMs, options) {
    // Once the organizer has selected a shared demo mode, only the versioned
    // eventClock response may move the clock. A slower attendee/presentation
    // request may have been created before the organizer changed time and
    // must not briefly reopen the wrong booth when it arrives afterward.
    if (remoteDemoClock.controlled && !(options && options.demoClock === true)) return false;
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
    if (remoteDemoClock.controlled) return Date.now() + serverOffsetMs;
    const preview = previewOverride();
    return preview === null ? Date.now() + serverOffsetMs : preview;
  }

  function demoBackendAvailable() {
    if (typeof window === "undefined" || !window.EVENT_APP_CONFIG) return false;
    if (String(window.EVENT_APP_CONFIG.API_BASE_URL || "").replace(/\/$/, "") !== "/api") return false;
    return typeof EventAPI !== "undefined" && EventAPI && typeof EventAPI.eventClock === "function";
  }

  function demoTargetIso(modeValue) {
    const mode = String(modeValue || "").trim().toLowerCase();
    if (!DEMO_CLOCK_MODES.has(mode)) return null;
    if (mode === "live") return null;
    if (typeof BOOTH_SESSIONS === "undefined" || !Array.isArray(BOOTH_SESSIONS) || !BOOTH_SESSIONS.length) {
      return null;
    }

    const firstStartMs = new Date(BOOTH_SESSIONS[0].startsAt).getTime();
    const lastEndMs = new Date(BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1].endsAt).getTime();
    let targetMs = NaN;
    if (mode === "before") targetMs = firstStartMs - (5 * 60 * 1000);
    if (mode === "ended") targetMs = lastEndMs + (60 * 1000);

    const sessionMatch = /^session([123])(-final15)?$/.exec(mode);
    if (sessionMatch) {
      const session = BOOTH_SESSIONS[Number(sessionMatch[1]) - 1];
      if (!session) return null;
      targetMs = sessionMatch[2]
        ? new Date(session.endsAt).getTime() - (15 * 1000)
        : new Date(session.startsAt).getTime() + (5 * 60 * 1000);
    }
    return Number.isFinite(targetMs) ? new Date(targetMs).toISOString() : null;
  }

  function incomingClockIsOlder(data) {
    if (!remoteDemoClock.available || !remoteDemoClock.updatedAt) return false;
    if (!data.updatedAt) return true;
    const currentUpdatedMs = Date.parse(remoteDemoClock.updatedAt);
    const incomingUpdatedMs = Date.parse(data.updatedAt);
    return Number.isFinite(currentUpdatedMs)
      && Number.isFinite(incomingUpdatedMs)
      && incomingUpdatedMs < currentUpdatedMs;
  }

  function applyDemoClock(data, requestStartedMs, responseReceivedMs) {
    if (!data || typeof data !== "object") return false;
    const mode = String(data.mode || "").trim().toLowerCase();
    if (!DEMO_CLOCK_MODES.has(mode) || incomingClockIsOlder(data)) return false;
    if (!sync(data.serverNow, requestStartedMs, responseReceivedMs, { demoClock: true })) return false;
    remoteDemoClock = {
      available: true,
      controlled: data.controlled === true,
      mode,
      targetIso: data.targetIso || null,
      updatedAt: data.updatedAt || null,
    };
    return true;
  }

  function demoClockState() {
    return {
      ...remoteDemoClock,
      syncing: demoClockRequest !== null,
      syncAgeMs: syncAgeMs(),
    };
  }

  function refreshDemoClock() {
    if (!demoBackendAvailable()) return Promise.resolve(demoClockState());
    if (demoClockRequest) return demoClockRequest;
    const requestStartedMs = Date.now();
    let request;
    request = EventAPI.eventClock()
      .then((data) => {
        applyDemoClock(data, requestStartedMs, Date.now());
      })
      .finally(() => {
        if (demoClockRequest === request) demoClockRequest = null;
      })
      .then(() => demoClockState());
    demoClockRequest = request;
    return request;
  }

  function startDemoClockSync(intervalMs = 1000) {
    if (!demoBackendAvailable()) return Promise.resolve(demoClockState());
    const requestedInterval = Number(intervalMs);
    const pollingInterval = Number.isFinite(requestedInterval)
      ? Math.max(250, requestedInterval)
      : 1000;
    if (demoClockPollTimer === null && typeof setInterval === "function") {
      demoClockPollTimer = setInterval(() => {
        refreshDemoClock().catch(() => {});
      }, pollingInterval);
    }
    if (!demoClockFirstSync) {
      demoClockFirstSync = refreshDemoClock();
      demoClockFirstSync.catch(() => {
        demoClockFirstSync = null;
      });
    }
    return demoClockFirstSync;
  }

  function stopDemoClockSync() {
    if (demoClockPollTimer !== null && typeof clearInterval === "function") {
      clearInterval(demoClockPollTimer);
    }
    demoClockPollTimer = null;
    demoClockFirstSync = null;
  }

  function isPreviewing() {
    if (remoteDemoClock.controlled) return remoteDemoClock.mode !== "live";
    return previewOverride() !== null;
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

  function deriveBoothStop(sessionIndex, visited, state) {
    const snapshot = state || current();
    const index = Number(sessionIndex);
    const isCurrent = snapshot.phase === "active" && snapshot.sessionIndex === index;
    if (visited) {
      return { kind: "visited", canOpen: isCurrent, faded: true, checked: true };
    }
    if (isCurrent) {
      return { kind: "active", canOpen: true, faded: false, checked: false };
    }
    const isPast = snapshot.phase === "ended"
      || (snapshot.phase === "active" && index < snapshot.sessionIndex);
    if (isPast) {
      return { kind: "expired", canOpen: false, faded: true, checked: false };
    }
    return { kind: "locked", canOpen: false, faded: true, checked: false };
  }

  function canOpenBooth(colorId, boothId, state) {
    const snapshot = state || current();
    if (!snapshot || snapshot.phase !== "active") return false;
    return route(colorId)[snapshot.sessionIndex] === boothId;
  }

  function isEndingSoon(state, thresholdMs = 15000) {
    const snapshot = state || current();
    const threshold = Number(thresholdMs);
    return Boolean(
      snapshot
      && snapshot.phase === "active"
      && Number.isFinite(snapshot.remainingMs)
      && snapshot.remainingMs > 0
      && Number.isFinite(threshold)
      && threshold >= 0
      && snapshot.remainingMs <= threshold
    );
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

  function eventEndsAtMs() {
    const last = BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1];
    return last ? new Date(last.endsAt).getTime() : NaN;
  }

  function remainingUntilEventEnd() {
    const targetMs = eventEndsAtMs();
    return Number.isFinite(targetMs) ? Math.max(0, targetMs - nowMs()) : 0;
  }

  function linkWithPreview(url) {
    if (typeof window === "undefined" || !window.location) return url;
    if (remoteDemoClock.controlled) return url;
    const hostname = String(window.location.hostname || "").toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return url;
    const preview = new URLSearchParams(window.location.search).get("preview");
    if (!preview) return url;
    const destination = new URL(url, window.location.href);
    destination.searchParams.set("preview", preview);
    return `${destination.pathname}${destination.search}${destination.hash}`;
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
    deriveBoothStop,
    canOpenBooth,
    isEndingSoon,
    groupForBooth,
    formatCountdown,
    formattedTime,
    eventEndsAtMs,
    remainingUntilEventEnd,
    linkWithPreview,
    syncAgeMs,
    applyDemoClock,
    demoTargetIso,
    demoClockState,
    refreshDemoClock,
    startDemoClockSync,
    stopDemoClockSync,
    isPreviewing,
  };
})();

// Every local-demo page joins the server-shared clock automatically. Apps
// Script and other API bases never call these demo-only endpoints.
if (typeof window !== "undefined") {
  EventSchedule.startDemoClockSync(1000).catch(() => {});
}
