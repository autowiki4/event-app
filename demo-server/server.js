/* Local demo backend — implements the exact same API contract as
 * apps-script/Code.gs, but backed by a plain JSON file instead of a Google
 * Sheet. This is what lets you run the whole multi-device flow on a laptop
 * for a demo/presentation, with no Google account or deployment needed.
 *
 * Deliberately zero npm dependencies (just Node's built-in http/fs) — so
 * there's no "npm install" step, nothing that can fail to fetch on a
 * conference wifi, and no version drift. Just: node server.js.
 *
 * Swapping to the real event: point web/shared/config.js's API_BASE_URL at
 * your deployed Apps Script /exec URL instead of running this server. The
 * frontend code doesn't change either way.
 *
 * Run: node server.js   (serves web/ + the /api/* routes on :3000)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = process.env.EVENT_APP_DB_PATH || path.join(__dirname, "db.json");
const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = process.env.PORT || 3000;
const ORGANIZER_KEY = process.env.EVENT_APP_ORGANIZER_KEY || "demo";
const BOOTH_IDS = new Set(["heaven", "trivia", "story", "art", "newsong"]);
const WRISTBAND_COLORS = new Set(["blue", "red", "orange", "green", "yellow"]);
const BOOTH_PRESENTATION_STATUSES = new Set(["waiting", "live", "paused", "wrap", "complete"]);
const MAX_PRESENTATION_STEP_INDEX = 50;
const MAX_PRESENTATION_MESSAGE_LENGTH = 500;
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

function nextDemoClockUpdatedAt(realNowMs) {
  const previousMs = Date.parse(demoClock.updatedAt);
  const nextMs = Number.isFinite(previousMs) ? Math.max(realNowMs, previousMs + 1) : realNowMs;
  return new Date(nextMs).toISOString();
}

function demoClockResult() {
  return {
    serverNow: eventNowIso(),
    mode: demoClock.mode,
    controlled: demoClock.controlled,
    targetIso: Number.isFinite(demoClock.targetMs)
      ? new Date(demoClock.targetMs).toISOString()
      : null,
    updatedAt: demoClock.updatedAt,
  };
}

// ---------- tiny JSON-file "database" ----------
function emptyDb() {
  return {
    attendees: [],
    boothCheckins: [],
    signups: [],
    boothPresentations: {},
    raffleCounter: 1000,
  };
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
  db.signups = Array.isArray(source.signups)
    ? source.signups.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  db.boothPresentations = source.boothPresentations
    && typeof source.boothPresentations === "object"
    && !Array.isArray(source.boothPresentations)
    ? source.boothPresentations
    : {};
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
  return db;
}
function readDb() {
  if (!fs.existsSync(DB_PATH)) return emptyDb();
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
  } catch (e) {
    return emptyDb();
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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

  [db.boothCheckins, db.signups].forEach((rows) => {
    rows.forEach((row) => {
      if (!duplicateIds.has(row.attendeeId)) return;
      row.attendeeId = canonical.attendeeId;
      row.phone = canonical.phone;
      row.name = canonical.name;
    });
  });
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

function dashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const db = readDb();
  const totals = {
    registered: db.attendees.length,
    wristbandsConfirmed: db.attendees.filter((a) => a.wristbandConfirmedAt).length,
    raffleEntries: db.attendees.length,
  };

  const boothCountsMap = {};
  db.boothCheckins.forEach((c) => {
    boothCountsMap[c.boothId] = boothCountsMap[c.boothId] || { boothId: c.boothId, boothName: c.boothName, count: 0 };
    boothCountsMap[c.boothId].count += 1;
  });
  const boothCounts = Object.values(boothCountsMap).sort((a, b) => b.count - a.count);

  const triviaLeaderboard = db.boothCheckins
    .filter((c) => c.boothId === "trivia" && c.extraData && typeof c.extraData.score === "number")
    .map((c) => ({ name: c.name || "Guest", score: c.extraData.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const songVotesMap = {};
  db.boothCheckins
    .filter((c) => c.boothId === "newsong" && c.extraData && c.extraData.votedFor)
    .forEach((c) => { songVotesMap[c.extraData.votedFor] = (songVotesMap[c.extraData.votedFor] || 0) + 1; });
  const songVotes = Object.entries(songVotesMap)
    .map(([title, votes]) => ({ title, votes }))
    .sort((a, b) => b.votes - a.votes);

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

  return { status: 200, body: { totals, boothCounts, triviaLeaderboard, songVotes, signups } };
}

function boothPresentation(body) {
  const boothResult = requireBoothId(body && body.boothId);
  if (boothResult.error) return boothResult.error;
  const db = readDb();
  return {
    status: 200,
    body: Object.assign(
      boothPresentationFromDb(db, boothResult.boothId),
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
      presentation: boothPresentationFromDb(db, boothId),
      serverNow: eventNowIso(),
      totalCheckins: checkins.length,
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
  writeDb(emptyDb());
  return { status: 200, body: { ok: true } };
}

function verifyOrganizer(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  return { status: 200, body: { ok: true } };
}

const POST_ACTIONS = {
  registerAttendee, confirmWristband, loginAttendee, attendeePortalSession, findOrRegisterByPhone,
  boothCheckin, submitSignup, saveSignupSelections, confirmSignupInPerson, dashboardData,
  boothPresentation, updateBoothPresentation, boothDashboardData, resetDemo, verifyOrganizer,
  myCheckins, mySignupSelections, eventClock, setDemoClock,
};
const GET_ACTIONS = { eventClock };

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
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    const action = pathname.slice("/api/".length);

    if (req.method === "GET") {
      const handler = GET_ACTIONS[action];
      if (!handler) return sendJson(res, 404, { error: "unknown action: " + action });
      const result = handler(Object.fromEntries(parsed.searchParams));
      return sendJson(res, result.status, result.body);
    }

    if (req.method === "POST") {
      const handler = POST_ACTIONS[action];
      if (!handler) return sendJson(res, 404, { error: "unknown action: " + action });
      let chunks = "";
      req.on("data", (c) => (chunks += c));
      req.on("end", () => {
        let body = {};
        try { body = chunks ? JSON.parse(chunks) : {}; } catch (e) { /* leave as {} */ }
        const result = handler(body);
        sendJson(res, result.status, result.body);
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
    console.log(`  Phase 2 staff hub:    http://localhost:${actualPort}/phase2-staff/index.html`);
    console.log(`  Organizer dashboard:  http://localhost:${actualPort}/organizer/dashboard.html`);
    console.log(`  QR codes (optional):  http://localhost:${actualPort}/organizer/qr-codes.html`);
    console.log("  Timer previews:       add ?preview=before, 1, 2, 3, or ended to the attendee/staff URL");
    if (!process.env.EVENT_APP_ORGANIZER_KEY) {
      console.log("  Local organizer key:  demo");
    }
  });
}

if (require.main === module) startServer();

module.exports = { server, startServer, emptyDb };
