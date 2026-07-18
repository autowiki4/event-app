/* Node rehearsal backend — implements the complete attendee/staff API,
 * including attendee registration, shared-clock, and full-reset actions,
 * backed by a plain JSON file instead of a Google Sheet. It runs the whole
 * multi-device flow locally or as a same-origin service on Render.
 *
 * Deliberately zero npm dependencies (just Node's built-in http/fs) — so
 * there's no "npm install" step, nothing that can fail to fetch on a
 * conference wifi, and no version drift. Just: node server.js.
 *
 * An optional server-side service account mirrors the full Node data directly
 * through the Google Sheets API without changing API_BASE_URL. The older Apps
 * Script adapter remains limited and has no remote rehearsal clock or resetDemo.
 *
 * Run: node server.js   (serves web/ + the /api/* routes on :3000)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TRIVIA_QUESTIONS } = require("./trivia-questions");
const { createGoogleSheetsExporter } = require("./google-sheets-export");

const DB_PATH = process.env.EVENT_APP_DB_PATH || path.join(__dirname, "db.json");
const DB_BACKUP_PATH = `${DB_PATH}.bak`;
const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = process.env.PORT || 3000;
const ORGANIZER_KEY = process.env.EVENT_APP_ORGANIZER_KEY || "demo";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const BOOTH_IDS = new Set(["heaven", "trivia", "story", "art", "newsong"]);
const WRISTBAND_COLORS = new Set(["blue", "red", "orange", "green", "yellow"]);
const BOOTH_NAMES = Object.freeze({
  heaven: "Can You Draw Heaven?",
  trivia: "Bible Bowl",
  story: "The Heaven Booth",
  art: "Art Therapy Table",
  newsong: "The New Song in Nashville",
});
const WRISTBAND_ROUTES = Object.freeze({
  blue: ["heaven", "trivia"],
  red: ["trivia", "heaven"],
  orange: ["art", "story"],
  green: ["newsong", "art"],
  yellow: ["story", "newsong"],
});
const BOOTH_SESSIONS = Object.freeze([
  { number: 1, startsAt: "2026-07-18T15:10:00-05:00", endsAt: "2026-07-18T15:30:00-05:00", label: "3:10–3:30 PM" },
  { number: 2, startsAt: "2026-07-18T15:30:00-05:00", endsAt: "2026-07-18T15:50:00-05:00", label: "3:30–3:50 PM" },
]);
const MAIN_MESSAGE_STARTS_AT = "2026-07-18T16:00:00-05:00";
const BOOTH_PRESENTATION_STATUSES = new Set(["waiting", "live", "paused", "wrap", "complete"]);
const MAX_PRESENTATION_STEP_INDEX = 50;
const MAX_PRESENTATION_MESSAGE_LENGTH = 500;
const STORY_FINAL_STEP_INDEX = 12;
const TRIVIA_SESSION_NUMBERS = new Set([1, 2]);
const TRIVIA_PHASES = new Set(["welcome", "question", "reveal", "complete"]);
const HEAVEN_SESSION_NUMBERS = new Set([1, 2]);
const HEAVEN_PHASES = new Set([
  "welcome", "drawing", "verse", "comparison", "reflection", "programs", "complete",
]);
const HEAVEN_PHASE_ORDER = Object.freeze([
  "welcome", "drawing", "verse", "comparison", "reflection", "programs", "complete",
]);
const HEAVEN_CONFIRMATION_ACTIONS = Object.freeze([
  "drawing_complete", "description_yes", "size_yes", "impact_yes", "programs_done",
]);
const HEAVEN_CONFIRMATION_ACTION_SET = new Set(HEAVEN_CONFIRMATION_ACTIONS);
const HEAVEN_CONFIRMATION_RULES = Object.freeze({
  drawing_complete: { minimumPhase: "drawing", requires: [] },
  description_yes: { minimumPhase: "drawing", requires: ["drawing_complete"] },
  size_yes: { minimumPhase: "verse", requires: ["description_yes"] },
  impact_yes: { minimumPhase: "comparison", requires: ["size_yes"] },
  programs_done: { minimumPhase: "programs", requires: ["impact_yes"] },
});
const ART_SESSION_NUMBERS = new Set([1, 2]);
const ART_PHASES = new Set([
  "welcome", "definition", "importance", "purpose_image", "heart_question",
  "proverbs", "philippians", "create", "finished", "complete",
]);
const NEW_SONG_SESSION_NUMBERS = new Set([1, 2]);
// Session 3 is no longer part of the live schedule, but older rehearsal data
// must survive every read/normalize/write cycle. Live endpoint validation
// continues to use the booth-specific Session 1–2 sets above.
const STORED_ACTIVITY_SESSION_NUMBERS = new Set([1, 2, 3]);
const NEW_SONG_PHASES = new Set(["welcome", "voting", "winner", "verse", "complete"]);
const NEW_SONG_CHOICES = Object.freeze([
  "He Turned It",
  "Victory",
  "Brighter Day",
  "Praise - elevation worship",
  "I thank God - maverick city",
  "Amen- Madison Ryann Ward",
  "Quick - Caleb Gordon",
  "Goodbye Yesterday - elevation rhythm",
  "He called me",
  "247",
  "Elohim",
]);
const NEW_SONG_CHOICE_ALIASES = new Map([
  ["he called me-eugy official", "He called me"],
  ["247-tbabz", "247"],
  ["elohim-sondae", "Elohim"],
]);
const LEGACY_NEW_SONG_CHOICES = new Set([
  "Great Are You Lord", "Way Maker", "Goodness of God", "Build My Life", "Reckless Love",
  "King of Kings", "Living Hope", "Graves Into Gardens", "Raise a Hallelujah", "The Blessing",
  "O Come to the Altar", "Do It Again", "House of the Lord", "Same God", "Great Things",
  "Battle Belongs", "God in me", "Jireh", "Yes I Will", "Firm Foundation", "Champion",
]);
const DEMO_CLOCK_MODES = new Set([
  "live",
  "custom",
  "before",
  "session1-start",
  "session1",
  "session2",
  "session1-final15",
  "session2-final15",
  "waiting",
  "ended",
]);
const EVENT_WINDOW_START_MS = Date.parse(BOOTH_SESSIONS[0].startsAt);
const EVENT_WINDOW_END_MS = Date.parse(MAIN_MESSAGE_STARTS_AT);
const LATE_JOIN_MINIMUM_MS = 5 * 60 * 1000;
const FINAL_SIGNUP_OPTIONS = new Map([
  ["future", "Keep me posted on future events"],
  ["bible", "One-on-one Bible study"],
  ["course", "The 8-month course"],
  ["art", "Art therapy"],
  ["friend", "Help me invite a friend"],
]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
// The rehearsal clock is intentionally process-local: it is shared by every
// browser connected to this demo server, but disappears when the demo server
// restarts and can never affect the Apps Script deployment.
function defaultDemoClock() {
  return {
    mode: "live",
    controlled: false,
    targetMs: null,
    anchoredAtMs: null,
    updatedAt: new Date().toISOString(),
  };
}

let demoClock = defaultDemoClock();

function effectiveNowMs(realNowMs = Date.now()) {
  if (!demoClock.controlled || demoClock.mode === "live") return realNowMs;
  return demoClock.targetMs + (realNowMs - demoClock.anchoredAtMs);
}

function namedDemoClockTargetMs(mode) {
  const firstStartMs = Date.parse(BOOTH_SESSIONS[0].startsAt);
  const boothsEndMs = Date.parse(BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1].endsAt);
  if (mode === "before") return firstStartMs - (5 * 60 * 1000);
  if (mode === "session1-start") return firstStartMs;
  if (mode === "waiting") return boothsEndMs + Math.floor((EVENT_WINDOW_END_MS - boothsEndMs) / 2);
  if (mode === "ended") return EVENT_WINDOW_END_MS;
  const sessionMatch = /^session([12])(-final15)?$/.exec(mode);
  if (!sessionMatch) return NaN;
  const session = BOOTH_SESSIONS[Number(sessionMatch[1]) - 1];
  if (!session) return NaN;
  return sessionMatch[2]
    ? Date.parse(session.endsAt) - (15 * 1000)
    : Date.parse(session.startsAt) + (5 * 60 * 1000);
}

function eventNowIso() {
  return new Date(effectiveNowMs()).toISOString();
}

function eventSessionState(nowMs = effectiveNowMs()) {
  const sessions = BOOTH_SESSIONS.map((session, index) => ({
    ...session,
    index,
    startMs: Date.parse(session.startsAt),
    endMs: Date.parse(session.endsAt),
  }));
  const active = sessions.find((session) => nowMs >= session.startMs && nowMs < session.endMs);
  if (active) {
    return {
      phase: "active",
      serverNow: new Date(nowMs).toISOString(),
      sessionIndex: active.index,
      sessionNumber: active.number,
      sessionLabel: active.label,
    };
  }
  if (nowMs < sessions[0].startMs) {
    return {
      phase: "before",
      serverNow: new Date(nowMs).toISOString(),
      sessionIndex: null,
      sessionNumber: null,
      sessionLabel: null,
    };
  }
  if (nowMs < EVENT_WINDOW_END_MS) {
    return {
      phase: "waiting",
      serverNow: new Date(nowMs).toISOString(),
      sessionIndex: null,
      sessionNumber: null,
      sessionLabel: null,
    };
  }
  return {
    phase: "ended",
    serverNow: new Date(nowMs).toISOString(),
    sessionIndex: null,
    sessionNumber: null,
    sessionLabel: null,
  };
}

function attendeeArrivalPlan(attendee) {
  const confirmedAt = attendee && attendee.wristbandConfirmedAt
    ? String(attendee.wristbandConfirmedAt)
    : "";
  const confirmedAtMs = Date.parse(confirmedAt);
  const colorId = normalizeWristbandColor(attendee && attendee.wristbandColor);
  const route = colorId && WRISTBAND_ROUTES[colorId] ? WRISTBAND_ROUTES[colorId] : [];
  if (!Number.isFinite(confirmedAtMs)) {
    return {
      confirmedAt: null,
      late: false,
      joinedInProgress: false,
      firstEligibleSessionIndex: 0,
      firstEligibleSessionNumber: 1,
      missedSessionNumbers: [],
      catchUpBooths: [],
      minimumJoinMinutes: LATE_JOIN_MINIMUM_MS / 60000,
    };
  }

  const sessions = BOOTH_SESSIONS.map((session, index) => ({
    ...session,
    index,
    startMs: Date.parse(session.startsAt),
    endMs: Date.parse(session.endsAt),
  }));
  const firstEligibleSessionIndex = sessions.findIndex((session) => (
    confirmedAtMs <= session.endMs - LATE_JOIN_MINIMUM_MS
  ));
  const missedSessionCount = firstEligibleSessionIndex < 0
    ? sessions.length
    : firstEligibleSessionIndex;
  const missedSessionNumbers = sessions
    .slice(0, missedSessionCount)
    .map((session) => session.number);
  const eligibleSession = firstEligibleSessionIndex >= 0
    ? sessions[firstEligibleSessionIndex]
    : null;
  return {
    confirmedAt: new Date(confirmedAtMs).toISOString(),
    late: confirmedAtMs > sessions[0].startMs,
    joinedInProgress: Boolean(
      eligibleSession
      && confirmedAtMs > eligibleSession.startMs
      && confirmedAtMs < eligibleSession.endMs
    ),
    firstEligibleSessionIndex: eligibleSession ? firstEligibleSessionIndex : null,
    firstEligibleSessionNumber: eligibleSession ? eligibleSession.number : null,
    missedSessionNumbers,
    catchUpBooths: missedSessionNumbers.map((sessionNumber) => {
      const boothId = route[sessionNumber - 1] || null;
      return boothId
        ? { sessionNumber, boothId, boothName: BOOTH_NAMES[boothId] || boothId }
        : { sessionNumber, boothId: null, boothName: "Unassigned booth" };
    }),
    minimumJoinMinutes: LATE_JOIN_MINIMUM_MS / 60000,
  };
}

function attendeeCanJoinSession(attendee, sessionNumber) {
  const index = Number(sessionNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= BOOTH_SESSIONS.length) return false;
  const plan = attendeeArrivalPlan(attendee);
  return plan.firstEligibleSessionIndex !== null && index >= plan.firstEligibleSessionIndex;
}

function lateArrivalAccessError(attendee, eventState) {
  if (!eventState || eventState.phase !== "active" || !eventState.sessionNumber) return null;
  if (attendeeCanJoinSession(attendee, eventState.sessionNumber)) return null;
  const plan = attendeeArrivalPlan(attendee);
  const nextNumber = plan.firstEligibleSessionNumber;
  const message = nextNumber
    ? `You checked in near the end of this rotation. Wait for Session ${nextNumber}; this missed stop is marked for catch-up.`
    : "You checked in near the end of the final rotation. Ask an organizer about a catch-up booth.";
  return errorResult(409, message, "LATE_ARRIVAL_WAIT");
}

function activeBoothControlError(sessionNumber, boothName) {
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return errorResult(
      409,
      `${boothName} can publish attendee steps only while a booth session is active. Use the Overall Organizer clock to rehearse a session.`,
      "BOOTH_SESSION_NOT_ACTIVE"
    );
  }
  if (eventState.sessionNumber !== sessionNumber) {
    return errorResult(
      409,
      `Session ${eventState.sessionNumber} is live. Switch this portal to the active session before publishing.`,
      "BOOTH_SESSION_NOT_ACTIVE"
    );
  }
  return null;
}

function nextDemoClockUpdatedAt(realNowMs) {
  const previousMs = Date.parse(demoClock.updatedAt);
  const nextMs = Number.isFinite(previousMs) ? Math.max(realNowMs, previousMs + 1) : realNowMs;
  return new Date(nextMs).toISOString();
}

function demoClockResult() {
  const dataResetAt = readDb().dataResetAt;
  return {
    serverNow: eventNowIso(),
    mode: demoClock.mode,
    controlled: demoClock.controlled,
    targetIso: Number.isFinite(demoClock.targetMs)
      ? new Date(demoClock.targetMs).toISOString()
      : null,
    updatedAt: demoClock.updatedAt,
    dataResetAt,
  };
}

// ---------- tiny JSON-file "database" ----------
function emptyDb() {
  return {
    attendees: [],
    boothCheckins: [],
    songVotes: [],
    signups: [],
    boothPresentations: {},
    triviaSessions: {},
    triviaAnswers: [],
    triviaRunHistory: [],
    heavenSessions: {},
    heavenConfirmations: [],
    heavenRunHistory: [],
    artSessions: {},
    artCompletions: [],
    artRunHistory: [],
    newSongSessions: {},
    newSongRunHistory: [],
    raffleCounter: 1000,
    dataResetAt: "initial",
  };
}
function normalizeDataResetAt(value) {
  if (value === "initial") return "initial";
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs) ? new Date(valueMs).toISOString() : "initial";
}

function normalizeBoothCheckins(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  const byAttendeeBoothAndRun = new Map();
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const attendeeId = String(raw.attendeeId || "").trim();
    const boothId = String(raw.boothId || "").trim();
    const runId = raw.extraData && typeof raw.extraData === "object"
      ? String(raw.extraData.runId || "").trim()
      : "";
    const key = attendeeId && boothId
      ? `${attendeeId}:${boothId}:${runId || "legacy"}`
      : `invalid:${String(raw.id || index)}`;
    const existing = byAttendeeBoothAndRun.get(key);
    if (!existing) {
      const row = { ...raw };
      rows.push(row);
      byAttendeeBoothAndRun.set(key, row);
      return;
    }

    const existingMs = Date.parse(existing.checkedInAt);
    const incomingMs = Date.parse(raw.checkedInAt);
    const incomingIsNewer = Number.isFinite(incomingMs)
      && (!Number.isFinite(existingMs) || incomingMs >= existingMs);
    const older = incomingIsNewer ? existing : raw;
    const newer = incomingIsNewer ? raw : existing;
    const existingId = existing.id || raw.id;
    const mergedExtra = Object.assign(
      {},
      older.extraData && typeof older.extraData === "object" ? older.extraData : {},
      newer.extraData && typeof newer.extraData === "object" ? newer.extraData : {}
    );
    Object.assign(existing, newer, {
      id: existingId,
      checkedInAt: earliestTimestamp(existing.checkedInAt, raw.checkedInAt),
      extraData: Object.keys(mergedExtra).length ? mergedExtra : null,
    });
  });
  return rows;
}

function normalizeDb(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const db = Object.assign(emptyDb(), source);
  // Drop challenge data left by builds that used text-message verification.
  // It is no longer part of the attendee model and must not be rewritten.
  delete db.otpChallenges;
  db.attendees = Array.isArray(source.attendees)
    ? source.attendees.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  db.boothCheckins = normalizeBoothCheckins(source.boothCheckins);
  db.songVotes = normalizeNewSongVotes(source.songVotes);
  db.signups = Array.isArray(source.signups)
    ? source.signups.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  db.boothPresentations = source.boothPresentations
    && typeof source.boothPresentations === "object"
    && !Array.isArray(source.boothPresentations)
    ? source.boothPresentations
    : {};
  const sourceTriviaSessions = source.triviaSessions
    && typeof source.triviaSessions === "object"
    && !Array.isArray(source.triviaSessions)
    ? source.triviaSessions
    : {};
  db.triviaSessions = {};
  STORED_ACTIVITY_SESSION_NUMBERS.forEach((sessionNumber) => {
    const key = String(sessionNumber);
    if (sourceTriviaSessions[key]) {
      db.triviaSessions[key] = normalizeTriviaSessionRecord(sourceTriviaSessions[key], sessionNumber);
    }
  });
  db.triviaAnswers = normalizeTriviaAnswers(source.triviaAnswers);
  db.triviaRunHistory = normalizeActivityRunHistory(source.triviaRunHistory, "trivia");
  const sourceHeavenSessions = source.heavenSessions
    && typeof source.heavenSessions === "object"
    && !Array.isArray(source.heavenSessions)
    ? source.heavenSessions
    : {};
  db.heavenSessions = {};
  STORED_ACTIVITY_SESSION_NUMBERS.forEach((sessionNumber) => {
    const key = String(sessionNumber);
    if (sourceHeavenSessions[key]) {
      db.heavenSessions[key] = normalizeHeavenSessionRecord(sourceHeavenSessions[key], sessionNumber);
    }
  });
  db.heavenConfirmations = normalizeHeavenConfirmations(source.heavenConfirmations);
  db.heavenRunHistory = normalizeActivityRunHistory(source.heavenRunHistory, "heaven");
  const sourceArtSessions = source.artSessions
    && typeof source.artSessions === "object"
    && !Array.isArray(source.artSessions)
    ? source.artSessions
    : {};
  db.artSessions = {};
  STORED_ACTIVITY_SESSION_NUMBERS.forEach((sessionNumber) => {
    const key = String(sessionNumber);
    if (sourceArtSessions[key]) {
      db.artSessions[key] = normalizeArtSessionRecord(sourceArtSessions[key], sessionNumber);
    }
  });
  db.artCompletions = normalizeArtCompletions(source.artCompletions);
  db.artRunHistory = normalizeActivityRunHistory(source.artRunHistory, "art");
  const sourceNewSongSessions = source.newSongSessions
    && typeof source.newSongSessions === "object"
    && !Array.isArray(source.newSongSessions)
    ? source.newSongSessions
    : {};
  db.newSongSessions = {};
  STORED_ACTIVITY_SESSION_NUMBERS.forEach((sessionNumber) => {
    const key = String(sessionNumber);
    if (sourceNewSongSessions[key]) {
      db.newSongSessions[key] = normalizeNewSongSessionRecord(
        sourceNewSongSessions[key], sessionNumber
      );
    }
  });
  db.newSongRunHistory = normalizeActivityRunHistory(source.newSongRunHistory, "newsong");
  db.attendees.forEach((attendee) => {
    if (!Array.isArray(attendee.aliasIds)) attendee.aliasIds = [];
    attendee.phone = digitsOnly(attendee.phone) || null;
    delete attendee.phoneVerifiedAt;
    delete attendee.phoneVerificationRequired;
    attendee.wristbandColor = normalizeWristbandColor(attendee.wristbandColor);
    attendee.wristbandConfirmedAt = earliestTimestamp(attendee.wristbandConfirmedAt);
    attendee.phase3CompletedAt = earliestTimestamp(attendee.phase3CompletedAt);
  });
  const highestAssignedRaffle = db.attendees.reduce((highest, attendee) => {
    const raffleNumber = Number(normalizeRaffleNumber(attendee.raffleNumber));
    return Number.isSafeInteger(raffleNumber) ? Math.max(highest, raffleNumber) : highest;
  }, 1000);
  const storedCounter = Number(source.raffleCounter);
  db.raffleCounter = Math.max(
    highestAssignedRaffle,
    Number.isSafeInteger(storedCounter) ? storedCounter : 1000
  );
  db.dataResetAt = normalizeDataResetAt(source.dataResetAt);
  return db;
}
let dbCache = null;
let dbCacheFingerprint = null;

function databaseUnavailable(message, cause) {
  const error = new Error(message);
  error.code = "DATABASE_UNAVAILABLE";
  error.status = 503;
  if (cause) error.cause = cause;
  return error;
}

function cloneDb(db) {
  return JSON.parse(JSON.stringify(db));
}

function fileFingerprint(filename) {
  try {
    const stat = fs.statSync(filename);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw databaseUnavailable("The event database cannot be inspected.", error);
  }
}

function parseDbFile(filename) {
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) {
    throw databaseUnavailable(`The event database file is unreadable: ${path.basename(filename)}.`, error);
  }
}

function writeFileDurably(filename, contents) {
  const fd = fs.openSync(filename, "w", 0o600);
  try {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function restoreBackup(primaryError) {
  if (!fileFingerprint(DB_BACKUP_PATH)) throw primaryError;
  let recovered;
  try {
    recovered = parseDbFile(DB_BACKUP_PATH);
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const recoveryPath = `${DB_PATH}.${process.pid}.recovering`;
    writeFileDurably(recoveryPath, JSON.stringify(recovered, null, 2));
    fs.renameSync(recoveryPath, DB_PATH);
  } catch (backupError) {
    throw databaseUnavailable("The event database and its backup are both unavailable.", backupError);
  }
  console.error(`Recovered event data from ${DB_BACKUP_PATH} after the primary database became unreadable.`);
  dbCache = recovered;
  dbCacheFingerprint = fileFingerprint(DB_PATH);
  markGoogleSheetsExportDirty();
  return cloneDb(recovered);
}

function readDb() {
  const fingerprint = fileFingerprint(DB_PATH);
  if (!fingerprint) {
    if (dbCache) {
      // A mounted disk can briefly disappear during infrastructure events.
      // Recreate the primary file from the last known-good in-memory state
      // instead of silently treating every attendee as deleted.
      writeDb(dbCache);
      return cloneDb(dbCache);
    }
    if (fileFingerprint(DB_BACKUP_PATH)) {
      return restoreBackup(databaseUnavailable("The primary event database is missing."));
    }
    dbCache = emptyDb();
    dbCacheFingerprint = null;
    return cloneDb(dbCache);
  }
  if (dbCache && fingerprint === dbCacheFingerprint) return cloneDb(dbCache);
  try {
    dbCache = parseDbFile(DB_PATH);
    dbCacheFingerprint = fingerprint;
    return cloneDb(dbCache);
  } catch (primaryError) {
    return restoreBackup(primaryError);
  }
}

function writeDb(db, options = {}) {
  const normalized = normalizeDb(db);
  const serialized = JSON.stringify(normalized, null, 2);
  const tempPath = `${DB_PATH}.${process.pid}.tmp`;
  const backupTempPath = `${DB_BACKUP_PATH}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    writeFileDurably(tempPath, serialized);
    if (options.replaceBackup) {
      // A protected reset is a deletion boundary. Replace the recovery copy
      // before replacing the primary so pre-reset attendee data cannot be
      // resurrected by later corruption or a missing mounted file.
      writeFileDurably(backupTempPath, serialized);
      fs.renameSync(backupTempPath, DB_BACKUP_PATH);
    } else if (fileFingerprint(DB_PATH)) {
      // Preserve the previous logical state, but normalize it first so retired
      // fields (including old phone-challenge data) cannot remain in backups.
      const previousSerialized = JSON.stringify(parseDbFile(DB_PATH), null, 2);
      writeFileDurably(backupTempPath, previousSerialized);
      fs.renameSync(backupTempPath, DB_BACKUP_PATH);
    }
    fs.renameSync(tempPath, DB_PATH);
    dbCache = normalized;
    dbCacheFingerprint = fileFingerprint(DB_PATH);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (cleanupError) { /* best effort */ }
    try { fs.rmSync(backupTempPath, { force: true }); } catch (cleanupError) { /* best effort */ }
    throw databaseUnavailable("The event database could not be saved. No in-memory success was reported.", error);
  }
  // Export scheduling is deliberately outside the durability try/catch. A
  // secondary Sheet outage must never turn a committed event write into an
  // attendee-visible database failure.
  if (!options.skipSheetsExport) markGoogleSheetsExportDirty();
}

