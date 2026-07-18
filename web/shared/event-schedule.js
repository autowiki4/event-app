/* Shared, timezone-safe event clock. The schedule timestamps in
 * booths-config.js contain Nashville's event-day UTC offset. A backend
 * response can periodically call sync() so phones count from server time;
 * between syncs the countdown runs locally without extra requests.
 */
const EventSchedule = (() => {
  const LATE_JOIN_MINIMUM_MS = 5 * 60 * 1000;
  const DEMO_CLOCK_MODES = new Set([
    "live",
    "custom",
    "before",
    "session1-start",
    "session1",
    "session2",
    "session1-final15",
    "session2-final15",
    "message",
    "extra",
    "extra-booth",
    "session3",
    "extra-final15",
    "session3-final15",
    "connections",
    // Compatibility aliases retained for existing organizer bookmarks/tests.
    "waiting",
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
    dataResetAt: "initial",
  };
  let demoClockPollTimer = null;
  let demoClockRequest = null;
  let demoClockFirstSync = null;
  let demoClockVisibilityBound = false;
  let lastDemoClockSampleMs = null;

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
    const messageStart = messageStartsAtMs();
    const messageEnd = messageEndsAtMs();
    const extraStart = extraBoothStartsAtMs();
    const eventEnd = eventEndsAtMs();
    const values = {
      before: firstStart - (5 * 60 * 1000),
      "1": firstStart + (5 * 60 * 1000),
      "2": new Date(BOOTH_SESSIONS[1].startsAt).getTime() + (5 * 60 * 1000),
      message: messageStart + (5 * 60 * 1000),
      waiting: messageStart + (5 * 60 * 1000),
      "3": extraStart + (5 * 60 * 1000),
      extra: extraStart + (5 * 60 * 1000),
      "extra-booth": extraStart + (5 * 60 * 1000),
      connections: eventEnd,
      ended: eventEnd,
    };
    if (!Object.prototype.hasOwnProperty.call(values, preview)) return null;
    const previewMs = values[preview];
    return preview === "message" || preview === "waiting"
      ? Math.min(previewMs, messageEnd - 1000)
      : previewMs;
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

  function demoTargetIso(modeValue, customValue) {
    const mode = String(modeValue || "").trim().toLowerCase();
    if (!DEMO_CLOCK_MODES.has(mode)) return null;
    if (mode === "live") return null;
    if (typeof BOOTH_SESSIONS === "undefined" || !Array.isArray(BOOTH_SESSIONS) || !BOOTH_SESSIONS.length) {
      return null;
    }

    const firstStartMs = new Date(BOOTH_SESSIONS[0].startsAt).getTime();
    const messageStartMs = messageStartsAtMs();
    const messageEndMs = messageEndsAtMs();
    const extraStartMs = extraBoothStartsAtMs();
    const eventEndMs = eventEndsAtMs();
    if (mode === "custom") {
      const customMs = customValue instanceof Date
        ? customValue.getTime()
        : typeof customValue === "number"
          ? customValue
          : Date.parse(customValue);
      return Number.isFinite(customMs) && customMs >= firstStartMs && customMs <= eventEndMs
        ? new Date(customMs).toISOString()
        : null;
    }
    let targetMs = NaN;
    if (mode === "before") targetMs = firstStartMs - (5 * 60 * 1000);
    if (mode === "session1-start") targetMs = firstStartMs;
    if (mode === "message" || mode === "waiting") {
      targetMs = Math.min(messageStartMs + (5 * 60 * 1000), messageEndMs - 1000);
    }
    if (mode === "extra" || mode === "extra-booth" || mode === "session3") {
      targetMs = extraStartMs + (5 * 60 * 1000);
    }
    if (mode === "extra-final15" || mode === "session3-final15") {
      targetMs = eventEndMs - (15 * 1000);
    }
    if (mode === "connections" || mode === "ended") targetMs = eventEndMs;

    const sessionMatch = /^session([12])(-final15)?$/.exec(mode);
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
    if (!Number.isFinite(currentUpdatedMs) || !Number.isFinite(incomingUpdatedMs)) return false;
    if (incomingUpdatedMs < currentUpdatedMs) return true;
    if (incomingUpdatedMs > currentUpdatedMs) return false;
    const incomingSampleMs = Date.parse(data.serverNow);
    return Number.isFinite(lastDemoClockSampleMs)
      && Number.isFinite(incomingSampleMs)
      && incomingSampleMs <= lastDemoClockSampleMs;
  }

  function applyDemoClock(data, requestStartedMs, responseReceivedMs) {
    if (!data || typeof data !== "object") return false;
    const mode = String(data.mode || "").trim().toLowerCase();
    if (!DEMO_CLOCK_MODES.has(mode) || incomingClockIsOlder(data)) return false;
    if (!sync(data.serverNow, requestStartedMs, responseReceivedMs, { demoClock: true })) return false;
    const dataResetAt = typeof data.dataResetAt === "string" && data.dataResetAt.trim()
      ? data.dataResetAt.trim()
      : "initial";
    const resetChanged = remoteDemoClock.dataResetAt !== dataResetAt;
    remoteDemoClock = {
      available: true,
      controlled: data.controlled === true,
      mode,
      targetIso: data.targetIso || null,
      updatedAt: data.updatedAt || null,
      dataResetAt,
    };
    lastDemoClockSampleMs = Date.parse(data.serverNow);
    if (
      typeof window !== "undefined"
      && window
      && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function"
    ) {
      window.dispatchEvent(new CustomEvent("eventapp:data-reset", {
        detail: { dataResetAt, changed: resetChanged },
      }));
    }
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

  function startDemoClockSync(intervalMs = 5000) {
    if (!demoBackendAvailable()) return Promise.resolve(demoClockState());
    const requestedInterval = Number(intervalMs);
    const pollingInterval = Number.isFinite(requestedInterval)
      ? Math.max(1000, requestedInterval)
      : 5000;
    if (demoClockPollTimer === null && typeof setInterval === "function") {
      // The displayed countdown advances locally between samples, so five
      // second network syncs remain precise while avoiding 150 phones hitting
      // the backend every second. Per-browser jitter prevents a QR-code wave
      // from turning into a synchronized request spike.
      const jitteredInterval = Math.round(pollingInterval * (0.85 + Math.random() * 0.3));
      demoClockPollTimer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        refreshDemoClock().catch(() => {});
      }, jitteredInterval);
    }
    if (!demoClockVisibilityBound && typeof document !== "undefined" && document.addEventListener) {
      demoClockVisibilityBound = true;
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshDemoClock().catch(() => {});
      });
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
    const messageEndMs = messageEndsAtMs();
    const extraStartMs = extraBoothStartsAtMs();
    const extraEndMs = extraBoothEndsAtMs();

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

    if (currentMs < messageEndMs) {
      return {
        phase: "message",
        nowMs: currentMs,
        session: null,
        sessionIndex: null,
        targetMs: messageEndMs,
        remainingMs: messageEndMs - currentMs,
        nextSession: null,
      };
    }

    if (currentMs >= extraStartMs && currentMs < extraEndMs) {
      const extraSession = {
        ...EXTRA_BOOTH_SESSION,
        index: BOOTH_SESSIONS.length,
        startMs: extraStartMs,
        endMs: extraEndMs,
      };
      return {
        phase: "extra",
        nowMs: currentMs,
        session: extraSession,
        sessionIndex: extraSession.index,
        targetMs: extraEndMs,
        remainingMs: extraEndMs - currentMs,
        nextSession: null,
      };
    }

    return {
      phase: "connections",
      nowMs: currentMs,
      session: null,
      sessionIndex: null,
      targetMs: eventEndsAtMs(),
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

  function arrivalPlan(wristbandConfirmedAt) {
    if (wristbandConfirmedAt && typeof wristbandConfirmedAt === "object") {
      const supplied = wristbandConfirmedAt;
      const firstIndex = supplied.firstEligibleSessionIndex === null
        ? null
        : Number(supplied.firstEligibleSessionIndex);
      const missedNumbers = Array.isArray(supplied.missedSessionNumbers)
        ? supplied.missedSessionNumbers
          .map(Number)
          .filter((number) => Number.isInteger(number) && number >= 1 && number <= BOOTH_SESSIONS.length)
        : [];
      if (firstIndex === null || (Number.isInteger(firstIndex) && firstIndex >= 0 && firstIndex < BOOTH_SESSIONS.length)) {
        return {
          known: Boolean(supplied.confirmedAt),
          confirmedAtMs: supplied.confirmedAt ? Date.parse(supplied.confirmedAt) : null,
          late: supplied.late === true,
          joinedInProgress: supplied.joinedInProgress === true,
          firstEligibleSessionIndex: firstIndex,
          firstEligibleSessionNumber: firstIndex === null ? null : firstIndex + 1,
          missedSessionIndices: missedNumbers.map((number) => number - 1),
          missedSessionNumbers: missedNumbers,
          minimumJoinMinutes: Number(supplied.minimumJoinMinutes) || (LATE_JOIN_MINIMUM_MS / 60000),
        };
      }
    }
    const confirmedAtMs = Date.parse(String(wristbandConfirmedAt || ""));
    const sessions = BOOTH_SESSIONS.map((session, index) => ({
      ...session,
      index,
      startMs: new Date(session.startsAt).getTime(),
      endMs: new Date(session.endsAt).getTime(),
    }));
    if (!Number.isFinite(confirmedAtMs)) {
      return {
        known: false,
        confirmedAtMs: null,
        late: false,
        joinedInProgress: false,
        firstEligibleSessionIndex: 0,
        firstEligibleSessionNumber: 1,
        missedSessionIndices: [],
        missedSessionNumbers: [],
        minimumJoinMinutes: LATE_JOIN_MINIMUM_MS / 60000,
      };
    }
    const firstEligibleSessionIndex = sessions.findIndex((session) => (
      confirmedAtMs <= session.endMs - LATE_JOIN_MINIMUM_MS
    ));
    const missedSessionCount = firstEligibleSessionIndex < 0
      ? sessions.length
      : firstEligibleSessionIndex;
    const missedSessionIndices = sessions.slice(0, missedSessionCount).map((session) => session.index);
    const eligibleSession = firstEligibleSessionIndex >= 0
      ? sessions[firstEligibleSessionIndex]
      : null;
    return {
      known: true,
      confirmedAtMs,
      late: confirmedAtMs > sessions[0].startMs,
      joinedInProgress: Boolean(
        eligibleSession
        && confirmedAtMs > eligibleSession.startMs
        && confirmedAtMs < eligibleSession.endMs
      ),
      firstEligibleSessionIndex: eligibleSession ? firstEligibleSessionIndex : null,
      firstEligibleSessionNumber: eligibleSession ? eligibleSession.number : null,
      missedSessionIndices,
      missedSessionNumbers: missedSessionIndices.map((index) => sessions[index].number),
      minimumJoinMinutes: LATE_JOIN_MINIMUM_MS / 60000,
    };
  }

  function canJoinSession(wristbandConfirmedAt, sessionIndex) {
    const index = Number(sessionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= BOOTH_SESSIONS.length) return false;
    const plan = arrivalPlan(wristbandConfirmedAt);
    return plan.firstEligibleSessionIndex !== null && index >= plan.firstEligibleSessionIndex;
  }

  function deriveBoothStop(sessionIndex, visited, state, attendeePlan) {
    const snapshot = state || current();
    const index = Number(sessionIndex);
    const isCurrent = snapshot.phase === "active" && snapshot.sessionIndex === index;
    if (visited) {
      return { kind: "visited", canOpen: false, faded: true, checked: true };
    }
    const missedForCatchUp = attendeePlan
      && Array.isArray(attendeePlan.missedSessionIndices)
      && attendeePlan.missedSessionIndices.includes(index);
    if (missedForCatchUp) {
      return { kind: "catchup", canOpen: false, faded: true, checked: false };
    }
    if (isCurrent) {
      return { kind: "active", canOpen: true, faded: false, checked: false };
    }
    const isPast = ["message", "extra", "connections", "waiting", "ended"].includes(snapshot.phase)
      || (snapshot.phase === "active" && index < snapshot.sessionIndex);
    if (isPast) {
      return { kind: "expired", canOpen: false, faded: true, checked: false };
    }
    return { kind: "locked", canOpen: false, faded: true, checked: false };
  }

  function canOpenBooth(colorId, boothId, state, wristbandConfirmedAt, extraChoice) {
    const snapshot = state || current();
    if (!snapshot) return false;
    if (snapshot.phase === "extra") return String(extraChoice || "") === String(boothId || "");
    if (snapshot.phase !== "active") return false;
    return route(colorId)[snapshot.sessionIndex] === boothId
      && canJoinSession(wristbandConfirmedAt, snapshot.sessionIndex);
  }

  function isEndingSoon(state, thresholdMs = 15000) {
    const snapshot = state || current();
    const threshold = Number(thresholdMs);
    return Boolean(
      snapshot
      && (snapshot.phase === "active" || snapshot.phase === "extra")
      && Number.isFinite(snapshot.remainingMs)
      && snapshot.remainingMs > 0
      && Number.isFinite(threshold)
      && threshold >= 0
      && snapshot.remainingMs <= threshold
    );
  }

  function sessionTimeNotice(state) {
    const snapshot = state || current();
    if (!snapshot || !["active", "extra"].includes(snapshot.phase) || !snapshot.session) return null;
    const remainingMs = Math.max(0, Number(snapshot.remainingMs) || 0);
    const countdown = formatCountdown(remainingMs);
    const sessionName = snapshot.phase === "extra"
      ? "the extra booth session"
      : `Session ${snapshot.session.number}`;
    if (remainingMs <= 15000) {
      return {
        level: "urgent",
        milestoneMinutes: 0,
        title: "Final 15 seconds",
        message: `${countdown} left in ${sessionName}. Finish the current step and prepare the group to move.`,
      };
    }
    if (remainingMs <= 5 * 60 * 1000) {
      return {
        level: "urgent",
        milestoneMinutes: 5,
        title: "5-minute warning",
        message: `${countdown} left in ${sessionName}. Begin wrapping the activity and leave time for attendees to finish.`,
      };
    }
    if (remainingMs <= 10 * 60 * 1000) {
      return {
        level: "warning",
        milestoneMinutes: 10,
        title: "10-minute warning",
        message: `${countdown} left in ${sessionName}. Check the room's pace and plan the final steps.`,
      };
    }
    return {
      level: "steady",
      milestoneMinutes: 20,
      title: snapshot.phase === "extra" ? "20-minute extra booth underway" : "20-minute rotation underway",
      message: `${countdown} left in ${sessionName}. Booth leaders and Guardian Angels are following the same shared clock.`,
    };
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

  function boothsEndAtMs() {
    const last = BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1];
    return last ? new Date(last.endsAt).getTime() : NaN;
  }

  function messageStartsAtMs() {
    const configured = typeof MAIN_MESSAGE_STARTS_AT !== "undefined"
      ? new Date(MAIN_MESSAGE_STARTS_AT).getTime()
      : NaN;
    return Number.isFinite(configured) ? configured : boothsEndAtMs();
  }

  function messageEndsAtMs() {
    const configured = typeof MAIN_MESSAGE_ENDS_AT !== "undefined"
      ? new Date(MAIN_MESSAGE_ENDS_AT).getTime()
      : NaN;
    if (Number.isFinite(configured)) return configured;
    const extraStart = typeof EXTRA_BOOTH_SESSION !== "undefined" && EXTRA_BOOTH_SESSION
      ? new Date(EXTRA_BOOTH_SESSION.startsAt).getTime()
      : NaN;
    return Number.isFinite(extraStart) ? extraStart : messageStartsAtMs();
  }

  function extraBoothStartsAtMs() {
    const configured = typeof EXTRA_BOOTH_SESSION !== "undefined" && EXTRA_BOOTH_SESSION
      ? new Date(EXTRA_BOOTH_SESSION.startsAt).getTime()
      : NaN;
    return Number.isFinite(configured) ? configured : messageEndsAtMs();
  }

  function extraBoothEndsAtMs() {
    const configured = typeof EXTRA_BOOTH_SESSION !== "undefined" && EXTRA_BOOTH_SESSION
      ? new Date(EXTRA_BOOTH_SESSION.endsAt).getTime()
      : NaN;
    if (Number.isFinite(configured)) return configured;
    const eventEnd = typeof EVENT_ENDS_AT !== "undefined"
      ? new Date(EVENT_ENDS_AT).getTime()
      : NaN;
    return Number.isFinite(eventEnd) ? eventEnd : extraBoothStartsAtMs();
  }

  function eventEndsAtMs() {
    const configured = typeof EVENT_ENDS_AT !== "undefined"
      ? new Date(EVENT_ENDS_AT).getTime()
      : NaN;
    return Number.isFinite(configured) ? configured : extraBoothEndsAtMs();
  }

  function eventStartsAtMs() {
    const first = BOOTH_SESSIONS[0];
    return first ? new Date(first.startsAt).getTime() : NaN;
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
    arrivalPlan,
    canJoinSession,
    deriveBoothStop,
    canOpenBooth,
    isEndingSoon,
    sessionTimeNotice,
    groupForBooth,
    formatCountdown,
    formattedTime,
    eventStartsAtMs,
    boothsEndAtMs,
    messageStartsAtMs,
    messageEndsAtMs,
    extraBoothStartsAtMs,
    extraBoothEndsAtMs,
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

// Every same-origin Node page joins the server-shared rehearsal clock
// automatically, locally or on Render. Apps Script API bases never call it.
if (typeof window !== "undefined") {
  EventSchedule.startDemoClockSync(5000).catch(() => {});
}
