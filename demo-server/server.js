/* Node rehearsal backend — implements the core attendee/staff API from
 * apps-script/Code.gs plus Node-only shared-clock and full-reset actions,
 * backed by a plain JSON file instead of a Google Sheet. It runs the whole
 * multi-device flow locally or as a same-origin service on Render.
 *
 * Deliberately zero npm dependencies (just Node's built-in http/fs) — so
 * there's no "npm install" step, nothing that can fail to fetch on a
 * conference wifi, and no version drift. Just: node server.js.
 *
 * Switching the core journey to Apps Script only changes API_BASE_URL, but
 * that adapter intentionally has no remote rehearsal clock or resetDemo.
 *
 * Run: node server.js   (serves web/ + the /api/* routes on :3000)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TRIVIA_QUESTIONS } = require("./trivia-questions");

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
  story: "The Sower, Live",
  art: "Art Therapy Table",
  newsong: "The New Song in Nashville",
});
const WRISTBAND_ROUTES = Object.freeze({
  blue: ["heaven", "trivia", "story"],
  red: ["trivia", "heaven", "art"],
  orange: ["art", "story", "newsong"],
  green: ["newsong", "art", "heaven"],
  yellow: ["story", "newsong", "trivia"],
});
const BOOTH_SESSIONS = Object.freeze([
  { number: 1, startsAt: "2026-07-18T15:10:00-05:00", endsAt: "2026-07-18T15:30:00-05:00", label: "3:10–3:30 PM" },
  { number: 2, startsAt: "2026-07-18T15:30:00-05:00", endsAt: "2026-07-18T15:50:00-05:00", label: "3:30–3:50 PM" },
  { number: 3, startsAt: "2026-07-18T15:50:00-05:00", endsAt: "2026-07-18T16:10:00-05:00", label: "3:50–4:10 PM" },
]);
const BOOTH_PRESENTATION_STATUSES = new Set(["waiting", "live", "paused", "wrap", "complete"]);
const MAX_PRESENTATION_STEP_INDEX = 50;
const MAX_PRESENTATION_MESSAGE_LENGTH = 500;
const TRIVIA_SESSION_NUMBERS = new Set([1, 2, 3]);
const TRIVIA_PHASES = new Set(["welcome", "question", "reveal", "complete"]);
const DEMO_CLOCK_MODES = new Set([
  "live",
  "custom",
  "before",
  "session1-start",
  "session1",
  "session2",
  "session3",
  "session1-final15",
  "session2-final15",
  "session3-final15",
  "ended",
]);
const EVENT_WINDOW_START_MS = Date.parse(BOOTH_SESSIONS[0].startsAt);
const EVENT_WINDOW_END_MS = Date.parse(BOOTH_SESSIONS[BOOTH_SESSIONS.length - 1].endsAt);
const FINAL_SIGNUP_OPTIONS = new Map([
  ["future", "Keep me posted on future events"],
  ["bible", "One-on-one Bible study"],
  ["course", "The 8-month course"],
  ["art", "Art therapy"],
  ["friend", "Help me invite a friend"],
]);
const NEW_SONG_CHOICES = new Set([
  "Great Are You Lord",
  "Way Maker",
  "Goodness of God",
  "Build My Life",
  "Reckless Love",
  "King of Kings",
  "Living Hope",
  "Graves Into Gardens",
  "Raise a Hallelujah",
  "The Blessing",
  "O Come to the Altar",
  "Do It Again",
  "House of the Lord",
  "Same God",
  "Great Things",
  "Battle Belongs",
  "Jireh",
  "Yes I Will",
  "Firm Foundation",
  "Champion",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
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
  return {
    phase: "ended",
    serverNow: new Date(nowMs).toISOString(),
    sessionIndex: null,
    sessionNumber: null,
    sessionLabel: null,
  };
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
    raffleCounter: 1000,
    dataResetAt: "initial",
  };
}
function normalizeDataResetAt(value) {
  if (value === "initial") return "initial";
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs) ? new Date(valueMs).toISOString() : "initial";
}
function normalizeDb(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const db = Object.assign(emptyDb(), source);
  db.attendees = Array.isArray(source.attendees)
    ? source.attendees.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  db.boothCheckins = Array.isArray(source.boothCheckins)
    ? source.boothCheckins.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  db.songVotes = Array.isArray(source.songVotes)
    ? source.songVotes.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
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
  TRIVIA_SESSION_NUMBERS.forEach((sessionNumber) => {
    const key = String(sessionNumber);
    if (sourceTriviaSessions[key]) {
      db.triviaSessions[key] = normalizeTriviaSessionRecord(sourceTriviaSessions[key], sessionNumber);
    }
  });
  db.triviaAnswers = normalizeTriviaAnswers(source.triviaAnswers);
  db.attendees.forEach((attendee) => {
    if (!Array.isArray(attendee.aliasIds)) attendee.aliasIds = [];
    attendee.wristbandColor = normalizeWristbandColor(attendee.wristbandColor);
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
      fs.copyFileSync(DB_PATH, DB_BACKUP_PATH);
    }
    fs.renameSync(tempPath, DB_PATH);
    dbCache = normalized;
    dbCacheFingerprint = fileFingerprint(DB_PATH);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (cleanupError) { /* best effort */ }
    try { fs.rmSync(backupTempPath, { force: true }); } catch (cleanupError) { /* best effort */ }
    throw databaseUnavailable("The event database could not be saved. No in-memory success was reported.", error);
  }
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
    message: typeof stored.message === "string"
      ? stored.message.slice(0, MAX_PRESENTATION_MESSAGE_LENGTH)
      : "",
    createdAt: stored.createdAt || null,
    updatedAt: stored.updatedAt || null,
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
  };
}