const googleSheetsExporter = createGoogleSheetsExporter({ getSnapshot: readDb });

function markGoogleSheetsExportDirty() {
  try {
    googleSheetsExporter.markDirty();
  } catch (error) {
    console.error("Google Sheets export could not be queued; event data remains saved locally.");
  }
}

function queueInitialGoogleSheetsExport() {
  try {
    googleSheetsExporter.queueImmediate();
  } catch (error) {
    console.error("Initial Google Sheets export could not be queued; event data remains saved locally.");
  }
}

function databaseFileHasRetiredVerificationData(filename) {
  try {
    const contents = fs.readFileSync(filename, "utf8");
    return /"otpChallenges"|"phoneVerifiedAt"|"phoneVerificationRequired"/.test(contents);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw databaseUnavailable("The event database could not be checked for retired fields.", error);
  }
}

function sanitizeRetiredVerificationData() {
  const needsSanitizing = databaseFileHasRetiredVerificationData(DB_PATH)
    || databaseFileHasRetiredVerificationData(DB_BACKUP_PATH);
  if (!needsSanitizing) return;
  const db = readDb();
  writeDb(db, { replaceBackup: true, skipSheetsExport: true });
  console.log("Removed retired phone-verification data from the event database and backup.");
}

function id() {
  return crypto.randomUUID();
}
function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function normalizeRaffleNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAttendeeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizeWristbandColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WRISTBAND_COLORS.has(normalized) ? normalized : null;
}

function requireWristbandColor(value) {
  const color = normalizeWristbandColor(value);
  return color
    ? { color }
    : { error: errorResult(400, "Choose a valid wristband color.", "INVALID_WRISTBAND_COLOR") };
}

function requireBoothId(value) {
  const boothId = String(value || "").trim();
  return BOOTH_IDS.has(boothId)
    ? { boothId }
    : { error: errorResult(404, "booth not found", "BOOTH_NOT_FOUND") };
}

function defaultBoothPresentation(boothId) {
  return {
    boothId,
    stepIndex: 0,
    status: "waiting",
    message: "",
    createdAt: null,
    updatedAt: null,
    version: 0,
  };
}

function boothPresentationFromDb(db, boothId) {
  const stored = db.boothPresentations[boothId];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return defaultBoothPresentation(boothId);
  }
  const stepIndex = Number(stored.stepIndex);
  const version = Number(stored.version);
  const status = String(stored.status || "").trim().toLowerCase();
  return {
    boothId,
    stepIndex: Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex <= MAX_PRESENTATION_STEP_INDEX
      ? stepIndex
      : 0,
    status: BOOTH_PRESENTATION_STATUSES.has(status) ? status : "waiting",
    message: boothId === "story"
      ? ""
      : typeof stored.message === "string"
      ? stored.message.slice(0, MAX_PRESENTATION_MESSAGE_LENGTH)
      : "",
    createdAt: stored.createdAt || null,
    updatedAt: stored.updatedAt || null,
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
  };
}

function normalizeRunNumber(value) {
  const runNumber = Number(value);
  return Number.isSafeInteger(runNumber) && runNumber > 0 ? runNumber : 1;
}

function defaultActivityRunId(activity, sessionNumber, runNumber = 1) {
  return `${activity}-session-${sessionNumber}-run-${normalizeRunNumber(runNumber)}`;
}

function normalizeActivityRunId(value, activity, sessionNumber, runNumber) {
  const runId = String(value || "").trim();
  return runId || defaultActivityRunId(activity, sessionNumber, runNumber);
}

function newActivityRunId(activity, sessionNumber, runNumber) {
  return `${activity}-session-${sessionNumber}-run-${runNumber}-${id()}`;
}

function normalizeStoredActivitySessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && STORED_ACTIVITY_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function normalizeActivityRunHistory(value, activity) {
  if (!Array.isArray(value)) return [];
  const validPhases = {
    trivia: TRIVIA_PHASES,
    heaven: HEAVEN_PHASES,
    art: ART_PHASES,
    newsong: NEW_SONG_PHASES,
  }[activity];
  if (!validPhases) return [];
  const seen = new Set();
  const history = [];
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const sessionNumber = normalizeStoredActivitySessionNumber(raw.sessionNumber);
    if (!sessionNumber) return;
    const runNumber = normalizeRunNumber(raw.runNumber);
    const runId = normalizeActivityRunId(raw.runId, activity, sessionNumber, runNumber);
    const key = `${sessionNumber}:${runId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const parsedVersion = Number(raw.version);
    const parsedQuestionIndex = Number(raw.questionIndex);
    history.push({
      sessionNumber,
      runId,
      runNumber,
      phase: validPhases.has(raw.phase) ? raw.phase : "welcome",
      questionIndex: activity === "trivia"
        && Number.isInteger(parsedQuestionIndex)
        && parsedQuestionIndex >= -1
        && parsedQuestionIndex < TRIVIA_QUESTIONS.length
        ? parsedQuestionIndex
        : undefined,
      result: activity === "newsong" ? normalizeNewSongResult(raw.result) : undefined,
      version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
      startedAt: earliestTimestamp(raw.startedAt),
      completedAt: earliestTimestamp(raw.completedAt),
      archivedAt: earliestTimestamp(raw.archivedAt),
      archiveReason: String(raw.archiveReason || "reset").trim() || "reset",
    });
  });
  return history.sort((a, b) => (
    a.sessionNumber - b.sessionNumber || a.runNumber - b.runNumber
  ));
}

function normalizeTriviaSessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && TRIVIA_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function defaultTriviaSession(sessionNumber, options = {}) {
  const runNumber = normalizeRunNumber(options.runNumber);
  const parsedVersion = Number(options.version);
  return {
    sessionNumber,
    runId: normalizeActivityRunId(options.runId, "trivia", sessionNumber, runNumber),
    runNumber,
    phase: "welcome",
    questionIndex: -1,
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: null,
    updatedAt: earliestTimestamp(options.updatedAt),
    completedAt: null,
  };
}

function normalizeTriviaSessionRecord(value, sessionNumber) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const phase = TRIVIA_PHASES.has(raw.phase) ? raw.phase : "welcome";
  const parsedQuestionIndex = Number(raw.questionIndex);
  const hasQuestion = Number.isInteger(parsedQuestionIndex)
    && parsedQuestionIndex >= 0
    && parsedQuestionIndex < TRIVIA_QUESTIONS.length;
  const parsedVersion = Number(raw.version);
  const runNumber = normalizeRunNumber(raw.runNumber);
  const fallback = defaultTriviaSession(sessionNumber, {
    runId: raw.runId,
    runNumber,
    version: parsedVersion,
    updatedAt: raw.updatedAt,
  });
  if (phase !== "welcome" && !hasQuestion) return fallback;
  return {
    sessionNumber,
    runId: normalizeActivityRunId(raw.runId, "trivia", sessionNumber, runNumber),
    runNumber,
    phase,
    questionIndex: phase === "welcome" ? -1 : parsedQuestionIndex,
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: earliestTimestamp(raw.startedAt),
    updatedAt: earliestTimestamp(raw.updatedAt),
    completedAt: phase === "complete" ? earliestTimestamp(raw.completedAt) : null,
  };
}

function normalizeTriviaAnswers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const answers = [];
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const attendeeId = String(raw.attendeeId || "").trim();
    const sessionNumber = normalizeStoredActivitySessionNumber(raw.sessionNumber);
    const runNumber = normalizeRunNumber(raw.runNumber);
    const runId = sessionNumber
      ? normalizeActivityRunId(raw.runId, "trivia", sessionNumber, runNumber)
      : "";
    const questionId = String(raw.questionId || "").trim();
    const question = TRIVIA_QUESTIONS.find((item) => item.id === questionId);
    const answerIndex = Number(raw.answerIndex);
    if (!attendeeId || !sessionNumber || !question || !Number.isInteger(answerIndex)
      || answerIndex < 0 || answerIndex >= question.choices.length) return;
    const key = `${runId}:${attendeeId}:${questionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    answers.push({
      id: String(raw.id || `legacy-${sessionNumber}-${attendeeId}-${questionId}`),
      attendeeId,
      sessionNumber,
      runId,
      runNumber,
      questionId,
      questionNumber: TRIVIA_QUESTIONS.indexOf(question) + 1,
      answerIndex,
      isCorrect: answerIndex === question.correctIndex,
      answeredAt: earliestTimestamp(raw.answeredAt) || null,
    });
  });
  return answers;
}

function normalizeHeavenSessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && HEAVEN_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function defaultHeavenSession(sessionNumber, options = {}) {
  const runNumber = normalizeRunNumber(options.runNumber);
  const parsedVersion = Number(options.version);
  return {
    sessionNumber,
    runId: normalizeActivityRunId(options.runId, "heaven", sessionNumber, runNumber),
    runNumber,
    phase: "welcome",
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: null,
    updatedAt: earliestTimestamp(options.updatedAt),
    completedAt: null,
  };
}

function normalizeHeavenSessionRecord(value, sessionNumber) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parsedVersion = Number(raw.version);
  const runNumber = normalizeRunNumber(raw.runNumber);
  return {
    sessionNumber,
    runId: normalizeActivityRunId(raw.runId, "heaven", sessionNumber, runNumber),
    runNumber,
    phase: HEAVEN_PHASES.has(raw.phase) ? raw.phase : "welcome",
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: earliestTimestamp(raw.startedAt),
    updatedAt: earliestTimestamp(raw.updatedAt),
    completedAt: raw.phase === "complete" ? earliestTimestamp(raw.completedAt) : null,
  };
}

function normalizeHeavenConfirmations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const confirmations = [];
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const attendeeId = String(raw.attendeeId || "").trim();
    const sessionNumber = normalizeStoredActivitySessionNumber(raw.sessionNumber);
    const action = String(raw.action || "").trim().toLowerCase();
    const runNumber = normalizeRunNumber(raw.runNumber);
    const runId = sessionNumber
      ? normalizeActivityRunId(raw.runId, "heaven", sessionNumber, runNumber)
      : "";
    if (!attendeeId || !sessionNumber || !HEAVEN_CONFIRMATION_ACTION_SET.has(action)) return;
    const key = `${runId}:${attendeeId}:${action}`;
    if (seen.has(key)) return;
    seen.add(key);
    confirmations.push({
      id: String(raw.id || `legacy-${runId}-${attendeeId}-${action}`),
      attendeeId,
      sessionNumber,
      runId,
      runNumber,
      action,
      confirmedAt: earliestTimestamp(raw.confirmedAt),
    });
  });
  return confirmations;
}

function normalizeArtSessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && ART_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function defaultArtSession(sessionNumber, options = {}) {
  const runNumber = normalizeRunNumber(options.runNumber);
  const parsedVersion = Number(options.version);
  return {
    sessionNumber,
    runId: normalizeActivityRunId(options.runId, "art", sessionNumber, runNumber),
    runNumber,
    phase: "welcome",
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: null,
    updatedAt: earliestTimestamp(options.updatedAt),
    completedAt: null,
  };
}

function normalizeArtSessionRecord(value, sessionNumber) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parsedVersion = Number(raw.version);
  const runNumber = normalizeRunNumber(raw.runNumber);
  const phase = ART_PHASES.has(raw.phase) ? raw.phase : "welcome";
  return {
    sessionNumber,
    runId: normalizeActivityRunId(raw.runId, "art", sessionNumber, runNumber),
    runNumber,
    phase,
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    startedAt: earliestTimestamp(raw.startedAt),
    updatedAt: earliestTimestamp(raw.updatedAt),
    completedAt: phase === "complete" ? earliestTimestamp(raw.completedAt) : null,
  };
}

function normalizeArtCompletions(value) {
  if (!Array.isArray(value)) return [];
  const completionsByParticipant = new Map();
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const attendeeId = String(raw.attendeeId || "").trim();
    const sessionNumber = normalizeStoredActivitySessionNumber(raw.sessionNumber);
    const runNumber = normalizeRunNumber(raw.runNumber);
    const runId = sessionNumber
      ? normalizeActivityRunId(raw.runId, "art", sessionNumber, runNumber)
      : "";
    const completedAt = earliestTimestamp(raw.completedAt, raw.checkedInAt);
    if (!attendeeId || !sessionNumber || !completedAt) return;
    const key = `${runId}:${attendeeId}`;
    const completion = {
      id: String(raw.id || `legacy-${runId}-${attendeeId}`),
      attendeeId,
      sessionNumber,
      runId,
      runNumber,
      completedAt,
    };
    const previous = completionsByParticipant.get(key);
    if (!previous || Date.parse(completion.completedAt) < Date.parse(previous.completedAt)) {
      completionsByParticipant.set(key, completion);
    }
  });
  return Array.from(completionsByParticipant.values());
}

function normalizedNewSongKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s*[—–-]\s*/g, "-")
    .replace(/\s+/g, " ");
}

function canonicalNewSongChoice(value) {
  const key = normalizedNewSongKey(value);
  return NEW_SONG_CHOICES.find((title) => normalizedNewSongKey(title) === key)
    || NEW_SONG_CHOICE_ALIASES.get(key)
    || null;
}

function storedNewSongChoice(value) {
  const canonical = canonicalNewSongChoice(value);
  if (canonical) return canonical;
  const legacy = String(value || "").trim();
  return LEGACY_NEW_SONG_CHOICES.has(legacy) ? legacy : null;
}

function normalizeNewSongResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tiedSet = new Set(
    (Array.isArray(value.tiedTitles) ? value.tiedTitles : [])
      .map(storedNewSongChoice)
      .filter(Boolean)
  );
  const storedChoices = [...NEW_SONG_CHOICES, ...LEGACY_NEW_SONG_CHOICES];
  const tiedTitles = storedChoices.filter((title) => tiedSet.has(title));
  const requestedFeatured = storedNewSongChoice(value.featuredWinner);
  const featuredWinner = requestedFeatured && tiedSet.has(requestedFeatured)
    ? requestedFeatured
    : tiedTitles[0] || null;
  if (!featuredWinner) return null;
  const parsedTotalVotes = Number(value.totalVotes);
  const parsedMaxVotes = Number(value.maxVotes);
  return {
    totalVotes: Number.isSafeInteger(parsedTotalVotes) && parsedTotalVotes >= 0 ? parsedTotalVotes : 0,
    maxVotes: Number.isSafeInteger(parsedMaxVotes) && parsedMaxVotes >= 0 ? parsedMaxVotes : 0,
    isTie: tiedTitles.length > 1,
    tiedTitles,
    featuredWinner,
    tieBreakRule: "canonical-list-order",
  };
}

function normalizeNewSongSessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && NEW_SONG_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function defaultNewSongSession(sessionNumber, options = {}) {
  const runNumber = normalizeRunNumber(options.runNumber);
  const parsedVersion = Number(options.version);
  return {
    sessionNumber,
    runId: normalizeActivityRunId(options.runId, "newsong", sessionNumber, runNumber),
    runNumber,
    phase: "welcome",
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    result: null,
    startedAt: null,
    updatedAt: earliestTimestamp(options.updatedAt),
    completedAt: null,
  };
}

function normalizeNewSongSessionRecord(value, sessionNumber) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parsedVersion = Number(raw.version);
  const runNumber = normalizeRunNumber(raw.runNumber);
  const phase = NEW_SONG_PHASES.has(raw.phase) ? raw.phase : "welcome";
  return {
    sessionNumber,
    runId: normalizeActivityRunId(raw.runId, "newsong", sessionNumber, runNumber),
    runNumber,
    phase,
    version: Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0,
    result: ["winner", "verse", "complete"].includes(phase)
      ? normalizeNewSongResult(raw.result)
      : null,
    startedAt: earliestTimestamp(raw.startedAt),
    updatedAt: earliestTimestamp(raw.updatedAt),
    completedAt: phase === "complete" ? earliestTimestamp(raw.completedAt) : null,
  };
}

function normalizeNewSongVotes(value) {
  if (!Array.isArray(value)) return [];
  const votesByParticipant = new Map();
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const attendeeId = String(raw.attendeeId || "").trim();
    const canonicalTitle = canonicalNewSongChoice(raw.songTitle);
    const legacyTitle = String(raw.songTitle || "").trim();
    const songTitle = canonicalTitle || (LEGACY_NEW_SONG_CHOICES.has(legacyTitle) ? legacyTitle : null);
    if (!attendeeId || !songTitle) return;
    const sessionNumber = normalizeStoredActivitySessionNumber(raw.sessionNumber);
    const runNumber = normalizeRunNumber(raw.runNumber);
    const runId = sessionNumber
      ? normalizeActivityRunId(raw.runId, "newsong", sessionNumber, runNumber)
      : null;
    const vote = {
      id: String(raw.id || `legacy-${runId || "unscoped"}-${attendeeId}`),
      attendeeId,
      name: String(raw.name || "Guest").trim() || "Guest",
      sessionNumber,
      runId,
      runNumber: sessionNumber ? runNumber : null,
      songTitle,
      votedAt: earliestTimestamp(raw.votedAt, raw.updatedAt),
      updatedAt: earliestTimestamp(raw.updatedAt, raw.votedAt),
    };
    votesByParticipant.set(`${runId || "legacy"}:${attendeeId}`, vote);
  });
  return Array.from(votesByParticipant.values());
}

function requireNewSongSessionNumber(value) {
  const sessionNumber = normalizeNewSongSessionNumber(value);
  return sessionNumber
    ? { sessionNumber }
    : { error: errorResult(400, "Choose New Song Session 1 or 2.", "INVALID_NEW_SONG_SESSION") };
}

function newSongSessionFromDb(db, sessionNumber) {
  return normalizeNewSongSessionRecord(db.newSongSessions[String(sessionNumber)], sessionNumber);
}

function requireHeavenSessionNumber(value) {
  const sessionNumber = normalizeHeavenSessionNumber(value);
  return sessionNumber
    ? { sessionNumber }
    : { error: errorResult(400, "Choose Draw Heaven Session 1 or 2.", "INVALID_HEAVEN_SESSION") };
}

function heavenSessionFromDb(db, sessionNumber) {
  return normalizeHeavenSessionRecord(db.heavenSessions[String(sessionNumber)], sessionNumber);
}

function requireArtSessionNumber(value) {
  const sessionNumber = normalizeArtSessionNumber(value);
  return sessionNumber
    ? { sessionNumber }
    : { error: errorResult(400, "Choose Art Therapy Session 1 or 2.", "INVALID_ART_SESSION") };
}

function artSessionFromDb(db, sessionNumber) {
  return normalizeArtSessionRecord(db.artSessions[String(sessionNumber)], sessionNumber);
}

function requireTriviaSessionNumber(value) {
  const sessionNumber = normalizeTriviaSessionNumber(value);
  return sessionNumber
    ? { sessionNumber }
    : { error: errorResult(400, "Choose Bible Bowl Session 1 or 2.", "INVALID_TRIVIA_SESSION") };
}

function triviaSessionFromDb(db, sessionNumber) {
  return normalizeTriviaSessionRecord(db.triviaSessions[String(sessionNumber)], sessionNumber);
}

function triviaQuestionAt(index, includeAnswer = false) {
  const question = TRIVIA_QUESTIONS[index];
  if (!question) return null;
  const result = {
    id: question.id,
    number: index + 1,
    category: question.category,
    text: question.text,
    choices: question.choices.slice(),
  };
  if (includeAnswer) {
    result.correctIndex = question.correctIndex;
    result.correctText = question.choices[question.correctIndex];
  }
  return result;
}

function triviaAssignedColorId(sessionNumber) {
  const sessionIndex = sessionNumber - 1;
  const entry = Object.entries(WRISTBAND_ROUTES)
    .find(([, route]) => route[sessionIndex] === "trivia");
  return entry ? entry[0] : null;
}

function triviaAssignedColor(sessionNumber) {
  const id = triviaAssignedColorId(sessionNumber);
  return id ? { id, label: `${id.charAt(0).toUpperCase()}${id.slice(1)}` } : null;
}

function triviaSessionLabel(sessionNumber) {
  const session = BOOTH_SESSIONS[sessionNumber - 1];
  return session ? session.label : `Session ${sessionNumber}`;
}

function heavenAssignedColorId(sessionNumber) {
  const sessionIndex = sessionNumber - 1;
  const entry = Object.entries(WRISTBAND_ROUTES)
    .find(([, route]) => route[sessionIndex] === "heaven");
  return entry ? entry[0] : null;
}

function heavenAssignedColor(sessionNumber) {
  const id = heavenAssignedColorId(sessionNumber);
  return id ? { id, label: `${id.charAt(0).toUpperCase()}${id.slice(1)}` } : null;
}

function heavenSessionLabel(sessionNumber) {
  const session = BOOTH_SESSIONS[sessionNumber - 1];
  return session ? session.label : `Session ${sessionNumber}`;
}

function artAssignedColorId(sessionNumber) {
  const sessionIndex = sessionNumber - 1;
  const entry = Object.entries(WRISTBAND_ROUTES)
    .find(([, route]) => route[sessionIndex] === "art");
  return entry ? entry[0] : null;
}

function artAssignedColor(sessionNumber) {
  const id = artAssignedColorId(sessionNumber);
  return id ? { id, label: `${id.charAt(0).toUpperCase()}${id.slice(1)}` } : null;
}

function artSessionLabel(sessionNumber) {
  const session = BOOTH_SESSIONS[sessionNumber - 1];
  return session ? session.label : `Session ${sessionNumber}`;
}

function newSongAssignedColorId(sessionNumber) {
  const sessionIndex = sessionNumber - 1;
  const entry = Object.entries(WRISTBAND_ROUTES)
    .find(([, route]) => route[sessionIndex] === "newsong");
  return entry ? entry[0] : null;
}

function newSongAssignedColor(sessionNumber) {
  const id = newSongAssignedColorId(sessionNumber);
  return id ? { id, label: `${id.charAt(0).toUpperCase()}${id.slice(1)}` } : null;
}

function newSongSessionLabel(sessionNumber) {
  const session = BOOTH_SESSIONS[sessionNumber - 1];
  return session ? session.label : `Session ${sessionNumber}`;
}

function triviaQuestionsRevealed(session) {
  if (session.questionIndex < 0) return 0;
  return session.phase === "question" ? session.questionIndex : session.questionIndex + 1;
}

function triviaAnswersFor(db, attendeeId, sessionNumber, runId) {
  return db.triviaAnswers.filter((answer) => (
    answer.attendeeId === attendeeId
      && answer.sessionNumber === sessionNumber
      && (!runId || answer.runId === runId)
  ));
}

function triviaScore(db, attendeeId, sessionNumber, session) {
  const answers = triviaAnswersFor(db, attendeeId, sessionNumber, session.runId);
  const revealedCount = triviaQuestionsRevealed(session);
  const scoredAnswers = answers.filter((answer) => answer.questionNumber <= revealedCount);
  return {
    correctCount: scoredAnswers.filter((answer) => answer.isCorrect).length,
    answeredCount: answers.length,
    totalQuestions: session.phase === "complete"
      ? revealedCount
      : TRIVIA_QUESTIONS.length,
  };
}