function normalizeTriviaSessionNumber(value) {
  const sessionNumber = Number(value);
  return Number.isInteger(sessionNumber) && TRIVIA_SESSION_NUMBERS.has(sessionNumber)
    ? sessionNumber
    : null;
}

function defaultTriviaSession(sessionNumber) {
  return {
    sessionNumber,
    phase: "welcome",
    questionIndex: -1,
    version: 0,
    startedAt: null,
    updatedAt: null,
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
  if (phase !== "welcome" && !hasQuestion) return defaultTriviaSession(sessionNumber);
  const parsedVersion = Number(raw.version);
  return {
    sessionNumber,
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
    const sessionNumber = normalizeTriviaSessionNumber(raw.sessionNumber);
    const questionId = String(raw.questionId || "").trim();
    const question = TRIVIA_QUESTIONS.find((item) => item.id === questionId);
    const answerIndex = Number(raw.answerIndex);
    if (!attendeeId || !sessionNumber || !question || !Number.isInteger(answerIndex)
      || answerIndex < 0 || answerIndex >= question.choices.length) return;
    const key = `${sessionNumber}:${attendeeId}:${questionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    answers.push({
      id: String(raw.id || `legacy-${sessionNumber}-${attendeeId}-${questionId}`),
      attendeeId,
      sessionNumber,
      questionId,
      questionNumber: TRIVIA_QUESTIONS.indexOf(question) + 1,
      answerIndex,
      isCorrect: answerIndex === question.correctIndex,
      answeredAt: earliestTimestamp(raw.answeredAt) || null,
    });
  });
  return answers;
}

function requireTriviaSessionNumber(value) {
  const sessionNumber = normalizeTriviaSessionNumber(value);
  return sessionNumber
    ? { sessionNumber }
    : { error: errorResult(400, "Choose Bible Bowl Session 1, 2, or 3.", "INVALID_TRIVIA_SESSION") };
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

function triviaQuestionsRevealed(session) {
  if (session.questionIndex < 0) return 0;
  return session.phase === "question" ? session.questionIndex : session.questionIndex + 1;
}

function triviaAnswersFor(db, attendeeId, sessionNumber) {
  return db.triviaAnswers.filter((answer) => (
    answer.attendeeId === attendeeId && answer.sessionNumber === sessionNumber
  ));
}

function triviaScore(db, attendeeId, sessionNumber, session) {
  const answers = triviaAnswersFor(db, attendeeId, sessionNumber);
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
  return { attendee, eventState, sessionNumber: eventState.sessionNumber };
}

function triviaBoothPresentation(db, eventState = eventSessionState()) {
  const sessionNumber = eventState.phase === "active" && eventState.sessionNumber
    ? eventState.sessionNumber
    : 1;
  const session = triviaSessionFromDb(db, sessionNumber);
  let stepIndex = 0;
  let status = "waiting";
  let message = "The Bible Bowl leader will start the first question when the group is ready.";
  if (session.phase === "question" || session.phase === "reveal") {
    status = "live";
    stepIndex = session.questionIndex < 5 ? 1 : session.questionIndex < 10 ? 2 : 3;
    message = session.phase === "reveal"
      ? `Question ${session.questionIndex + 1} answer revealed. Keep the activity open for what comes next.`
      : `Question ${session.questionIndex + 1} of ${TRIVIA_QUESTIONS.length} is open in the Bible Bowl activity.`;
  } else if (session.phase === "complete") {
    status = "complete";
    stepIndex = 4;
    message = "Final Bible Bowl results are ready. Open the activity to finish this visit.";
  }
  return {
    boothId: "trivia",
    stepIndex,
    status,
    message,
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
  canonical.wristbandConfirmedAt = canonical.wristbandConfirmedAt || duplicate.wristbandConfirmedAt || null;
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
  db.triviaAnswers.forEach((answer) => {
    if (duplicateIds.has(answer.attendeeId)) answer.attendeeId = canonical.attendeeId;
  });
  db.triviaAnswers = normalizeTriviaAnswers(db.triviaAnswers);
  db.attendees = db.attendees.filter((attendee) => attendee !== duplicate);
  return canonical;
}

// ---------- API actions (request body/query already parsed) ----------

function registerAttendee(body) {
  const { attendeeId, name } = body;
  if (!attendeeId || !name) return { status: 400, body: { error: "attendeeId and name required" } };
  const db = readDb();
  let attendee = findAttendee(db, { attendeeId });
  let isNew = false;
  if (!attendee) {
    isNew = true;
    db.raffleCounter += 1;
    attendee = {
      attendeeId, aliasIds: [], name, phone: null,
      raffleNumber: String(db.raffleCounter),
      wristbandConfirmedAt: null, registeredAt: eventNowIso(), wristbandColor: null,
      phase3CompletedAt: null,
    };
    db.attendees.push(attendee);
  } else {
    attendee.name = name;
  }
  writeDb(db);
  return {
    status: 200,
    body: {
      raffleNumber: attendee.raffleNumber,
      attendeeId: attendee.attendeeId,
      wristbandColor: normalizeWristbandColor(attendee.wristbandColor),
      isNew,
      dataResetAt: db.dataResetAt,
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
    return { status: 200, body: { ok: true, wristbandColor: existingColor } };
  }
  attendee.wristbandConfirmedAt = eventNowIso();
  attendee.wristbandColor = colorResult.color;
  writeDb(db);
  return { status: 200, body: { ok: true, wristbandColor: attendee.wristbandColor } };
}

function attendeePortalResult(attendee) {
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name,
    raffleNumber: attendee.raffleNumber,
    wristbandConfirmed: !!attendee.wristbandConfirmedAt,
    wristbandColor: normalizeWristbandColor(attendee.wristbandColor),
    phoneLinked: !!attendee.phone,
    phase3CompletedAt: attendee.phase3CompletedAt || null,
    serverNow: eventNowIso(),
    dataResetAt: readDb().dataResetAt,
  };
}

function loginAttendee(body) {
  const normalizedName = normalizeAttendeeName(body && body.name);
  const raffleNumber = normalizeRaffleNumber(body && body.raffleNumber);
  if (!normalizedName || !raffleNumber) {
    return errorResult(400, "name and raffle number are required", "LOGIN_FIELDS_REQUIRED");
  }

  const db = readDb();
  const attendee = findAttendeeByRaffle(db, raffleNumber);
  if (!attendee || normalizeAttendeeName(attendee.name) !== normalizedName) {
    return errorResult(401, "We couldn't match that name and raffle number.", "ATTENDEE_LOGIN_FAILED");
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
  const normalizedRaffle = normalizeRaffleNumber(raffleNumber);
  const isOrganizer = organizerKeyMatches(organizerKey);

  // Staff kiosks have no attendee identity of their own. Their phone lookup,
  // raffle pairing, and skip-entry creation path are organizer-only.
  if (!attendeeId && !isOrganizer) return requireOrganizer(body);
  if (normalizedRaffle && !isOrganizer) return requireOrganizer(body);

  const db = readDb();
  const phoneAttendee = findAttendeeByPhone(db, dPhone);
  const idAttendee = findAttendeeById(db, attendeeId);

  if (normalizedRaffle) {
    let raffleAttendee = findAttendeeByRaffle(db, normalizedRaffle);
    if (!raffleAttendee) {
      return errorResult(404, "No attendee has that raffle number.", "RAFFLE_NOT_FOUND");
    }
    if (raffleAttendee.phone && raffleAttendee.phone !== dPhone) {
      return errorResult(409, "That raffle number is already linked to another phone.", "IDENTITY_CONFLICT");
    }
    const needsPairing = !raffleAttendee.phone || (phoneAttendee && phoneAttendee !== raffleAttendee);
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
    if (phoneAttendee && phoneAttendee !== raffleAttendee) {
      raffleAttendee = mergeAttendees(db, raffleAttendee, phoneAttendee, dPhone);
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

  if (phoneAttendee) {
    if (idAttendee && phoneAttendee !== idAttendee) {
      // Knowing a phone number is not proof of ownership. A staff member must
      // pair records after the visitor registers this browser at entry.
      return errorResult(409, "That phone is already linked on another device. Restart at entry on this device, then ask staff for help.", "PHONE_ALREADY_LINKED");
    }
    if (!idAttendee && attendeeId && !isOrganizer) {
      return errorResult(409, "That phone is already linked. Ask staff for help.", "PHONE_ALREADY_LINKED");
    }
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

  if (idAttendee) {
    if (idAttendee.phone && idAttendee.phone !== dPhone) {
      return errorResult(409, "This attendee is already linked to another phone.", "IDENTITY_CONFLICT");
    }
    idAttendee.phone = dPhone;
    writeDb(db);
    return {
      status: 200,
      body: {
        attendeeId: idAttendee.attendeeId,
        raffleNumber: idAttendee.raffleNumber,
        isNew: false,
        name: idAttendee.name,
        wristbandColor: normalizeWristbandColor(idAttendee.wristbandColor),
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
  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
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
  const existing = db.boothCheckins.find((checkin) => (
    checkin.attendeeId === attendee.attendeeId && checkin.boothId === boothId
  ));
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

function songVoteCounts(db) {
  // Dedicated votes are saved at tap time so the leader can choose a winner
  // during the opening four-minute beat. Older completed check-ins still
  // count when a database predates the dedicated vote collection.
  const voteByAttendee = new Map();
  db.boothCheckins
    .filter((checkin) => (
      checkin.boothId === "newsong"
      && checkin.extraData
      && NEW_SONG_CHOICES.has(checkin.extraData.votedFor)
    ))
    .forEach((checkin) => voteByAttendee.set(checkin.attendeeId, checkin.extraData.votedFor));
  db.songVotes
    .filter((vote) => NEW_SONG_CHOICES.has(vote.songTitle))
    .forEach((vote) => voteByAttendee.set(vote.attendeeId, vote.songTitle));

  const totals = new Map();
  voteByAttendee.forEach((songTitle) => totals.set(songTitle, (totals.get(songTitle) || 0) + 1));
  return Array.from(totals.entries())
    .map(([title, votes]) => ({ title, votes }))
    .sort((a, b) => b.votes - a.votes || a.title.localeCompare(b.title));
}

function saveSongVote(body) {
  const attendeeId = body && body.attendeeId;
  const songTitle = String((body && body.songTitle) || "").trim();
  if (!attendeeId) return errorResult(400, "attendeeId required", "ATTENDEE_ID_REQUIRED");
  if (!NEW_SONG_CHOICES.has(songTitle)) {
    return errorResult(400, "Choose a valid New Song option.", "INVALID_SONG_CHOICE");
  }

  const db = readDb();
  const attendee = findAttendeeById(db, attendeeId);
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  const previous = db.songVotes.find((vote) => vote.attendeeId === attendee.attendeeId);
  const now = eventNowIso();
  if (previous) {
    previous.songTitle = songTitle;
    previous.name = attendee.name;
    previous.votedAt = now;
  } else {
    db.songVotes.push({
      id: id(),
      attendeeId: attendee.attendeeId,
      name: attendee.name,
      songTitle,
      votedAt: now,
    });
  }
  writeDb(db);
  const votes = songVoteCounts(db);
  const selected = votes.find((entry) => entry.title === songTitle);
  return {
    status: 200,
    body: {
      ok: true,
      songTitle,
      votes: selected ? selected.votes : 1,
      totalVotes: db.songVotes.length,
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
    .filter((c) => ids.includes(c.attendeeId) || (attendee.phone && c.phone === attendee.phone))
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

function triviaLeaderboardForSession(db, sessionNumber, session) {
  const rowsByAttendee = new Map();
  db.triviaAnswers
    .filter((answer) => answer.sessionNumber === sessionNumber)
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
      answer.sessionNumber === sessionNumber && answer.questionId === currentQuestionId
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
    question,
    responseCount,
    questionsRevealed: triviaQuestionsRevealed(session),
    leaderboard: triviaLeaderboardForSession(db, sessionNumber, session),
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
  const reset = defaultTriviaSession(sessionResult.sessionNumber);
  reset.version = previous.version + 1;
  reset.updatedAt = eventNowIso();
  db.triviaSessions[String(sessionResult.sessionNumber)] = reset;
  db.triviaAnswers = db.triviaAnswers.filter((answer) => answer.sessionNumber !== sessionResult.sessionNumber);
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
      score,
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
          .filter((checkin) => (
            attendeeIds.has(String(checkin.attendeeId))
              || (attendee.phone && checkin.phone === attendee.phone)
          ))
          .map((checkin) => checkin.boothId));
        const completedBoothIds = route.filter((boothId) => completedSet.has(boothId));
        return {
          name: attendee.name || "Guest",
          raffleNumber: attendee.raffleNumber || "",
          completedBoothIds,
          completedStops: completedBoothIds.length,
          totalStops: route.length,
          currentStopCompleted: currentBoothId ? completedSet.has(currentBoothId) : null,
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
  db.boothCheckins.forEach((c) => {
    boothCountsMap[c.boothId] = boothCountsMap[c.boothId] || { boothId: c.boothId, boothName: c.boothName, count: 0 };
    boothCountsMap[c.boothId].count += 1;
  });
  const boothCounts = Object.values(boothCountsMap).sort((a, b) => b.count - a.count);

  const triviaLeaderboard = Array.from(TRIVIA_SESSION_NUMBERS).flatMap((sessionNumber) => {
    const session = triviaSessionFromDb(db, sessionNumber);
    return triviaLeaderboardForSession(db, sessionNumber, session).map((row) => ({
      sessionNumber,
      name: row.name,
      score: row.correctCount,
      answeredCount: row.answeredCount,
      totalQuestions: row.totalQuestions,
    }));
  }).sort((a, b) => (
    b.score - a.score
      || b.answeredCount - a.answeredCount
      || a.sessionNumber - b.sessionNumber
      || a.name.localeCompare(b.name)
  )).slice(0, 10);

  const songVotes = songVoteCounts(db);

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
      triviaLeaderboard,
      songVotes,
      signups,
    },
  };
}

function boothPresentation(body) {
  const boothResult = requireBoothId(body && body.boothId);
  if (boothResult.error) return boothResult.error;
  const db = readDb();
  const presentation = boothResult.boothId === "trivia"
    ? triviaBoothPresentation(db)
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

  const stepIndex = Number(body && body.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > MAX_PRESENTATION_STEP_INDEX) {
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
  const presentation = {
    boothId: boothResult.boothId,
    stepIndex,
    status,
    message,
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

  const targetMs = Date.parse(body && body.targetIso);
  if (!Number.isFinite(targetMs)) {
    return errorResult(
      400,
      "targetIso must be a valid event timestamp for this demo clock mode.",
      "INVALID_DEMO_CLOCK_TARGET"
    );
  }
  if (
    mode === "custom"
    && (targetMs < EVENT_WINDOW_START_MS || targetMs > EVENT_WINDOW_END_MS)
  ) {
    return errorResult(
      400,
      "Custom demo time must be between the event start at 3:10 PM and end at 4:10 PM CDT.",
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
  registerAttendee, confirmWristband, loginAttendee, attendeePortalSession, findOrRegisterByPhone,
  boothCheckin, saveSongVote, submitSignup, saveSignupSelections, confirmSignupInPerson, dashboardData,
  boothPresentation, updateBoothPresentation, boothDashboardData, resetDemo, verifyOrganizer,
  triviaState, submitTriviaAnswer, triviaDashboardData, advanceTriviaSession, resetTriviaSession,
  completeTrivia, myCheckins, mySignupSelections, eventClock, setDemoClock,
};
const GET_ACTIONS = { eventClock, health };

// ---------- tiny static file server + router ----------
function serveStatic(req, res, pathname) {
  let filePath = path.join(WEB_DIR, decodeURIComponent(pathname));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (pathname === "/" || pathname === "") filePath = path.join(WEB_DIR, "phase1-entry", "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found: " + pathname); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
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
  return server.listen(port, () => {
    const actualPort = server.address().port;
    console.log(`Event app demo server running: http://localhost:${actualPort}`);
    console.log(`  Phase 1 entry:        http://localhost:${actualPort}/phase1-entry/index.html`);
    console.log(`  Attendee booth route: http://localhost:${actualPort}/phase2-booths/hub.html`);
    console.log(`  Phase 3 attendee:     http://localhost:${actualPort}/phase3-signup/index.html`);
    console.log(`  Organizer portal:     http://localhost:${actualPort}/organizer/index.html`);
    console.log(`  QR codes (optional):  http://localhost:${actualPort}/organizer/qr-codes.html`);
    console.log("  Timer previews:       add ?preview=before, 1, 2, 3, or ended to the attendee/staff URL");
    if (!process.env.EVENT_APP_ORGANIZER_KEY) {
      console.log("  Local organizer key:  demo");
    }
  });
}

if (require.main === module) startServer();

module.exports = { server, startServer, emptyDb };