function attendeeTriviaContext(db, attendeeId) {
  if (!attendeeId) return { error: errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED") };
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return { error: errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND") };
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return { error: errorResult(409, "Bible Bowl is not in an active booth session.", "TRIVIA_SESSION_CLOSED") };
  }
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (!attendee.wristbandConfirmedAt || assignedBooth !== "trivia") {
    return { error: errorResult(403, "Bible Bowl is not your assigned booth in this session.", "TRIVIA_NOT_ASSIGNED") };
  }
  const arrivalError = lateArrivalAccessError(attendee, eventState);
  if (arrivalError) return { error: arrivalError };
  return { attendee, eventState, sessionNumber: eventState.sessionNumber };
}

function attendeeHeavenContext(db, attendeeId) {
  if (!attendeeId) return { error: errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED") };
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return { error: errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND") };
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return { error: errorResult(409, "Draw Heaven is not in an active booth session.", "HEAVEN_SESSION_CLOSED") };
  }
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (!attendee.wristbandConfirmedAt || assignedBooth !== "heaven") {
    return { error: errorResult(403, "Draw Heaven is not your assigned booth in this session.", "HEAVEN_NOT_ASSIGNED") };
  }
  const arrivalError = lateArrivalAccessError(attendee, eventState);
  if (arrivalError) return { error: arrivalError };
  return { attendee, eventState, sessionNumber: eventState.sessionNumber };
}

function attendeeArtContext(db, attendeeId) {
  if (!attendeeId) return { error: errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED") };
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return { error: errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND") };
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return { error: errorResult(409, "Art Therapy is not in an active booth session.", "ART_SESSION_CLOSED") };
  }
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (!attendee.wristbandConfirmedAt || assignedBooth !== "art") {
    return { error: errorResult(403, "Art Therapy is not your assigned booth in this session.", "ART_NOT_ASSIGNED") };
  }
  const arrivalError = lateArrivalAccessError(attendee, eventState);
  if (arrivalError) return { error: arrivalError };
  return { attendee, eventState, sessionNumber: eventState.sessionNumber };
}

function attendeeNewSongContext(db, attendeeId) {
  if (!attendeeId) return { error: errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED") };
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return { error: errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND") };
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return { error: errorResult(409, "New Song is not in an active booth session.", "NEW_SONG_SESSION_CLOSED") };
  }
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (!attendee.wristbandConfirmedAt || assignedBooth !== "newsong") {
    return { error: errorResult(403, "New Song is not your assigned booth in this session.", "NEW_SONG_NOT_ASSIGNED") };
  }
  const arrivalError = lateArrivalAccessError(attendee, eventState);
  if (arrivalError) return { error: arrivalError };
  return { attendee, eventState, sessionNumber: eventState.sessionNumber };
}

function attendeesAssignedToBoothSession(db, boothId, sessionNumber) {
  const sessionIndex = sessionNumber - 1;
  return db.attendees.filter((attendee) => {
    const colorId = normalizeWristbandColor(attendee.wristbandColor);
    return attendee.wristbandConfirmedAt
      && colorId
      && WRISTBAND_ROUTES[colorId]
      && WRISTBAND_ROUTES[colorId][sessionIndex] === boothId
      && attendeeCanJoinSession(attendee, sessionNumber);
  });
}

function emptyHeavenConfirmationMap() {
  return HEAVEN_CONFIRMATION_ACTIONS.reduce((result, action) => {
    result[action] = false;
    return result;
  }, {});
}

function heavenConfirmationsFor(db, sessionNumber, runId, attendeeId = null) {
  return db.heavenConfirmations.filter((confirmation) => (
    confirmation.sessionNumber === sessionNumber
      && confirmation.runId === runId
      && (!attendeeId || confirmation.attendeeId === attendeeId)
  ));
}

function heavenParticipantState(db, attendeeId, session) {
  const rows = heavenConfirmationsFor(db, session.sessionNumber, session.runId, attendeeId);
  const confirmations = emptyHeavenConfirmationMap();
  const confirmedAt = {};
  rows.forEach((row) => {
    confirmations[row.action] = true;
    confirmedAt[row.action] = row.confirmedAt;
  });
  return {
    confirmations,
    confirmedAt,
    completedAt: confirmedAt.programs_done || null,
  };
}

function archiveTriviaRun(db, session, archiveReason, archivedAt) {
  if (db.triviaRunHistory.some((run) => (
    run.sessionNumber === session.sessionNumber && run.runId === session.runId
  ))) return;
  db.triviaRunHistory.push({
    sessionNumber: session.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    phase: session.phase,
    questionIndex: session.questionIndex,
    version: session.version,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    archivedAt,
    archiveReason,
  });
}

function archiveHeavenRun(db, session, archiveReason, archivedAt) {
  if (db.heavenRunHistory.some((run) => (
    run.sessionNumber === session.sessionNumber && run.runId === session.runId
  ))) return;
  db.heavenRunHistory.push({
    sessionNumber: session.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    phase: session.phase,
    version: session.version,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    archivedAt,
    archiveReason,
  });
}

function archiveArtRun(db, session, archiveReason, archivedAt) {
  if (db.artRunHistory.some((run) => (
    run.sessionNumber === session.sessionNumber && run.runId === session.runId
  ))) return;
  db.artRunHistory.push({
    sessionNumber: session.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    phase: session.phase,
    version: session.version,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    archivedAt,
    archiveReason,
  });
}

function archiveNewSongRun(db, session, archiveReason, archivedAt) {
  if (db.newSongRunHistory.some((run) => (
    run.sessionNumber === session.sessionNumber && run.runId === session.runId
  ))) return;
  db.newSongRunHistory.push({
    sessionNumber: session.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    phase: session.phase,
    version: session.version,
    result: session.result,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    archivedAt,
    archiveReason,
  });
}

function triviaBoothPresentation(db, eventState = eventSessionState()) {
  const sessionNumber = eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
  const session = triviaSessionFromDb(db, sessionNumber);
  let stepIndex = 0;
  let status = "waiting";
  let screenTitle = "Welcome to Bible Bowl";
  let message = "The Bible Bowl leader will start the first question when the group is ready.";
  if (session.phase === "question" || session.phase === "reveal") {
    status = "live";
    stepIndex = session.questionIndex < 5 ? 1 : session.questionIndex < 10 ? 2 : 3;
    screenTitle = session.phase === "reveal"
      ? `Question ${session.questionIndex + 1} answer revealed`
      : `Question ${session.questionIndex + 1} is open`;
    message = session.phase === "reveal"
      ? `Question ${session.questionIndex + 1} answer revealed. Keep the activity open for what comes next.`
      : `Question ${session.questionIndex + 1} of ${TRIVIA_QUESTIONS.length} is open in the Bible Bowl activity.`;
  } else if (session.phase === "complete") {
    status = "complete";
    stepIndex = 4;
    screenTitle = "Final Bible Bowl results";
    message = "Final Bible Bowl results are ready. Open the activity to finish this visit.";
  }
  return {
    boothId: "trivia",
    stepIndex,
    status,
    screenTitle,
    screenBody: message,
    message,
    createdAt: session.startedAt,
    updatedAt: session.updatedAt,
    version: session.version,
  };
}

function heavenBoothPresentation(db, eventState = eventSessionState()) {
  const sessionNumber = eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
  const session = heavenSessionFromDb(db, sessionNumber);
  const phaseDetails = {
    welcome: [0, "waiting", "Welcome to Draw Heaven", "The leader will begin when everyone is ready."],
    drawing: [1, "live", "Draw what Heaven looks like", "Draw what comes to mind, then respond on your screen."],
    verse: [2, "live", "Revelation 21:10–11", "The Bible description of the Holy City is now open on attendee screens."],
    comparison: [3, "live", "New Jerusalem size comparison", "The United States comparison is now open on attendee screens."],
    reflection: [4, "live", "Reflection question", "The leader is guiding the group through the final reflection."],
    programs: [5, "live", "Five-program preview", "Explore the five programs, then confirm when you are ready."],
    complete: [6, "complete", "Draw Heaven complete", "Attendees can finish this booth visit."],
  };
  const [stepIndex, status, screenTitle, screenBody] = phaseDetails[session.phase];
  return {
    boothId: "heaven",
    stepIndex,
    status,
    screenTitle,
    screenBody,
    message: screenBody,
    createdAt: session.startedAt,
    updatedAt: session.updatedAt,
    version: session.version,
  };
}

function artBoothPresentation(db, eventState = eventSessionState()) {
  const sessionNumber = eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
  const session = artSessionFromDb(db, sessionNumber);
  const phaseDetails = {
    welcome: [0, "waiting", "Welcome to Art Therapy", "The booth leader will begin when everyone is ready."],
    definition: [1, "live", "What is art therapy?", "The definition is now open on attendee screens."],
    importance: [2, "live", "Why is art therapy important?", "Follow the booth leader on your screen."],
    purpose_image: [3, "live", "Heart-and-mind picture", "The supplied visual is now showing on attendee screens."],
    heart_question: [4, "live", "What does the Bible say about the heart?", "The question is now open."],
    proverbs: [4, "live", "Proverbs 4:23", "The first Bible passage is now showing."],
    philippians: [4, "live", "Proverbs 4:23 and Philippians 4:7", "Both Bible passages are now showing together."],
    create: [5, "live", "Now it’s your turn", "It is time for the guided Art Therapy activity."],
    finished: [6, "wrap", "I’m finished—now what?", "The final reflection is now showing on attendee screens."],
    complete: [7, "complete", "Art Therapy complete", "Attendees can finish this booth visit."],
  };
  const [stepIndex, status, screenTitle, screenBody] = phaseDetails[session.phase];
  return {
    boothId: "art",
    stepIndex,
    status,
    screenTitle,
    screenBody,
    message: screenBody,
    createdAt: session.startedAt,
    updatedAt: session.updatedAt,
    version: session.version,
  };
}

function newSongBoothPresentation(db, eventState = eventSessionState()) {
  const sessionNumber = eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
  const session = newSongSessionFromDb(db, sessionNumber);
  const phaseDetails = {
    welcome: [0, "waiting", "Welcome to New Song", "The booth leader will open the poll when everyone is ready."],
    voting: [1, "live", "Voting is open", "Choose one song on the activity screen."],
    winner: [2, "live", "The winning song", "The poll is closed and the room result is ready."],
    verse: [3, "live", "Revelation 14:3", "The Bible passage and artwork are now showing."],
    complete: [4, "complete", "New Song complete", "Attendees can finish this booth visit."],
  };
  const [stepIndex, status, screenTitle, screenBody] = phaseDetails[session.phase];
  return {
    boothId: "newsong",
    stepIndex,
    status,
    screenTitle,
    screenBody,
    message: screenBody,
    createdAt: session.startedAt,
    updatedAt: session.updatedAt,
    version: session.version,
  };
}

function organizerKeyMatches(value) {
  const supplied = Buffer.from(String(value || ""));
  const expected = Buffer.from(ORGANIZER_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function errorResult(status, error, code) {
  return { status, body: { error, code } };
}

function requireOrganizer(body) {
  return organizerKeyMatches(body && body.organizerKey)
    ? null
    : errorResult(401, "Organizer access key is invalid.", "AUTH_REQUIRED");
}

function findAttendeeById(db, attendeeId) {
  if (!attendeeId) return null;
  return db.attendees.find((a) => a.attendeeId === attendeeId || (a.aliasIds || []).includes(attendeeId));
}

function findAttendeeByPhone(db, phone) {
  const dPhone = digitsOnly(phone);
  if (!dPhone) return null;
  return db.attendees.find((a) => a.phone === dPhone);
}

function findAttendeesByPhone(db, phone) {
  const dPhone = digitsOnly(phone);
  if (!dPhone) return [];
  return db.attendees.filter((attendee) => attendee.phone === dPhone);
}

function findAttendeeByNameAndPhone(db, name, phone) {
  const normalizedName = normalizeAttendeeName(name);
  if (!normalizedName) return null;
  return findAttendeesByPhone(db, phone).find(
    (attendee) => normalizeAttendeeName(attendee.name) === normalizedName
  ) || null;
}

function findAttendeeByRaffle(db, raffleNumber) {
  const normalized = normalizeRaffleNumber(raffleNumber);
  if (!normalized) return null;
  return db.attendees.find((a) => String(a.raffleNumber) === normalized);
}

// Find an attendee by attendeeId (checking aliases too — a phone number
// can get linked to more than one device/attendeeId over the course of
// the day) or by phone.
function findAttendee(db, { attendeeId, phone }) {
  return findAttendeeById(db, attendeeId) || findAttendeeByPhone(db, phone);
}

function meaningfulName(primary, fallback) {
  if (primary && primary !== "Guest") return primary;
  if (fallback) return fallback;
  return primary || "Guest";
}

function earliestTimestamp(...values) {
  return values.filter(Boolean).reduce((earliest, value) => {
    const candidate = String(value);
    const candidateMs = Date.parse(candidate);
    if (Number.isNaN(candidateMs)) return earliest;
    if (!earliest || candidateMs < Date.parse(earliest)) return candidate;
    return earliest;
  }, null);
}

function mergeAttendees(db, canonical, duplicate, phone) {
  if (!canonical || !duplicate || canonical === duplicate) return canonical;

  const duplicateIds = new Set([duplicate.attendeeId, ...(duplicate.aliasIds || [])]);
  canonical.aliasIds = Array.from(new Set([
    ...(canonical.aliasIds || []),
    ...duplicateIds,
  ])).filter((value) => value && value !== canonical.attendeeId);
  canonical.phone = digitsOnly(phone) || canonical.phone || duplicate.phone || null;
  canonical.name = meaningfulName(canonical.name, duplicate.name);
  canonical.wristbandConfirmedAt = earliestTimestamp(
    canonical.wristbandConfirmedAt,
    duplicate.wristbandConfirmedAt
  );
  canonical.phase3CompletedAt = earliestTimestamp(
    canonical.phase3CompletedAt,
    duplicate.phase3CompletedAt
  );
  canonical.wristbandColor = normalizeWristbandColor(canonical.wristbandColor)
    || normalizeWristbandColor(duplicate.wristbandColor)
    || null;
  if (!canonical.registeredAt || (duplicate.registeredAt && duplicate.registeredAt < canonical.registeredAt)) {
    canonical.registeredAt = duplicate.registeredAt;
  }

  [db.boothCheckins, db.songVotes, db.signups].forEach((rows) => {
    rows.forEach((row) => {
      if (!duplicateIds.has(row.attendeeId)) return;
      row.attendeeId = canonical.attendeeId;
      row.phone = canonical.phone;
      row.name = canonical.name;
    });
  });
  db.boothCheckins = normalizeBoothCheckins(db.boothCheckins);
  db.songVotes = normalizeNewSongVotes(db.songVotes);
  db.triviaAnswers.forEach((answer) => {
    if (duplicateIds.has(answer.attendeeId)) answer.attendeeId = canonical.attendeeId;
  });
  db.triviaAnswers = normalizeTriviaAnswers(db.triviaAnswers);
  db.heavenConfirmations.forEach((confirmation) => {
    if (duplicateIds.has(confirmation.attendeeId)) confirmation.attendeeId = canonical.attendeeId;
  });
  db.heavenConfirmations = normalizeHeavenConfirmations(db.heavenConfirmations);
  db.artCompletions.forEach((completion) => {
    if (duplicateIds.has(completion.attendeeId)) completion.attendeeId = canonical.attendeeId;
  });
  db.artCompletions = normalizeArtCompletions(db.artCompletions);
  db.attendees = db.attendees.filter((attendee) => attendee !== duplicate);
  return canonical;
}

// ---------- API actions (request body/query already parsed) ----------

function cleanAttendeeName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= 80 ? name : "";
}

function registerAttendee(body) {
  const attendeeId = String((body && body.attendeeId) || "").trim();
  const name = cleanAttendeeName(body && body.name);
  const phoneWasSupplied = Boolean(body && String(body.phone || "").trim());
  const phone = digitsOnly(body && body.phone);
  const selfService = phoneWasSupplied && phone.length === 10;
  if (!attendeeId || attendeeId.length > 128 || !name) {
    return errorResult(400, "Enter your name and a valid event-pass ID.", "REGISTRATION_FIELDS_REQUIRED");
  }
  if (phoneWasSupplied && !selfService) {
    return errorResult(400, "Enter a valid 10-digit mobile number.", "INVALID_PHONE");
  }
  if (!selfService) {
    const authError = requireOrganizer(body);
    if (authError) return authError;
  }

  const db = readDb();
  const existingById = findAttendeeById(db, attendeeId);
  const existingByIdentity = selfService ? findAttendeeByNameAndPhone(db, name, phone) : null;
  if (
    existingById
      && selfService
      && (
        normalizeAttendeeName(existingById.name) !== normalizeAttendeeName(name)
          || (existingById.phone && existingById.phone !== phone)
      )
  ) {
    return errorResult(
      409,
      "This event pass is already connected to another name or phone. Ask an organizer for help.",
      "ATTENDEE_IDENTITY_CONFLICT"
    );
  }

  let attendee = existingById && existingByIdentity && existingById !== existingByIdentity
    ? mergeAttendees(db, existingById, existingByIdentity, phone)
    : existingById || existingByIdentity;
  let isNew = false;
  if (!attendee) {
    isNew = true;
    db.raffleCounter += 1;
    attendee = {
      attendeeId, aliasIds: [], name, phone: selfService ? phone : null,
      raffleNumber: String(db.raffleCounter),
      wristbandConfirmedAt: null, registeredAt: eventNowIso(), wristbandColor: null,
      phase3CompletedAt: null,
    };
    db.attendees.push(attendee);
  } else if (selfService) {
    if (existingByIdentity && !existingById && attendee.attendeeId !== attendeeId) {
      attendee.aliasIds = Array.from(new Set([...(attendee.aliasIds || []), attendeeId]));
    }
    attendee.name = name;
    attendee.phone = phone;
  } else {
    attendee.name = name;
  }
  writeDb(db);
  return {
    status: 200,
    body: {
      ...attendeePortalResult(attendee),
      isNew,
    },
  };
}

function confirmWristband(body) {
  const { attendeeId, wristbandColor } = body;
  const colorResult = requireWristbandColor(wristbandColor);
  if (colorResult.error) return colorResult.error;
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId });
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const existingColor = normalizeWristbandColor(attendee.wristbandColor);
  if (attendee.wristbandConfirmedAt && existingColor && existingColor !== colorResult.color && !organizerKeyMatches(body.organizerKey)) {
    return errorResult(
      409,
      "This wristband color is already assigned. Ask an organizer to correct it.",
      "WRISTBAND_ALREADY_ASSIGNED"
    );
  }
  if (attendee.wristbandConfirmedAt && existingColor === colorResult.color) {
    return {
      status: 200,
      body: {
        ok: true,
        wristbandColor: existingColor,
        wristbandConfirmedAt: attendee.wristbandConfirmedAt,
        boothArrivalPlan: attendeeArrivalPlan(attendee),
      },
    };
  }
  // A staff correction changes only the color. The original Phase 2 admission
  // time remains the late-arrival anchor across corrections and refreshes.
  attendee.wristbandConfirmedAt = attendee.wristbandConfirmedAt || eventNowIso();
  attendee.wristbandColor = colorResult.color;
  writeDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      wristbandColor: attendee.wristbandColor,
      wristbandConfirmedAt: attendee.wristbandConfirmedAt,
      boothArrivalPlan: attendeeArrivalPlan(attendee),
    },
  };
}

function attendeePortalResult(attendee) {
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name,
    raffleNumber: attendee.raffleNumber,
    wristbandConfirmed: !!attendee.wristbandConfirmedAt,
    wristbandConfirmedAt: attendee.wristbandConfirmedAt || null,
    boothArrivalPlan: attendeeArrivalPlan(attendee),
    wristbandColor: normalizeWristbandColor(attendee.wristbandColor),
    phoneLinked: !!attendee.phone,
    phase3CompletedAt: attendee.phase3CompletedAt || null,
    serverNow: eventNowIso(),
    dataResetAt: readDb().dataResetAt,
  };
}

function loginAttendee(body) {
  const normalizedName = normalizeAttendeeName(body && body.name);
  const phone = digitsOnly(body && body.phone);
  if (!normalizedName || phone.length !== 10) {
    return errorResult(400, "name and a 10-digit phone number are required", "LOGIN_FIELDS_REQUIRED");
  }

  const db = readDb();
  const attendee = findAttendeeByNameAndPhone(db, normalizedName, phone);
  if (!attendee) {
    return errorResult(401, "We couldn't match that name and phone number.", "ATTENDEE_LOGIN_FAILED");
  }
  if (body.portal === "phase2" && !attendee.wristbandConfirmedAt) {
    return errorResult(403, "Finish Phase 1 wristband check-in before opening Phase 2.", "PHASE1_INCOMPLETE");
  }
  return { status: 200, body: attendeePortalResult(attendee) };
}

function attendeePortalSession(body) {
  const attendeeId = body && body.attendeeId;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  if (body.portal === "phase2" && !attendee.wristbandConfirmedAt) {
    return errorResult(403, "Finish Phase 1 wristband check-in before opening Phase 2.", "PHASE1_INCOMPLETE");
  }
  return { status: 200, body: attendeePortalResult(attendee) };
}

function findOrRegisterByPhone(body) {
  const { attendeeId, phone, name, raffleNumber, allowCreate, organizerKey, confirmPairing } = body;
  const dPhone = digitsOnly(phone);
  if (dPhone.length !== 10) {
    return errorResult(400, "phone must contain exactly 10 digits", "INVALID_PHONE");
  }
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const normalizedRaffle = normalizeRaffleNumber(raffleNumber);
  const isOrganizer = organizerKeyMatches(organizerKey);

  // Staff kiosks have no attendee identity of their own. Their phone lookup,
  // raffle pairing, and skip-entry creation path are organizer-only.
  if (!attendeeId && !isOrganizer) return requireOrganizer(body);
  if (normalizedRaffle && !isOrganizer) return requireOrganizer(body);

  const db = readDb();
  const phoneAttendees = findAttendeesByPhone(db, dPhone);
  const exactPhoneAttendee = findAttendeeByNameAndPhone(db, name, dPhone);
  const phoneAttendee = exactPhoneAttendee || (phoneAttendees.length === 1 ? phoneAttendees[0] : null);
  const idAttendee = findAttendeeById(db, attendeeId);

  if (normalizedRaffle) {
    let raffleAttendee = findAttendeeByRaffle(db, normalizedRaffle);
    if (!raffleAttendee) {
      return errorResult(404, "No attendee has that raffle number.", "RAFFLE_NOT_FOUND");
    }
    if (raffleAttendee.phone && raffleAttendee.phone !== dPhone) {
      return errorResult(409, "That raffle number is already linked to another phone.", "IDENTITY_CONFLICT");
    }
    const duplicateIdentity = findAttendeeByNameAndPhone(db, raffleAttendee.name, dPhone);
    const duplicateForPairing = duplicateIdentity
      || (phoneAttendees.length === 1 ? phoneAttendees[0] : null);
    const needsPairing = !raffleAttendee.phone
      || (duplicateForPairing && duplicateForPairing !== raffleAttendee);
    if (needsPairing && confirmPairing !== true) {
      return {
        status: 200,
        body: {
          requiresPairingConfirmation: true,
          raffleNumber: raffleAttendee.raffleNumber,
          name: raffleAttendee.name,
        },
      };
    }
    if (duplicateForPairing && duplicateForPairing !== raffleAttendee) {
      raffleAttendee = mergeAttendees(db, raffleAttendee, duplicateForPairing, dPhone);
    }
    raffleAttendee.phone = dPhone;
    writeDb(db);
    return {
      status: 200,
      body: {
        attendeeId: raffleAttendee.attendeeId,
        raffleNumber: raffleAttendee.raffleNumber,
        isNew: false,
        name: raffleAttendee.name,
        wristbandColor: normalizeWristbandColor(raffleAttendee.wristbandColor),
      },
    };
  }

  if (idAttendee) {
    if (idAttendee.phone && idAttendee.phone !== dPhone) {
      return errorResult(409, "This attendee is already linked to another phone.", "IDENTITY_CONFLICT");
    }
    const resolvedAttendee = exactPhoneAttendee && exactPhoneAttendee !== idAttendee
      ? mergeAttendees(db, idAttendee, exactPhoneAttendee, dPhone)
      : idAttendee;
    resolvedAttendee.phone = dPhone;
    writeDb(db);
    return {
      status: 200,
      body: {
        attendeeId: resolvedAttendee.attendeeId,
        raffleNumber: resolvedAttendee.raffleNumber,
        isNew: false,
        name: resolvedAttendee.name,
        wristbandColor: normalizeWristbandColor(resolvedAttendee.wristbandColor),
      },
    };
  }

  if (!exactPhoneAttendee && phoneAttendees.length > 1) {
    return errorResult(
      409,
      "More than one attendee uses that phone. Enter the attendee's raffle number or exact name.",
      "PHONE_AMBIGUOUS"
    );
  }

  if (phoneAttendee) {
    if (attendeeId && phoneAttendee.attendeeId !== attendeeId && !(phoneAttendee.aliasIds || []).includes(attendeeId)) {
      phoneAttendee.aliasIds = Array.from(new Set([...(phoneAttendee.aliasIds || []), attendeeId]));
    }
    writeDb(db);
    return {
      status: 200,
      body: {
        attendeeId: phoneAttendee.attendeeId,
        raffleNumber: phoneAttendee.raffleNumber,
        isNew: false,
        name: phoneAttendee.name,
        wristbandColor: normalizeWristbandColor(phoneAttendee.wristbandColor),
      },
    };
  }

  // Self-service devices must have registered at Entry first. Only an
  // authenticated staff kiosk may create a true skipped-entry visitor.
  if (attendeeId && !isOrganizer) {
    return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  }

  if (!attendeeId && allowCreate !== true) {
    return errorResult(409, "Enter the visitor's raffle number, or mark that they skipped entry.", "RAFFLE_REQUIRED");
  }

  db.raffleCounter += 1;
  const attendee = {
    attendeeId: attendeeId || id(), aliasIds: [], name: name || "Guest", phone: dPhone,
    raffleNumber: String(db.raffleCounter), wristbandConfirmedAt: null, registeredAt: eventNowIso(),
    wristbandColor: null,
  };
  db.attendees.push(attendee);
  writeDb(db);
  return {
    status: 200,
    body: {
      attendeeId: attendee.attendeeId,
      raffleNumber: attendee.raffleNumber,
      isNew: true,
      name: attendee.name,
      wristbandColor: null,
    },
  };
}

function boothCheckin(body) {
  const { attendeeId, phone, boothId, boothName, checkedInBy, rating, note, extraData } = body;
  if (!boothId) return { status: 400, body: { error: "boothId required" } };
  if (checkedInBy === "staff-kiosk") {
    const authError = requireOrganizer(body);
    if (authError) return authError;
  }
  const attendeeCompletion = ["self", "scheduled-attendee"].includes(String(checkedInBy || "self"));
  if (attendeeCompletion && boothId === "trivia") return completeTrivia({ attendeeId });
  if (attendeeCompletion && boothId === "heaven") return completeHeaven({ attendeeId });
  if (attendeeCompletion && boothId === "story") return completeStory({ attendeeId });
  if (attendeeCompletion && boothId === "newsong") return completeNewSong({ attendeeId });
  // Art Therapy completion is server-authoritative. Route every legacy or
  // direct generic Art check-in through the same active-session, wristband,
  // published-finale, and immutable-run checks used by the attendee room.
  if (boothId === "art") return completeArt({ attendeeId });
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  if (attendeeCompletion) {
    const eventState = eventSessionState();
    const colorId = normalizeWristbandColor(attendee.wristbandColor);
    const assignedBooth = eventState.phase === "active" && colorId && WRISTBAND_ROUTES[colorId]
      ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
      : null;
    if (assignedBooth !== boothId) {
      return errorResult(403, "This booth is not assigned to you in the current session.", "BOOTH_NOT_ASSIGNED");
    }
    const arrivalError = lateArrivalAccessError(attendee, eventState);
    if (arrivalError) return arrivalError;
  }
  if (phone && attendee.phone && attendee.phone !== digitsOnly(phone)) {
    return errorResult(409, "phone does not match attendee", "IDENTITY_CONFLICT");
  }
  const row = {
    id: id(),
    attendeeId: attendee.attendeeId,
    phone: attendee.phone,
    name: attendee.name,
    boothId, boothName: boothName || boothId,
    checkedInBy: checkedInBy || "self",
    checkedInAt: eventNowIso(),
    rating: rating || null, note: note || "", extraData: extraData || null,
  };
  const incomingRunId = row.extraData && typeof row.extraData === "object"
    ? String(row.extraData.runId || "").trim()
    : "";
  const existing = db.boothCheckins.find((checkin) => {
    if (checkin.attendeeId !== attendee.attendeeId || checkin.boothId !== boothId) return false;
    const existingRunId = checkin.extraData && typeof checkin.extraData === "object"
      ? String(checkin.extraData.runId || "").trim()
      : "";
    return (existingRunId || "legacy") === (incomingRunId || "legacy");
  });
  if (existing) {
    row.checkedInAt = existing.checkedInAt || row.checkedInAt;
    if (!Object.prototype.hasOwnProperty.call(body, "rating")) row.rating = existing.rating || null;
    if (!Object.prototype.hasOwnProperty.call(body, "note")) row.note = existing.note || "";
    const existingExtra = existing.extraData && typeof existing.extraData === "object" ? existing.extraData : {};
    const incomingExtra = row.extraData && typeof row.extraData === "object" ? row.extraData : {};
    row.extraData = Object.keys(existingExtra).length || Object.keys(incomingExtra).length
      ? Object.assign({}, existingExtra, incomingExtra)
      : null;
    const checkinId = existing.id;
    Object.assign(existing, row, { id: checkinId });
    writeDb(db);
    return { status: 200, body: { ok: true, checkinId, updated: true } };
  }
  db.boothCheckins.push(row);
  writeDb(db);
  return { status: 200, body: { ok: true, checkinId: row.id } };
}

function newSongVotesFor(db, sessionNumber, runId) {
  return db.songVotes.filter((vote) => (
    vote.sessionNumber === sessionNumber && vote.runId === runId
  ));
}

function newSongVoteCountsForRun(db, sessionNumber, runId) {
  const totals = new Map(NEW_SONG_CHOICES.map((title) => [title, 0]));
  newSongVotesFor(db, sessionNumber, runId).forEach((vote) => {
    totals.set(vote.songTitle, (totals.get(vote.songTitle) || 0) + 1);
  });
  return NEW_SONG_CHOICES.map((title) => ({ title, votes: totals.get(title) || 0 }));
}

function currentNewSongSessionNumber() {
  const eventState = eventSessionState();
  return eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
}

// Compatibility view used by the original generic dashboards. It now scopes
// totals to the active rotation/run instead of mixing groups across rotations.
function songVoteCounts(db) {
  const sessionNumber = currentNewSongSessionNumber();
  const session = newSongSessionFromDb(db, sessionNumber);
  const voteByAttendee = new Map();
  db.boothCheckins
    .filter((checkin) => {
      const extraData = checkin.extraData && typeof checkin.extraData === "object"
        ? checkin.extraData
        : {};
      const votedFor = extraData.votedFor;
      const scopedToRun = Number.isInteger(Number(extraData.sessionNumber))
        && Boolean(extraData.runId);
      return checkin.boothId === "newsong"
        && Boolean(canonicalNewSongChoice(votedFor))
        && (!scopedToRun || (
          Number(extraData.sessionNumber) === sessionNumber && extraData.runId === session.runId
        ));
    })
    .forEach((checkin) => voteByAttendee.set(
      checkin.attendeeId,
      canonicalNewSongChoice(checkin.extraData.votedFor)
    ));
  db.songVotes
    .filter((vote) => (
      Boolean(canonicalNewSongChoice(vote.songTitle))
        && (!vote.sessionNumber
          || (vote.sessionNumber === sessionNumber && vote.runId === session.runId))
    ))
    .forEach((vote) => voteByAttendee.set(vote.attendeeId, canonicalNewSongChoice(vote.songTitle)));
  const totals = new Map();
  voteByAttendee.forEach((title) => totals.set(title, (totals.get(title) || 0) + 1));
  return Array.from(totals, ([title, votes]) => ({ title, votes }))
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      const aIndex = NEW_SONG_CHOICES.indexOf(a.title);
      const bIndex = NEW_SONG_CHOICES.indexOf(b.title);
      if (aIndex >= 0 || bIndex >= 0) {
        return (aIndex >= 0 ? aIndex : Number.MAX_SAFE_INTEGER)
          - (bIndex >= 0 ? bIndex : Number.MAX_SAFE_INTEGER);
      }
      return a.title.localeCompare(b.title);
    });
}

function calculateNewSongResult(voteCounts) {
  const totalVotes = voteCounts.reduce((total, entry) => total + entry.votes, 0);
  if (totalVotes === 0) return null;
  const maxVotes = Math.max(...voteCounts.map((entry) => entry.votes));
  const tiedTitles = voteCounts
    .filter((entry) => entry.votes === maxVotes)
    .map((entry) => entry.title);
  return {
    totalVotes,
    maxVotes,
    isTie: tiedTitles.length > 1,
    tiedTitles,
    featuredWinner: tiedTitles[0],
    tieBreakRule: "canonical-list-order",
  };
}

function newSongWinnerView(result) {
  if (!result || !result.featuredWinner) return null;
  return {
    songTitle: result.featuredWinner,
    voteCount: result.maxVotes,
    tied: result.isTie,
    tiedSongs: result.tiedTitles.slice(),
  };
}

function newSongVoteForAttendee(db, attendeeId, session) {
  return newSongVotesFor(db, session.sessionNumber, session.runId)
    .find((vote) => vote.attendeeId === attendeeId) || null;
}

function newSongStateBody(db, context, session) {
  const vote = newSongVoteForAttendee(db, context.attendee.attendeeId, session);
  const resultVisible = ["winner", "verse", "complete"].includes(session.phase)
    ? session.result
    : null;
  const visibleCounts = resultVisible
    ? newSongVoteCountsForRun(db, context.sessionNumber, session.runId)
    : [];
  return {
    sessionNumber: context.sessionNumber,
    sessionLabel: newSongSessionLabel(context.sessionNumber),
    assignedColor: newSongAssignedColor(context.sessionNumber),
    phase: session.phase,
    version: session.version,
    runId: session.runId,
    runNumber: session.runNumber,
    choices: NEW_SONG_CHOICES.slice(),
    vote: vote ? { songTitle: vote.songTitle, votedAt: vote.votedAt } : null,
    voteCounts: visibleCounts,
    songCounts: visibleCounts,
    totalVotes: resultVisible ? resultVisible.totalVotes : null,
    result: resultVisible,
    winner: newSongWinnerView(resultVisible),
    completedAt: session.completedAt,
    updatedAt: session.updatedAt,
    serverNow: eventNowIso(),
  };
}

function newSongState(body) {
  const db = readDb();
  const context = attendeeNewSongContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = newSongSessionFromDb(db, context.sessionNumber);
  return { status: 200, body: newSongStateBody(db, context, session) };
}

function submitNewSongVote(body) {
  const db = readDb();
  const context = attendeeNewSongContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const songTitle = canonicalNewSongChoice(body && body.songTitle);
  if (!songTitle) {
    return errorResult(400, "Choose a valid New Song option.", "INVALID_SONG_CHOICE");
  }
  const session = newSongSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "voting") {
    return errorResult(409, "The New Song poll is not open right now.", "NEW_SONG_VOTING_CLOSED");
  }
  const previous = newSongVoteForAttendee(db, context.attendee.attendeeId, session);
  const now = eventNowIso();
  if (previous && previous.songTitle === songTitle) {
    return {
      status: 200,
      body: {
        ok: true,
        idempotent: true,
        changed: false,
        vote: { songTitle: previous.songTitle, votedAt: previous.votedAt },
        state: newSongStateBody(db, context, session),
      },
    };
  }
  if (previous) {
    return errorResult(409, "Your first New Song vote is already locked in.", "SONG_VOTE_LOCKED");
  }
  db.songVotes.push({
    id: id(),
    attendeeId: context.attendee.attendeeId,
    name: context.attendee.name,
    sessionNumber: context.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    songTitle,
    votedAt: now,
    updatedAt: now,
  });
  writeDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      idempotent: false,
      changed: true,
      vote: { songTitle, votedAt: now },
      state: newSongStateBody(db, context, session),
    },
  };
}

function saveSongVote(body) {
  const attendeeId = body && body.attendeeId;
  const requestedTitle = String((body && body.songTitle) || "").trim();
  const canonicalTitle = canonicalNewSongChoice(requestedTitle);
  const songTitle = canonicalTitle;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  if (!songTitle) return errorResult(400, "Choose a valid New Song option.", "INVALID_SONG_CHOICE");

  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const eventState = eventSessionState();
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = eventState.phase === "active" && colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (canonicalTitle && assignedBooth === "newsong" && attendee.wristbandConfirmedAt) {
    const result = submitNewSongVote({ attendeeId, songTitle: canonicalTitle });
    if (result.status !== 200) return result;
    const state = result.body.state;
    const freshDb = readDb();
    const counts = newSongVoteCountsForRun(freshDb, state.sessionNumber, state.runId);
    const selected = counts.find((entry) => entry.title === result.body.vote.songTitle);
    return {
      status: 200,
      body: {
        ...result.body,
        songTitle: result.body.vote.songTitle,
        votes: selected ? selected.votes : 0,
        totalVotes: counts.reduce((total, entry) => total + entry.votes, 0),
      },
    };
  }

  const previous = db.songVotes.find((vote) => (
    vote.attendeeId === attendee.attendeeId && !vote.sessionNumber
  ));
  const now = eventNowIso();
  if (previous) {
    previous.songTitle = songTitle;
    previous.name = attendee.name;
    previous.votedAt = now;
    previous.updatedAt = now;
  } else {
    db.songVotes.push({
      id: id(),
      attendeeId: attendee.attendeeId,
      name: attendee.name,
      sessionNumber: null,
      runId: null,
      runNumber: null,
      songTitle,
      votedAt: now,
      updatedAt: now,
    });
  }
  writeDb(db);
  const counts = songVoteCounts(db);
  const selected = counts.find((entry) => entry.title === songTitle);
  return {
    status: 200,
    body: {
      ok: true,
      songTitle,
      votes: selected ? selected.votes : 0,
      totalVotes: counts.reduce((total, entry) => total + entry.votes, 0),
    },
  };
}

function submitSignup(body) {
  const { attendeeId, phone, optionId, optionTitle, email, stars, comment } = body;
  if (!optionId) return { status: 400, body: { error: "optionId required" } };
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  if (phone && attendee.phone && attendee.phone !== digitsOnly(phone)) {
    return errorResult(409, "phone does not match attendee", "IDENTITY_CONFLICT");
  }
  const existing = db.signups.find((signup) => (
    signup.attendeeId === attendee.attendeeId && String(signup.optionId) === String(optionId)
  ));
  if (existing) {
    existing.phone = attendee.phone;
    existing.name = attendee.name;
    existing.optionTitle = optionTitle || optionId;
    if (Object.prototype.hasOwnProperty.call(body, "email")) existing.email = email || "";
    if (Object.prototype.hasOwnProperty.call(body, "stars")) existing.stars = stars || null;
    if (Object.prototype.hasOwnProperty.call(body, "comment")) existing.comment = comment || "";
    writeDb(db);
    return { status: 200, body: { ok: true, signupId: existing.id, updated: true } };
  }
  const row = {
    id: id(),
    attendeeId: attendee.attendeeId,
    phone: attendee.phone,
    name: attendee.name,
    optionId, optionTitle: optionTitle || optionId,
    email: email || "", stars: stars || null, comment: comment || "",
    submittedAt: eventNowIso(),
    confirmedInPerson: false, confirmedBy: null, confirmedAt: null,
  };
  db.signups.push(row);
  writeDb(db);
  return { status: 200, body: { ok: true, signupId: row.id } };
}

function saveSignupSelections(body) {
  const attendeeId = body && body.attendeeId;
  const rawOptionIds = body && body.optionIds;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  if (!Array.isArray(rawOptionIds)) {
    return errorResult(400, "optionIds must be a list", "INVALID_SIGNUP_OPTIONS");
  }
  const optionIds = Array.from(new Set(rawOptionIds.map((value) => String(value || "").trim()).filter(Boolean)));
  if (optionIds.some((optionId) => !FINAL_SIGNUP_OPTIONS.has(optionId))) {
    return errorResult(400, "Choose only valid Phase 3 options.", "INVALID_SIGNUP_OPTIONS");
  }

  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const completedAt = attendee.phase3CompletedAt || eventNowIso();
  attendee.phase3CompletedAt = completedAt;
  const selected = new Set(optionIds);
  db.signups = db.signups.filter((signup) => !(
    signup.attendeeId === attendee.attendeeId
      && FINAL_SIGNUP_OPTIONS.has(String(signup.optionId))
      && !selected.has(String(signup.optionId))
      && signup.confirmedInPerson !== true
  ));

  const signupIds = optionIds.map((optionId) => {
    let signup = db.signups.find((row) => (
      row.attendeeId === attendee.attendeeId && String(row.optionId) === optionId
    ));
    if (signup) {
      signup.name = attendee.name;
      signup.phone = attendee.phone;
      signup.optionTitle = FINAL_SIGNUP_OPTIONS.get(optionId);
      return signup.id;
    }
    signup = {
      id: id(),
      attendeeId: attendee.attendeeId,
      phone: attendee.phone,
      name: attendee.name,
      optionId,
      optionTitle: FINAL_SIGNUP_OPTIONS.get(optionId),
      email: "",
      stars: null,
      comment: "",
      submittedAt: eventNowIso(),
      confirmedInPerson: false,
      confirmedBy: null,
      confirmedAt: null,
    };
    db.signups.push(signup);
    return signup.id;
  });
  const savedOptionIds = Array.from(FINAL_SIGNUP_OPTIONS.keys()).filter((optionId) => (
    db.signups.some((signup) => signup.attendeeId === attendee.attendeeId && String(signup.optionId) === optionId)
  ));
  writeDb(db);
  return { status: 200, body: { ok: true, optionIds: savedOptionIds, signupIds, completedAt } };
}

function confirmSignupInPerson(body) {
  const { signupId, confirmedBy } = body;
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  const row = db.signups.find((s) => s.id === signupId);
  if (!row) return { status: 404, body: { error: "signup not found" } };
  row.confirmedInPerson = true;
  row.confirmedBy = confirmedBy || "staff";
  row.confirmedAt = eventNowIso();
  writeDb(db);
  return { status: 200, body: { ok: true } };
}

function myCheckins(body) {
  const { attendeeId } = body;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const ids = [attendee.attendeeId, ...(attendee.aliasIds || [])];
  const boothIds = db.boothCheckins
    .filter((c) => ids.includes(c.attendeeId))
    .map((c) => c.boothId);
  return {
    status: 200,
    body: { boothIds: Array.from(new Set(boothIds)) },
  };
}

function mySignupSelections(body) {
  const attendeeId = body && body.attendeeId;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const optionIds = Array.from(FINAL_SIGNUP_OPTIONS.keys()).filter((optionId) => (
    db.signups.some((signup) => signup.attendeeId === attendee.attendeeId && String(signup.optionId) === optionId)
  ));
  return { status: 200, body: { optionIds, completedAt: attendee.phase3CompletedAt || null } };
}

function triviaLeaderboardForRun(db, sessionNumber, session) {
  const rowsByAttendee = new Map();
  db.triviaAnswers
    .filter((answer) => (
      answer.sessionNumber === sessionNumber && answer.runId === session.runId
    ))
    .forEach((answer) => {
      if (!rowsByAttendee.has(answer.attendeeId)) rowsByAttendee.set(answer.attendeeId, []);
      rowsByAttendee.get(answer.attendeeId).push(answer);
    });
  const totalQuestions = session.phase === "welcome" ? 0 : session.questionIndex + 1;
  const rows = Array.from(rowsByAttendee.entries()).map(([attendeeId, answers]) => {
    const attendee = findAttendeeById(db, attendeeId);
    return {
      name: attendee ? attendee.name || "Guest" : "Guest",
      raffleNumber: attendee ? attendee.raffleNumber || "" : "",
      correctCount: answers.filter((answer) => answer.isCorrect).length,
      answeredCount: answers.length,
      totalQuestions,
    };
  });
  rows.sort((a, b) => (
    b.correctCount - a.correctCount
      || b.answeredCount - a.answeredCount
      || String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
      || a.name.localeCompare(b.name)
  ));
  return rows.map((row, index) => ({ rank: index + 1, ...row }));
}

function triviaLeaderboardForSession(db, sessionNumber, session) {
  return triviaLeaderboardForRun(db, sessionNumber, session);
}

function triviaArchivedRunSummary(db, archivedRun) {
  const answerRows = db.triviaAnswers.filter((answer) => (
    answer.sessionNumber === archivedRun.sessionNumber && answer.runId === archivedRun.runId
  ));
  return {
    runId: archivedRun.runId,
    runNumber: archivedRun.runNumber,
    phase: archivedRun.phase,
    questionIndex: archivedRun.questionIndex,
    version: archivedRun.version,
    startedAt: archivedRun.startedAt,
    completedAt: archivedRun.completedAt,
    archivedAt: archivedRun.archivedAt,
    archiveReason: archivedRun.archiveReason,
    participantCount: new Set(answerRows.map((answer) => answer.attendeeId)).size,
    responseCount: answerRows.length,
    leaderboard: triviaLeaderboardForRun(db, archivedRun.sessionNumber, archivedRun),
  };
}

function triviaSessionStaffSummary(db, sessionNumber) {
  const session = triviaSessionFromDb(db, sessionNumber);
  const question = session.questionIndex >= 0 && session.phase !== "complete"
    ? triviaQuestionAt(session.questionIndex, true)
    : null;
  const currentQuestionId = session.questionIndex >= 0
    ? TRIVIA_QUESTIONS[session.questionIndex].id
    : null;
  const responseCount = currentQuestionId
    ? db.triviaAnswers.filter((answer) => (
      answer.sessionNumber === sessionNumber
        && answer.runId === session.runId
        && answer.questionId === currentQuestionId
    )).length
    : 0;
  const assignedColor = triviaAssignedColor(sessionNumber);
  const assignedCount = assignedColor
    ? db.attendees.filter((attendee) => (
      attendee.wristbandConfirmedAt
        && normalizeWristbandColor(attendee.wristbandColor) === assignedColor.id
    )).length
    : 0;
  return {
    sessionNumber,
    sessionLabel: triviaSessionLabel(sessionNumber),
    assignedColor,
    assignedCount,
    state: session,
    activeRun: session,
    question,
    responseCount,
    questionsRevealed: triviaQuestionsRevealed(session),
    leaderboard: triviaLeaderboardForSession(db, sessionNumber, session),
    archivedRuns: db.triviaRunHistory
      .filter((run) => run.sessionNumber === sessionNumber)
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((run) => triviaArchivedRunSummary(db, run)),
  };
}

function triviaDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  return {
    status: 200,
    body: {
      serverNow: eventNowIso(),
      eventState: eventSessionState(),
      sessions: Array.from(TRIVIA_SESSION_NUMBERS, (sessionNumber) => (
        triviaSessionStaffSummary(db, sessionNumber)
      )),
    },
  };
}

function triviaState(body) {
  const db = readDb();
  const context = attendeeTriviaContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = triviaSessionFromDb(db, context.sessionNumber);
  const question = session.questionIndex >= 0 && session.phase !== "complete"
    ? triviaQuestionAt(session.questionIndex)
    : null;
  const savedAnswer = question
    ? db.triviaAnswers.find((answer) => (
      answer.attendeeId === context.attendee.attendeeId
        && answer.sessionNumber === context.sessionNumber
        && answer.runId === session.runId
        && answer.questionId === question.id
    ))
    : null;
  let answer = null;
  if (savedAnswer) {
    answer = { answerIndex: savedAnswer.answerIndex };
    if (session.phase === "reveal") answer.isCorrect = savedAnswer.isCorrect;
  }
  const correctQuestion = session.phase === "reveal"
    ? TRIVIA_QUESTIONS[session.questionIndex]
    : null;
  return {
    status: 200,
    body: {
      sessionNumber: context.sessionNumber,
      sessionLabel: triviaSessionLabel(context.sessionNumber),
      assignedColor: triviaAssignedColor(context.sessionNumber),
      phase: session.phase,
      version: session.version,
      runId: session.runId,
      runNumber: session.runNumber,
      questionCount: TRIVIA_QUESTIONS.length,
      question,
      answer,
      correctAnswer: correctQuestion
        ? {
          answerIndex: correctQuestion.correctIndex,
          text: correctQuestion.choices[correctQuestion.correctIndex],
        }
        : null,
      score: triviaScore(db, context.attendee.attendeeId, context.sessionNumber, session),
      topThree: session.phase === "complete"
        ? triviaLeaderboardForSession(db, context.sessionNumber, session).slice(0, 3)
        : [],
      updatedAt: session.updatedAt,
      serverNow: eventNowIso(),
    },
  };
}

function submitTriviaAnswer(body) {
  const db = readDb();
  const context = attendeeTriviaContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = triviaSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "question" || session.questionIndex < 0) {
    return errorResult(409, "The Bible Bowl leader is not accepting answers right now.", "TRIVIA_ANSWER_CLOSED");
  }
  const question = TRIVIA_QUESTIONS[session.questionIndex];
  const questionId = String((body && body.questionId) || "").trim();
  if (questionId !== question.id) {
    return errorResult(409, "That question is no longer open. Refresh for the current question.", "TRIVIA_QUESTION_CHANGED");
  }
  const answerIndex = Number(body && body.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.choices.length) {
    return errorResult(400, "Choose one of the displayed answers.", "INVALID_TRIVIA_ANSWER");
  }
  const existing = db.triviaAnswers.find((answer) => (
    answer.attendeeId === context.attendee.attendeeId
      && answer.sessionNumber === context.sessionNumber
      && answer.runId === session.runId
      && answer.questionId === question.id
  ));
  if (existing) {
    if (existing.answerIndex !== answerIndex) {
      return errorResult(409, "Your first answer is already locked in.", "TRIVIA_ANSWER_LOCKED");
    }
    return {
      status: 200,
      body: {
        ok: true,
        idempotent: true,
        sessionNumber: context.sessionNumber,
        runId: session.runId,
        runNumber: session.runNumber,
        questionId: question.id,
        answerIndex: existing.answerIndex,
        answeredAt: existing.answeredAt,
      },
    };
  }
  const answeredAt = eventNowIso();
  db.triviaAnswers.push({
    id: id(),
    attendeeId: context.attendee.attendeeId,
    sessionNumber: context.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    questionId: question.id,
    questionNumber: session.questionIndex + 1,
    answerIndex,
    isCorrect: answerIndex === question.correctIndex,
    answeredAt,
  });
  writeDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      idempotent: false,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
      questionId: question.id,
      answerIndex,
      answeredAt,
    },
  };
}

function advanceTriviaSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireTriviaSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const action = String((body && body.action) || "").trim().toLowerCase();
  if (!["start", "reveal", "next", "finish"].includes(action)) {
    return errorResult(400, "Choose a valid Bible Bowl control action.", "INVALID_TRIVIA_ACTION");
  }
  const activeSessionError = activeBoothControlError(sessionResult.sessionNumber, "Bible Bowl");
  if (activeSessionError) return activeSessionError;
  const db = readDb();
  const previous = triviaSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This Bible Bowl session changed in another tab. Refresh and try again.", "TRIVIA_SESSION_CONFLICT");
  }
  const now = eventNowIso();
  const next = { ...previous, updatedAt: now, version: previous.version + 1 };
  if (action === "start") {
    if (previous.phase !== "welcome") {
      return errorResult(409, "This Bible Bowl session has already started.", "INVALID_TRIVIA_TRANSITION");
    }
    next.phase = "question";
    next.questionIndex = 0;
    next.startedAt = previous.startedAt || now;
    next.completedAt = null;
  } else if (action === "reveal") {
    if (previous.phase !== "question") {
      return errorResult(409, "Only an open question can reveal its answer.", "INVALID_TRIVIA_TRANSITION");
    }
    next.phase = "reveal";
  } else if (action === "next") {
    if (previous.phase !== "reveal") {
      return errorResult(409, "Reveal the current answer before showing the next question.", "INVALID_TRIVIA_TRANSITION");
    }
    if (previous.questionIndex >= TRIVIA_QUESTIONS.length - 1) {
      return errorResult(409, "The final answer is revealed. Show the final results now.", "TRIVIA_LAST_QUESTION");
    }
    next.phase = "question";
    next.questionIndex = previous.questionIndex + 1;
  } else if (action === "finish") {
    if (previous.phase !== "reveal") {
      return errorResult(409, "Reveal the current answer before showing final results.", "INVALID_TRIVIA_TRANSITION");
    }
    next.phase = "complete";
    next.completedAt = now;
  }
  db.triviaSessions[String(sessionResult.sessionNumber)] = next;
  writeDb(db);
  return { status: 200, body: triviaSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function resetTriviaSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireTriviaSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const db = readDb();
  const previous = triviaSessionFromDb(db, sessionResult.sessionNumber);
  if (body && body.version !== undefined) {
    const expectedVersion = Number(body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
      return errorResult(409, "This Bible Bowl session changed in another tab. Refresh and try again.", "TRIVIA_SESSION_CONFLICT");
    }
  }
  const now = eventNowIso();
  archiveTriviaRun(db, previous, "reset", now);
  const nextRunNumber = previous.runNumber + 1;
  const reset = defaultTriviaSession(sessionResult.sessionNumber, {
    runId: newActivityRunId("trivia", sessionResult.sessionNumber, nextRunNumber),
    runNumber: nextRunNumber,
    version: previous.version + 1,
    updatedAt: now,
  });
  db.triviaSessions[String(sessionResult.sessionNumber)] = reset;
  writeDb(db);
  return { status: 200, body: triviaSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function completeTrivia(body) {
  const db = readDb();
  const context = attendeeTriviaContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = triviaSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "complete") {
    return errorResult(409, "Wait for the Bible Bowl leader to show the final results.", "TRIVIA_NOT_COMPLETE");
  }
  const score = triviaScore(db, context.attendee.attendeeId, context.sessionNumber, session);
  const checkin = boothCheckin({
    attendeeId: context.attendee.attendeeId,
    phone: context.attendee.phone || "",
    boothId: "trivia",
    boothName: BOOTH_NAMES.trivia,
    checkedInBy: "bible-bowl-results",
    extraData: {
      sessionNumber: context.sessionNumber,
      sessionId: `session-${context.sessionNumber}`,
      runId: session.runId,
      runNumber: session.runNumber,
      wristbandColor: normalizeWristbandColor(context.attendee.wristbandColor),
      score: score.correctCount,
      correctCount: score.correctCount,
      answeredCount: score.answeredCount,
      totalQuestions: score.totalQuestions,
    },
  });
  if (checkin.status !== 200) return checkin;
  return {
    status: 200,
    body: {
      ok: true,
      checkinId: checkin.body.checkinId,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
      score,
    },
  };
}

function heavenConfirmationCounts(rows) {
  const counts = HEAVEN_CONFIRMATION_ACTIONS.reduce((result, action) => {
    result[action] = 0;
    return result;
  }, {});
  rows.forEach((row) => { counts[row.action] += 1; });
  return counts;
}

function heavenParticipantSummary(db, attendeeId, session) {
  const attendee = findAttendeeById(db, attendeeId);
  const participant = heavenParticipantState(db, attendeeId, session);
  const completedActionCount = HEAVEN_CONFIRMATION_ACTIONS.filter(
    (action) => participant.confirmations[action]
  ).length;
  return {
    attendeeId,
    name: attendee ? attendee.name || "Guest" : "Guest",
    raffleNumber: attendee ? attendee.raffleNumber || "" : "",
    confirmations: participant.confirmations,
    confirmedAt: participant.confirmedAt,
    completedActionCount,
    done: participant.confirmations.programs_done,
  };
}

function heavenArchivedRunSummary(db, archivedRun) {
  const rows = heavenConfirmationsFor(
    db, archivedRun.sessionNumber, archivedRun.runId
  );
  const attendeeIds = Array.from(new Set(rows.map((row) => row.attendeeId)));
  return {
    runId: archivedRun.runId,
    runNumber: archivedRun.runNumber,
    phase: archivedRun.phase,
    version: archivedRun.version,
    startedAt: archivedRun.startedAt,
    completedAt: archivedRun.completedAt,
    archivedAt: archivedRun.archivedAt,
    archiveReason: archivedRun.archiveReason,
    participantCount: attendeeIds.length,
    confirmationCounts: heavenConfirmationCounts(rows),
    participants: attendeeIds
      .map((attendeeId) => heavenParticipantSummary(db, attendeeId, archivedRun))
      .sort((a, b) => (
        String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
          || a.name.localeCompare(b.name)
      )),
  };
}

function heavenSessionStaffSummary(db, sessionNumber) {
  const session = heavenSessionFromDb(db, sessionNumber);
  const assignedColor = heavenAssignedColor(sessionNumber);
  const assignedAttendees = attendeesAssignedToBoothSession(db, "heaven", sessionNumber);
  const rows = heavenConfirmationsFor(db, sessionNumber, session.runId);
  const participantIds = new Set(rows.map((row) => row.attendeeId));
  const participants = assignedAttendees
    .map((attendee) => heavenParticipantSummary(db, attendee.attendeeId, session))
    .sort((a, b) => (
      String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
        || a.name.localeCompare(b.name)
    ));
  return {
    sessionNumber,
    sessionLabel: heavenSessionLabel(sessionNumber),
    assignedColor,
    assignedCount: assignedAttendees.length,
    state: session,
    activeRun: session,
    participantCount: participantIds.size,
    completedCount: rows.filter((row) => row.action === "programs_done").length,
    confirmationCounts: heavenConfirmationCounts(rows),
    participants,
    archivedRuns: db.heavenRunHistory
      .filter((run) => run.sessionNumber === sessionNumber)
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((run) => heavenArchivedRunSummary(db, run)),
  };
}

function heavenDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  return {
    status: 200,
    body: {
      serverNow: eventNowIso(),
      eventState: eventSessionState(),
      sessions: Array.from(HEAVEN_SESSION_NUMBERS, (sessionNumber) => (
        heavenSessionStaffSummary(db, sessionNumber)
      )),
    },
  };
}

function heavenStateBody(db, context, session) {
  return {
    sessionNumber: context.sessionNumber,
    sessionLabel: heavenSessionLabel(context.sessionNumber),
    assignedColor: heavenAssignedColor(context.sessionNumber),
    phase: session.phase,
    version: session.version,
    runId: session.runId,
    runNumber: session.runNumber,
    participant: heavenParticipantState(db, context.attendee.attendeeId, session),
    updatedAt: session.updatedAt,
    serverNow: eventNowIso(),
  };
}

function heavenState(body) {
  const db = readDb();
  const context = attendeeHeavenContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = heavenSessionFromDb(db, context.sessionNumber);
  return { status: 200, body: heavenStateBody(db, context, session) };
}

function confirmHeavenStep(body) {
  const db = readDb();
  const context = attendeeHeavenContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const action = String((body && body.action) || "").trim().toLowerCase();
  if (!HEAVEN_CONFIRMATION_ACTION_SET.has(action)) {
    return errorResult(400, "Choose a valid Draw Heaven response.", "INVALID_HEAVEN_CONFIRMATION");
  }
  const session = heavenSessionFromDb(db, context.sessionNumber);
  const existing = db.heavenConfirmations.find((confirmation) => (
    confirmation.attendeeId === context.attendee.attendeeId
      && confirmation.sessionNumber === context.sessionNumber
      && confirmation.runId === session.runId
      && confirmation.action === action
  ));
  if (existing) {
    return {
      status: 200,
      body: {
        ok: true,
        idempotent: true,
        action,
        confirmedAt: existing.confirmedAt,
        state: heavenStateBody(db, context, session),
      },
    };
  }
  const rule = HEAVEN_CONFIRMATION_RULES[action];
  const currentPhaseIndex = HEAVEN_PHASE_ORDER.indexOf(session.phase);
  const minimumPhaseIndex = HEAVEN_PHASE_ORDER.indexOf(rule.minimumPhase);
  if (currentPhaseIndex < minimumPhaseIndex) {
    return errorResult(
      409,
      "That response is not open on the leader-paced screen right now.",
      "HEAVEN_CONFIRMATION_CLOSED"
    );
  }
  const participant = heavenParticipantState(db, context.attendee.attendeeId, session);
  const missingPrerequisite = rule.requires.find(
    (requiredAction) => !participant.confirmations[requiredAction]
  );
  if (missingPrerequisite) {
    return errorResult(
      409,
      "Complete the current Draw Heaven step before continuing.",
      "HEAVEN_CONFIRMATION_PREREQUISITE"
    );
  }
  const confirmedAt = eventNowIso();
  db.heavenConfirmations.push({
    id: id(),
    attendeeId: context.attendee.attendeeId,
    sessionNumber: context.sessionNumber,
    runId: session.runId,
    runNumber: session.runNumber,
    action,
    confirmedAt,
  });
  writeDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      idempotent: false,
      action,
      confirmedAt,
      state: heavenStateBody(db, context, session),
    },
  };
}

function advanceHeavenSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireHeavenSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const action = String((body && body.action) || "").trim().toLowerCase();
  const transitions = {
    start: ["welcome", "drawing"],
    show_verse: ["drawing", "verse"],
    show_comparison: ["verse", "comparison"],
    show_impact: ["comparison", "reflection"],
    show_programs: ["reflection", "programs"],
    finish: ["programs", "complete"],
  };
  if (!Object.prototype.hasOwnProperty.call(transitions, action)) {
    return errorResult(400, "Choose a valid Draw Heaven control action.", "INVALID_HEAVEN_ACTION");
  }
  const activeSessionError = activeBoothControlError(sessionResult.sessionNumber, "Draw Heaven");
  if (activeSessionError) return activeSessionError;
  const db = readDb();
  const previous = heavenSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This Draw Heaven session changed in another tab. Refresh and try again.", "HEAVEN_SESSION_CONFLICT");
  }
  const [requiredPhase, nextPhase] = transitions[action];
  if (previous.phase !== requiredPhase) {
    return errorResult(409, "That control is not available at this point in the activity.", "INVALID_HEAVEN_TRANSITION");
  }
  const now = eventNowIso();
  const next = {
    ...previous,
    phase: nextPhase,
    version: previous.version + 1,
    startedAt: action === "start" ? previous.startedAt || now : previous.startedAt,
    updatedAt: now,
    completedAt: action === "finish" ? now : null,
  };
  db.heavenSessions[String(sessionResult.sessionNumber)] = next;
  writeDb(db);
  return { status: 200, body: heavenSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function resetHeavenSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireHeavenSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const db = readDb();
  const previous = heavenSessionFromDb(db, sessionResult.sessionNumber);
  if (body && body.version !== undefined) {
    const expectedVersion = Number(body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
      return errorResult(409, "This Draw Heaven session changed in another tab. Refresh and try again.", "HEAVEN_SESSION_CONFLICT");
    }
  }
  const now = eventNowIso();
  archiveHeavenRun(db, previous, "reset", now);
  const nextRunNumber = previous.runNumber + 1;
  db.heavenSessions[String(sessionResult.sessionNumber)] = defaultHeavenSession(
    sessionResult.sessionNumber,
    {
      runId: newActivityRunId("heaven", sessionResult.sessionNumber, nextRunNumber),
      runNumber: nextRunNumber,
      version: previous.version + 1,
      updatedAt: now,
    }
  );
  writeDb(db);
  return { status: 200, body: heavenSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function completeHeaven(body) {
  const db = readDb();
  const context = attendeeHeavenContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = heavenSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "complete") {
    return errorResult(409, "Wait for the Draw Heaven leader to finish the activity.", "HEAVEN_NOT_COMPLETE");
  }
  const participant = heavenParticipantState(db, context.attendee.attendeeId, session);
  if (!participant.confirmations.programs_done) {
    return errorResult(409, "View the program preview before finishing Draw Heaven.", "HEAVEN_STEPS_INCOMPLETE");
  }
  const checkin = boothCheckin({
    attendeeId: context.attendee.attendeeId,
    phone: context.attendee.phone || "",
    boothId: "heaven",
    boothName: BOOTH_NAMES.heaven,
    checkedInBy: "draw-heaven-finale",
    extraData: {
      sessionNumber: context.sessionNumber,
      sessionId: `session-${context.sessionNumber}`,
      runId: session.runId,
      runNumber: session.runNumber,
      wristbandColor: normalizeWristbandColor(context.attendee.wristbandColor),
      completedActions: HEAVEN_CONFIRMATION_ACTIONS.length,
    },
  });
  if (checkin.status !== 200) return checkin;
  return {
    status: 200,
    body: {
      ok: true,
      checkinId: checkin.body.checkinId,
      idempotent: checkin.body.updated === true,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
    },
  };
}

function artCompletionsFor(db, sessionNumber, runId) {
  return db.artCompletions.filter((completion) => (
    completion.sessionNumber === sessionNumber && completion.runId === runId
  ));
}

function artCompletionFor(db, attendeeId, session) {
  const attendee = findAttendeeById(db, attendeeId);
  const attendeeIds = new Set([
    attendeeId,
    attendee && attendee.attendeeId,
    ...((attendee && attendee.aliasIds) || []),
  ].filter(Boolean));
  return artCompletionsFor(db, session.sessionNumber, session.runId)
    .find((completion) => attendeeIds.has(completion.attendeeId)) || null;
}

function artParticipantSummary(db, attendee, session) {
  const completion = artCompletionFor(db, attendee.attendeeId, session);
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name || "Guest",
    raffleNumber: attendee.raffleNumber || "",
    completedAt: completion ? completion.completedAt : null,
  };
}

function artArchivedRunSummary(db, archivedRun) {
  const completions = artCompletionsFor(
    db, archivedRun.sessionNumber, archivedRun.runId
  );
  const participants = completions
    .map((completion) => {
      const attendee = findAttendeeById(db, completion.attendeeId);
      return {
        attendeeId: completion.attendeeId,
        name: attendee ? attendee.name || "Guest" : "Guest",
        raffleNumber: attendee ? attendee.raffleNumber || "" : "",
        completedAt: completion.completedAt,
      };
    })
    .sort((a, b) => (
      String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
        || a.name.localeCompare(b.name)
    ));
  return {
    runId: archivedRun.runId,
    runNumber: archivedRun.runNumber,
    phase: archivedRun.phase,
    version: archivedRun.version,
    startedAt: archivedRun.startedAt,
    completedAt: archivedRun.completedAt,
    archivedAt: archivedRun.archivedAt,
    archiveReason: archivedRun.archiveReason,
    participantCount: participants.length,
    completedCount: participants.length,
    participants,
  };
}

function artSessionStaffSummary(db, sessionNumber) {
  const session = artSessionFromDb(db, sessionNumber);
  const assignedAttendees = attendeesAssignedToBoothSession(db, "art", sessionNumber);
  const participants = assignedAttendees
    .map((attendee) => artParticipantSummary(db, attendee, session))
    .sort((a, b) => (
      String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
        || a.name.localeCompare(b.name)
    ));
  const completedCount = participants.filter((participant) => participant.completedAt).length;
  return {
    sessionNumber,
    sessionLabel: artSessionLabel(sessionNumber),
    assignedColor: artAssignedColor(sessionNumber),
    assignedCount: assignedAttendees.length,
    state: session,
    activeRun: session,
    participantCount: completedCount,
    completedCount,
    participants,
    archivedRuns: db.artRunHistory
      .filter((run) => run.sessionNumber === sessionNumber)
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((run) => artArchivedRunSummary(db, run)),
  };
}

function artDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  return {
    status: 200,
    body: {
      serverNow: eventNowIso(),
      eventState: eventSessionState(),
      sessions: Array.from(ART_SESSION_NUMBERS, (sessionNumber) => (
        artSessionStaffSummary(db, sessionNumber)
      )),
    },
  };
}

function artStateBody(db, context, session) {
  const completion = artCompletionFor(db, context.attendee.attendeeId, session);
  return {
    sessionNumber: context.sessionNumber,
    sessionLabel: artSessionLabel(context.sessionNumber),
    assignedColor: artAssignedColor(context.sessionNumber),
    phase: session.phase,
    version: session.version,
    runId: session.runId,
    runNumber: session.runNumber,
    completedAt: completion ? completion.completedAt : null,
    updatedAt: session.updatedAt,
    serverNow: eventNowIso(),
  };
}

function artState(body) {
  const db = readDb();
  const context = attendeeArtContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = artSessionFromDb(db, context.sessionNumber);
  return { status: 200, body: artStateBody(db, context, session) };
}

function advanceArtSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireArtSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const action = String((body && body.action) || "").trim().toLowerCase();
  const transitions = {
    start: ["welcome", "definition"],
    show_importance: ["definition", "importance"],
    show_purpose_image: ["importance", "purpose_image"],
    ask_heart: ["purpose_image", "heart_question"],
    show_proverbs: ["heart_question", "proverbs"],
    show_philippians: ["proverbs", "philippians"],
    start_art: ["philippians", "create"],
    show_finished: ["create", "finished"],
    finish: ["finished", "complete"],
  };
  if (!Object.prototype.hasOwnProperty.call(transitions, action)) {
    return errorResult(400, "Choose a valid Art Therapy control action.", "INVALID_ART_ACTION");
  }
  const activeSessionError = activeBoothControlError(sessionResult.sessionNumber, "Art Therapy");
  if (activeSessionError) return activeSessionError;
  const db = readDb();
  const previous = artSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This Art Therapy session changed in another tab. Refresh and try again.", "ART_SESSION_CONFLICT");
  }
  const [requiredPhase, nextPhase] = transitions[action];
  if (previous.phase !== requiredPhase) {
    return errorResult(409, "That control is not available at this point in the activity.", "INVALID_ART_TRANSITION");
  }
  const now = eventNowIso();
  const next = {
    ...previous,
    phase: nextPhase,
    version: previous.version + 1,
    startedAt: action === "start" ? previous.startedAt || now : previous.startedAt,
    updatedAt: now,
    completedAt: action === "finish" ? now : null,
  };
  db.artSessions[String(sessionResult.sessionNumber)] = next;
  writeDb(db);
  return { status: 200, body: artSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function resetArtSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireArtSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const db = readDb();
  const previous = artSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This Art Therapy session changed in another tab. Refresh and try again.", "ART_SESSION_CONFLICT");
  }
  const now = eventNowIso();
  archiveArtRun(db, previous, "reset", now);
  const nextRunNumber = previous.runNumber + 1;
  db.artSessions[String(sessionResult.sessionNumber)] = defaultArtSession(
    sessionResult.sessionNumber,
    {
      runId: newActivityRunId("art", sessionResult.sessionNumber, nextRunNumber),
      runNumber: nextRunNumber,
      version: previous.version + 1,
      updatedAt: now,
    }
  );
  writeDb(db);
  return { status: 200, body: artSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function completeArt(body) {
  const db = readDb();
  const context = attendeeArtContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = artSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "complete") {
    return errorResult(409, "Wait for the Art Therapy leader to finish the activity.", "ART_NOT_COMPLETE");
  }

  let completion = artCompletionFor(db, context.attendee.attendeeId, session);
  const idempotent = Boolean(completion);
  if (!completion) {
    completion = {
      id: id(),
      attendeeId: context.attendee.attendeeId,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
      completedAt: eventNowIso(),
    };
    db.artCompletions.push(completion);
  }

  const checkinData = {
    attendeeId: context.attendee.attendeeId,
    phone: context.attendee.phone || null,
    name: context.attendee.name || "Guest",
    boothId: "art",
    boothName: BOOTH_NAMES.art,
    checkedInBy: "art-therapy-finale",
    checkedInAt: completion.completedAt,
    rating: null,
    note: "",
    extraData: {
      sessionNumber: context.sessionNumber,
      sessionId: `session-${context.sessionNumber}`,
      runId: session.runId,
      runNumber: session.runNumber,
      wristbandColor: normalizeWristbandColor(context.attendee.wristbandColor),
      phase: session.phase,
    },
  };
  const attendeeIds = new Set([
    context.attendee.attendeeId,
    ...(context.attendee.aliasIds || []),
  ]);
  const existingCheckin = db.boothCheckins.find((checkin) => (
    checkin.boothId === "art"
      && attendeeIds.has(checkin.attendeeId)
      && checkin.extraData
      && checkin.extraData.runId === session.runId
  ));
  let checkinId;
  if (existingCheckin) {
    checkinId = existingCheckin.id;
    Object.assign(existingCheckin, checkinData, {
      id: checkinId,
      checkedInAt: existingCheckin.checkedInAt || completion.completedAt,
    });
  } else {
    checkinId = id();
    db.boothCheckins.push({ id: checkinId, ...checkinData });
  }
  writeDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      idempotent,
      checkinId,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
      completedAt: completion.completedAt,
    },
  };
}

function newSongCompletionFor(db, attendeeId, runId) {
  return db.boothCheckins.find((checkin) => (
    checkin.boothId === "newsong"
      && checkin.attendeeId === attendeeId
      && checkin.extraData
      && checkin.extraData.runId === runId
  )) || null;
}

function newSongParticipantSummary(db, attendee, session) {
  const vote = newSongVoteForAttendee(db, attendee.attendeeId, session);
  const completion = newSongCompletionFor(db, attendee.attendeeId, session.runId);
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name || "Guest",
    raffleNumber: attendee.raffleNumber || "",
    songTitle: vote ? vote.songTitle : null,
    votedAt: vote ? vote.votedAt : null,
    voted: Boolean(vote),
    completedAt: completion ? completion.checkedInAt : null,
  };
}

function newSongArchivedRunSummary(db, archivedRun) {
  const voteCounts = newSongVoteCountsForRun(
    db, archivedRun.sessionNumber, archivedRun.runId
  );
  const archivedSession = {
    sessionNumber: archivedRun.sessionNumber,
    runId: archivedRun.runId,
    runNumber: archivedRun.runNumber,
  };
  const participants = attendeesAssignedToBoothSession(db, "newsong", archivedRun.sessionNumber)
    .map((attendee) => newSongParticipantSummary(db, attendee, archivedSession))
    .sort((a, b) => (
      String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
        || a.name.localeCompare(b.name)
    ));
  const voters = participants.filter((participant) => participant.voted);
  const totalVotes = voteCounts.reduce((total, entry) => total + entry.votes, 0);
  return {
    runId: archivedRun.runId,
    runNumber: archivedRun.runNumber,
    phase: archivedRun.phase,
    version: archivedRun.version,
    startedAt: archivedRun.startedAt,
    completedAt: archivedRun.completedAt,
    archivedAt: archivedRun.archivedAt,
    archiveReason: archivedRun.archiveReason,
    participantCount: participants.length,
    voteCount: totalVotes,
    totalVotes,
    voteCounts,
    songCounts: voteCounts,
    result: archivedRun.result,
    winner: newSongWinnerView(archivedRun.result),
    voters,
    participants,
  };
}

function newSongSessionStaffSummary(db, sessionNumber) {
  const session = newSongSessionFromDb(db, sessionNumber);
  const assignedAttendees = attendeesAssignedToBoothSession(db, "newsong", sessionNumber);
  const participants = assignedAttendees
    .map((attendee) => newSongParticipantSummary(db, attendee, session))
    .sort((a, b) => (
      String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
        || a.name.localeCompare(b.name)
    ));
  const voters = participants.filter((participant) => participant.voted);
  const voteCounts = newSongVoteCountsForRun(db, sessionNumber, session.runId);
  const totalVotes = voteCounts.reduce((total, entry) => total + entry.votes, 0);
  return {
    sessionNumber,
    sessionLabel: newSongSessionLabel(sessionNumber),
    assignedColor: newSongAssignedColor(sessionNumber),
    assignedCount: assignedAttendees.length,
    state: session,
    activeRun: session,
    participantCount: voters.length,
    voteCount: totalVotes,
    totalVotes,
    choices: NEW_SONG_CHOICES.slice(),
    voteCounts,
    songCounts: voteCounts,
    result: session.result,
    winner: newSongWinnerView(session.result),
    participants,
    voters,
    archivedRuns: db.newSongRunHistory
      .filter((run) => run.sessionNumber === sessionNumber)
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((run) => newSongArchivedRunSummary(db, run)),
  };
}

function newSongDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  return {
    status: 200,
    body: {
      serverNow: eventNowIso(),
      eventState: eventSessionState(),
      choices: NEW_SONG_CHOICES.slice(),
      sessions: Array.from(NEW_SONG_SESSION_NUMBERS, (sessionNumber) => (
        newSongSessionStaffSummary(db, sessionNumber)
      )),
    },
  };
}

function advanceNewSongSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireNewSongSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const action = String((body && body.action) || "").trim().toLowerCase();
  const transitions = {
    start: ["welcome", "voting"],
    show_winner: ["voting", "winner"],
    show_verse: ["winner", "verse"],
    finish: ["verse", "complete"],
  };
  if (!Object.prototype.hasOwnProperty.call(transitions, action)) {
    return errorResult(400, "Choose a valid New Song control action.", "INVALID_NEW_SONG_ACTION");
  }
  const activeSessionError = activeBoothControlError(sessionResult.sessionNumber, "New Song");
  if (activeSessionError) return activeSessionError;
  const db = readDb();
  const previous = newSongSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This New Song session changed in another tab. Refresh and try again.", "NEW_SONG_SESSION_CONFLICT");
  }
  const [requiredPhase, nextPhase] = transitions[action];
  if (previous.phase !== requiredPhase) {
    return errorResult(409, "That control is not available at this point in the activity.", "INVALID_NEW_SONG_TRANSITION");
  }
  let result = previous.result;
  if (action === "show_winner") {
    result = calculateNewSongResult(newSongVoteCountsForRun(
      db, sessionResult.sessionNumber, previous.runId
    ));
    if (!result) {
      return errorResult(409, "Wait for at least one attendee to vote before showing a winner.", "NEW_SONG_NO_VOTES");
    }
  }
  const now = eventNowIso();
  const next = {
    ...previous,
    phase: nextPhase,
    version: previous.version + 1,
    result,
    startedAt: action === "start" ? previous.startedAt || now : previous.startedAt,
    updatedAt: now,
    completedAt: action === "finish" ? now : null,
  };
  db.newSongSessions[String(sessionResult.sessionNumber)] = next;
  writeDb(db);
  return { status: 200, body: newSongSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function resetNewSongSession(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const sessionResult = requireNewSongSessionNumber(body && body.sessionNumber);
  if (sessionResult.error) return sessionResult.error;
  const db = readDb();
  const previous = newSongSessionFromDb(db, sessionResult.sessionNumber);
  const expectedVersion = Number(body && body.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
    return errorResult(409, "This New Song session changed in another tab. Refresh and try again.", "NEW_SONG_SESSION_CONFLICT");
  }
  const now = eventNowIso();
  archiveNewSongRun(db, previous, "reset", now);
  const nextRunNumber = previous.runNumber + 1;
  db.newSongSessions[String(sessionResult.sessionNumber)] = defaultNewSongSession(
    sessionResult.sessionNumber,
    {
      runId: newActivityRunId("newsong", sessionResult.sessionNumber, nextRunNumber),
      runNumber: nextRunNumber,
      version: previous.version + 1,
      updatedAt: now,
    }
  );
  writeDb(db);
  return { status: 200, body: newSongSessionStaffSummary(db, sessionResult.sessionNumber) };
}

function completeNewSong(body) {
  const db = readDb();
  const context = attendeeNewSongContext(db, body && body.attendeeId);
  if (context.error) return context.error;
  const session = newSongSessionFromDb(db, context.sessionNumber);
  if (session.phase !== "complete") {
    return errorResult(409, "Wait for the New Song leader to finish the activity.", "NEW_SONG_NOT_COMPLETE");
  }
  const vote = newSongVoteForAttendee(db, context.attendee.attendeeId, session);
  const checkin = boothCheckin({
    attendeeId: context.attendee.attendeeId,
    phone: context.attendee.phone || "",
    boothId: "newsong",
    boothName: BOOTH_NAMES.newsong,
    checkedInBy: "new-song-finale",
    extraData: {
      sessionNumber: context.sessionNumber,
      sessionId: `session-${context.sessionNumber}`,
      runId: session.runId,
      runNumber: session.runNumber,
      wristbandColor: normalizeWristbandColor(context.attendee.wristbandColor),
      votedFor: vote ? vote.songTitle : null,
      featuredWinner: session.result ? session.result.featuredWinner : null,
      tiedTitles: session.result ? session.result.tiedTitles : [],
    },
  });
  if (checkin.status !== 200) return checkin;
  return {
    status: 200,
    body: {
      ok: true,
      checkinId: checkin.body.checkinId,
      sessionNumber: context.sessionNumber,
      runId: session.runId,
      runNumber: session.runNumber,
      vote: vote ? { songTitle: vote.songTitle, votedAt: vote.votedAt } : null,
      result: session.result,
      winner: newSongWinnerView(session.result),
    },
  };
}

function wristbandGroupsForDashboard(db, eventState) {
  return Array.from(WRISTBAND_COLORS).map((colorId) => {
    const route = WRISTBAND_ROUTES[colorId] || [];
    const currentBoothId = eventState.phase === "active"
      ? route[eventState.sessionIndex] || null
      : null;
    const attendees = db.attendees
      .filter((attendee) => (
        attendee.wristbandConfirmedAt && normalizeWristbandColor(attendee.wristbandColor) === colorId
      ))
      .map((attendee) => {
        const attendeeIds = new Set([attendee.attendeeId, ...(attendee.aliasIds || [])].map(String));
        const completedSet = new Set(db.boothCheckins
          .filter((checkin) => attendeeIds.has(String(checkin.attendeeId)))
          .map((checkin) => checkin.boothId));
        const completedBoothIds = route.filter((boothId) => completedSet.has(boothId));
        const arrivalPlan = attendeeArrivalPlan(attendee);
        const catchUpBooths = arrivalPlan.catchUpBooths.filter((booth) => (
          booth.boothId && !completedSet.has(booth.boothId)
        ));
        const waitingForSessionNumber = eventState.phase === "active"
          && arrivalPlan.firstEligibleSessionIndex !== null
          && eventState.sessionIndex < arrivalPlan.firstEligibleSessionIndex
          ? arrivalPlan.firstEligibleSessionNumber
          : null;
        return {
          name: attendee.name || "Guest",
          raffleNumber: attendee.raffleNumber || "",
          completedBoothIds,
          completedStops: completedBoothIds.length,
          totalStops: route.length,
          currentStopCompleted: currentBoothId ? completedSet.has(currentBoothId) : null,
          lateArrival: arrivalPlan.late,
          waitingForSessionNumber,
          catchUpBooths,
          phase3Completed: !!attendee.phase3CompletedAt,
        };
      })
      .sort((a, b) => (
        String(a.raffleNumber).localeCompare(String(b.raffleNumber), undefined, { numeric: true })
          || a.name.localeCompare(b.name)
      ));
    return {
      colorId,
      count: attendees.length,
      route: route.map((boothId) => ({ boothId, boothName: BOOTH_NAMES[boothId] || boothId })),
      currentBooth: currentBoothId
        ? { boothId: currentBoothId, boothName: BOOTH_NAMES[currentBoothId] || currentBoothId }
        : null,
      attendees,
    };
  });
}

function dashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  const eventState = eventSessionState();
  const totals = {
    registered: db.attendees.length,
    wristbandsConfirmed: db.attendees.filter((a) => a.wristbandConfirmedAt).length,
    raffleEntries: db.attendees.length,
  };
  const wristbandGroups = wristbandGroupsForDashboard(db, eventState);
  const wristbandCounts = wristbandGroups.map(({ colorId, count }) => ({ colorId, count }));

  const boothCountsMap = {};
  const countedBoothVisits = new Set();
  db.boothCheckins.forEach((c) => {
    const uniqueVisit = `${c.attendeeId}:${c.boothId}`;
    if (countedBoothVisits.has(uniqueVisit)) return;
    countedBoothVisits.add(uniqueVisit);
    boothCountsMap[c.boothId] = boothCountsMap[c.boothId] || { boothId: c.boothId, boothName: c.boothName, count: 0 };
    boothCountsMap[c.boothId].count += 1;
  });
  const boothCounts = Object.values(boothCountsMap).sort((a, b) => b.count - a.count);

  const signups = db.signups
    .slice()
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
    .map((s) => {
      const attendee = findAttendeeById(db, s.attendeeId);
      return {
        id: s.id, name: s.name || "Guest", phone: s.phone,
        raffleNumber: attendee ? attendee.raffleNumber : "",
        optionId: s.optionId, optionTitle: s.optionTitle,
        submittedAt: s.submittedAt, confirmedInPerson: s.confirmedInPerson, confirmedBy: s.confirmedBy,
      };
    });

  return {
    status: 200,
    body: {
      totals,
      eventState,
      wristbandCounts,
      wristbandGroups,
      boothCounts,
      signups,
      googleSheetsExport: googleSheetsExporter.status(),
    },
  };
}

function completeStory(body) {
  const db = readDb();
  const attendeeId = body && body.attendeeId;
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const eventState = eventSessionState();
  if (eventState.phase !== "active" || !eventState.sessionNumber) {
    return errorResult(409, "The Heaven Booth is not in an active booth session.", "STORY_SESSION_CLOSED");
  }
  const colorId = normalizeWristbandColor(attendee.wristbandColor);
  const assignedBooth = colorId && WRISTBAND_ROUTES[colorId]
    ? WRISTBAND_ROUTES[colorId][eventState.sessionIndex]
    : null;
  if (!attendee.wristbandConfirmedAt || assignedBooth !== "story") {
    return errorResult(403, "The Heaven Booth is not your assigned booth in this session.", "STORY_NOT_ASSIGNED");
  }
  const arrivalError = lateArrivalAccessError(attendee, eventState);
  if (arrivalError) return arrivalError;
  const presentation = boothPresentationFromDb(db, "story");
  const activeSession = BOOTH_SESSIONS[eventState.sessionIndex];
  const presentationUpdatedAtMs = Date.parse(presentation.updatedAt || "");
  if (
    presentation.status !== "complete"
      || presentation.stepIndex < STORY_FINAL_STEP_INDEX
      || !Number.isFinite(presentationUpdatedAtMs)
      || presentationUpdatedAtMs < Date.parse(activeSession.startsAt)
  ) {
    return errorResult(409, "Wait for The Heaven Booth leader to reach the final Thank you screen.", "STORY_NOT_COMPLETE");
  }
  const checkin = boothCheckin({
    attendeeId: attendee.attendeeId,
    phone: attendee.phone || "",
    boothId: "story",
    boothName: BOOTH_NAMES.story,
    checkedInBy: "heaven-booth-finale",
    extraData: {
      sessionNumber: eventState.sessionNumber,
      sessionId: `session-${eventState.sessionNumber}`,
      presentationVersion: presentation.version,
      wristbandColor: colorId,
    },
  });
  if (checkin.status !== 200) return checkin;
  return {
    status: 200,
    body: {
      ok: true,
      checkinId: checkin.body.checkinId,
      idempotent: checkin.body.updated === true,
      sessionNumber: eventState.sessionNumber,
      presentationVersion: presentation.version,
    },
  };
}

function boothPresentation(body) {
  const boothResult = requireBoothId(body && body.boothId);
  if (boothResult.error) return boothResult.error;
  const db = readDb();
  const presentation = boothResult.boothId === "trivia"
    ? triviaBoothPresentation(db)
    : boothResult.boothId === "heaven"
      ? heavenBoothPresentation(db)
      : boothResult.boothId === "art"
        ? artBoothPresentation(db)
        : boothResult.boothId === "newsong"
          ? newSongBoothPresentation(db)
          : boothPresentationFromDb(db, boothResult.boothId);
  return {
    status: 200,
    body: Object.assign(
      presentation,
      { serverNow: eventNowIso() }
    ),
  };
}

function updateBoothPresentation(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const boothResult = requireBoothId(body && body.boothId);
  if (boothResult.error) return boothResult.error;

  const requestedStepIndex = Number(body && body.stepIndex);
  if (!Number.isInteger(requestedStepIndex) || requestedStepIndex < 0 || requestedStepIndex > MAX_PRESENTATION_STEP_INDEX) {
    return errorResult(
      400,
      `stepIndex must be an integer from 0 to ${MAX_PRESENTATION_STEP_INDEX}.`,
      "INVALID_PRESENTATION_STEP"
    );
  }
  const status = String((body && body.status) || "").trim().toLowerCase();
  if (!BOOTH_PRESENTATION_STATUSES.has(status)) {
    return errorResult(400, "Choose a valid booth presentation status.", "INVALID_PRESENTATION_STATUS");
  }
  if (body && body.message !== undefined && body.message !== null && typeof body.message !== "string") {
    return errorResult(400, "message must be text.", "INVALID_PRESENTATION_MESSAGE");
  }
  const message = String((body && body.message) || "").trim();
  if (message.length > MAX_PRESENTATION_MESSAGE_LENGTH) {
    return errorResult(
      400,
      `message must be ${MAX_PRESENTATION_MESSAGE_LENGTH} characters or fewer.`,
      "INVALID_PRESENTATION_MESSAGE"
    );
  }

  const db = readDb();
  const previous = boothPresentationFromDb(db, boothResult.boothId);
  if (body && body.version !== undefined) {
    const expectedVersion = Number(body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
      return errorResult(409, "This booth screen was updated in another tab. Refresh and try again.", "PRESENTATION_CONFLICT");
    }
  }
  const now = eventNowIso();
  const stepIndex = boothResult.boothId === "story" && status === "waiting"
    ? 0
    : boothResult.boothId === "story" && status === "complete"
      ? STORY_FINAL_STEP_INDEX
      : requestedStepIndex;
  const presentation = {
    boothId: boothResult.boothId,
    stepIndex,
    status,
    // The Heaven Booth no longer has free-text announcements. Keep the
    // property blank for saved-data/API compatibility and hide older values.
    message: boothResult.boothId === "story" ? "" : message,
    createdAt: previous.createdAt || now,
    updatedAt: now,
    version: Math.min(Number.MAX_SAFE_INTEGER, previous.version + 1),
  };
  db.boothPresentations[boothResult.boothId] = presentation;
  writeDb(db);
  return { status: 200, body: Object.assign({}, presentation, { serverNow: now }) };
}

function boothDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const boothResult = requireBoothId(body && body.boothId);
  if (boothResult.error) return boothResult.error;
  const boothId = boothResult.boothId;

  const db = readDb();
  const checkins = db.boothCheckins
    .filter((checkin) => checkin.boothId === boothId)
    .sort((a, b) => new Date(b.checkedInAt) - new Date(a.checkedInAt));
  return {
    status: 200,
    body: {
      boothId,
      presentation: boothId === "trivia"
        ? triviaBoothPresentation(db)
        : boothId === "heaven"
          ? heavenBoothPresentation(db)
          : boothId === "art"
            ? artBoothPresentation(db)
            : boothId === "newsong"
              ? newSongBoothPresentation(db)
              : boothPresentationFromDb(db, boothId),
      serverNow: eventNowIso(),
      totalCheckins: checkins.length,
      songVotes: boothId === "newsong" ? songVoteCounts(db) : [],
      recentCheckins: checkins.slice(0, 50).map((checkin) => ({
        id: checkin.id,
        name: checkin.name || "Guest",
        checkedInAt: checkin.checkedInAt,
        checkedInBy: checkin.checkedInBy,
        rating: checkin.rating || null,
      })),
    },
  };
}

function eventClock() {
  return { status: 200, body: demoClockResult() };
}

function setDemoClock(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;

  const mode = String((body && body.mode) || "").trim().toLowerCase();
  if (!DEMO_CLOCK_MODES.has(mode)) {
    return errorResult(400, "Choose a valid demo clock mode.", "INVALID_DEMO_CLOCK_MODE");
  }

  const realNowMs = Date.now();
  if (mode === "live") {
    demoClock = {
      mode,
      controlled: true,
      targetMs: null,
      anchoredAtMs: realNowMs,
      updatedAt: nextDemoClockUpdatedAt(realNowMs),
    };
    return { status: 200, body: demoClockResult() };
  }

  const targetMs = mode === "custom"
    ? Date.parse(body && body.targetIso)
    : namedDemoClockTargetMs(mode);
  if (!Number.isFinite(targetMs)) {
    return errorResult(
      400,
      mode === "custom"
        ? "targetIso must be a valid event timestamp for custom demo time."
        : "Choose a named demo clock point supported by the current event schedule.",
      "INVALID_DEMO_CLOCK_TARGET"
    );
  }
  if (
    mode === "custom"
    && (targetMs < EVENT_WINDOW_START_MS || targetMs > EVENT_WINDOW_END_MS)
  ) {
    return errorResult(
      400,
      "Custom demo time must be between the event start at 3:10 PM and the main message at 4:00 PM CDT.",
      "INVALID_DEMO_CLOCK_TARGET_RANGE"
    );
  }
  demoClock = {
    mode,
    controlled: true,
    targetMs,
    anchoredAtMs: realNowMs,
    updatedAt: nextDemoClockUpdatedAt(realNowMs),
  };
  return { status: 200, body: demoClockResult() };
}

function resetDemo(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const previousResetMs = Date.parse(readDb().dataResetAt);
  const dataResetAt = new Date(Math.max(
    Date.now(),
    Number.isFinite(previousResetMs) ? previousResetMs + 1 : 0
  )).toISOString();
  const freshDb = emptyDb();
  freshDb.dataResetAt = dataResetAt;
  writeDb(freshDb, { replaceBackup: true });
  // Version the unchanged clock state as well. That makes any eventClock
  // response created before this reset older than the first post-reset
  // response, so a delayed network reply cannot roll browsers back to the
  // previous data-reset marker.
  demoClock = {
    ...demoClock,
    updatedAt: nextDemoClockUpdatedAt(Date.now()),
  };
  return { status: 200, body: { ok: true, dataResetAt } };
}

function verifyOrganizer(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  return { status: 200, body: { ok: true } };
}

function googleSheetsExportStatus(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  return { status: 200, body: googleSheetsExporter.status() };
}

function syncGoogleSheetsExport(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  if (!googleSheetsExporter.configured()) {
    return errorResult(
      409,
      "Google Sheets export is not configured.",
      "GOOGLE_SHEETS_EXPORT_NOT_CONFIGURED"
    );
  }
  googleSheetsExporter.queueImmediate();
  return {
    status: 200,
    body: {
      ok: true,
      queued: true,
      googleSheetsExport: googleSheetsExporter.status(),
    },
  };
}

function health() {
  const db = readDb();
  return {
    status: 200,
    body: {
      ok: true,
      database: "ready",
      registered: db.attendees.length,
      serverNow: eventNowIso(),
    },
  };
}

const POST_ACTIONS = {
  registerAttendee,
  confirmWristband, loginAttendee, attendeePortalSession, findOrRegisterByPhone,
  boothCheckin, saveSongVote, submitSignup, saveSignupSelections, confirmSignupInPerson, dashboardData,
  boothPresentation, updateBoothPresentation, boothDashboardData, resetDemo, verifyOrganizer,
  triviaState, submitTriviaAnswer, triviaDashboardData, advanceTriviaSession, resetTriviaSession,
  completeTrivia, heavenState, confirmHeavenStep, heavenDashboardData, advanceHeavenSession,
  resetHeavenSession, completeHeaven, completeStory,
  artState, artDashboardData, advanceArtSession, resetArtSession, completeArt,
  newSongState, submitNewSongVote, newSongDashboardData,
  advanceNewSongSession, resetNewSongSession, completeNewSong,
  myCheckins, mySignupSelections, eventClock, setDemoClock,
  googleSheetsExportStatus, syncGoogleSheetsExport,
};
const GET_ACTIONS = { eventClock, health };

// ---------- tiny static file server + router ----------
function serveStatic(req, res, pathname) {
  if (pathname === "/attend" || pathname === "/attend/") {
    const requestUrl = new URL(req.url, "http://localhost");
    requestUrl.searchParams.set("resume", "1");
    res.writeHead(302, {
      Location: `/phase1-entry/index.html?${requestUrl.searchParams.toString()}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  let filePath = path.join(WEB_DIR, decodeURIComponent(pathname));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (pathname === "/" || pathname === "") filePath = path.join(WEB_DIR, "phase1-entry", "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found: " + pathname); return; }
    const ext = path.extname(filePath);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if ([".html", ".js", ".json"].includes(ext)) headers["Cache-Control"] = "no-store";
    res.writeHead(200, headers);
    res.end(data);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendApiFailure(res, error) {
  const status = Number(error && error.status) || 500;
  if (status >= 500) console.error(error);
  sendJson(res, status, {
    error: status === 503
      ? "Event data is temporarily unavailable. Please try again shortly."
      : "The event service hit an unexpected error.",
    code: error && error.code ? error.code : "INTERNAL_ERROR",
  });
}

function runApiHandler(res, handler, payload) {
  try {
    const result = handler(payload);
    if (result && typeof result.then === "function") {
      result
        .then((resolved) => sendJson(res, resolved.status, resolved.body))
        .catch((error) => sendApiFailure(res, error));
      return;
    }
    sendJson(res, result.status, result.body);
  } catch (error) {
    sendApiFailure(res, error);
  }
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    const action = pathname.slice("/api/".length);

    if (req.method === "GET") {
      const handler = GET_ACTIONS[action];
      if (!handler) return sendJson(res, 404, { error: "unknown action: " + action });
      return runApiHandler(res, handler, Object.fromEntries(parsed.searchParams));
    }

    if (req.method === "POST") {
      const handler = POST_ACTIONS[action];
      if (!handler) return sendJson(res, 404, { error: "unknown action: " + action });
      let chunks = "";
      let bodyBytes = 0;
      let bodyTooLarge = false;
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        if (bodyTooLarge) return;
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
          bodyTooLarge = true;
          chunks = "";
          return;
        }
        chunks += chunk;
      });
      req.on("end", () => {
        if (bodyTooLarge) {
          sendJson(res, 413, { error: "request body is too large", code: "REQUEST_TOO_LARGE" });
          return;
        }
        let body = {};
        try {
          body = chunks ? JSON.parse(chunks) : {};
        } catch (error) {
          sendJson(res, 400, { error: "request body must be valid JSON", code: "INVALID_JSON" });
          return;
        }
        runApiHandler(res, handler, body);
      });
      return;
    }

    return sendJson(res, 405, { error: "method not allowed" });
  }

  if (req.method === "GET") return serveStatic(req, res, pathname);
  res.writeHead(405); res.end("Method not allowed");
});

function startServer(port = PORT) {
  sanitizeRetiredVerificationData();
  const listener = server.listen(port, () => {
    const actualPort = server.address().port;
    console.log(`Event app demo server running: http://localhost:${actualPort}`);
    console.log(`  Phase 1 entry:        http://localhost:${actualPort}/phase1-entry/index.html`);
    console.log(`  Attendee booth route: http://localhost:${actualPort}/phase2-booths/hub.html`);
    console.log(`  Phase 3 attendee:     http://localhost:${actualPort}/phase3-signup/index.html`);
    console.log(`  Organizer portal:     http://localhost:${actualPort}/organizer/index.html`);
    console.log(`  QR codes (optional):  http://localhost:${actualPort}/organizer/qr-codes.html`);
    console.log("  Timer previews:       add ?preview=before, 1, 2, waiting, or ended to the attendee/staff URL");
    if (!process.env.EVENT_APP_ORGANIZER_KEY) {
      console.log("  Local organizer key:  demo");
    }
    // A full startup snapshot closes the small window where a durable JSON
    // write succeeded immediately before a process restart. Never queue an
    // empty initial export when persistent storage is missing, though: that
    // could turn a mount problem into a destructive Sheet replacement.
    if (fs.existsSync(DB_PATH) || fs.existsSync(DB_BACKUP_PATH)) {
      queueInitialGoogleSheetsExport();
    }
  });
  return listener;
}

if (require.main === module) startServer();

module.exports = { server, startServer, emptyDb };
