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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- tiny JSON-file "database" ----------
function emptyDb() {
  return { attendees: [], boothCheckins: [], signups: [], raffleCounter: 1000 };
}
function readDb() {
  if (!fs.existsSync(DB_PATH)) return emptyDb();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
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
      wristbandConfirmedAt: null, registeredAt: new Date().toISOString(),
    };
    db.attendees.push(attendee);
  } else {
    attendee.name = name;
  }
  writeDb(db);
  return { status: 200, body: { raffleNumber: attendee.raffleNumber, attendeeId: attendee.attendeeId, isNew } };
}

function confirmWristband(body) {
  const { attendeeId } = body;
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId });
  if (!attendee) return errorResult(404, "attendee not found", "ATTENDEE_NOT_FOUND");
  attendee.wristbandConfirmedAt = new Date().toISOString();
  writeDb(db);
  return { status: 200, body: { ok: true } };
}

function attendeePortalResult(attendee) {
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name,
    raffleNumber: attendee.raffleNumber,
    wristbandConfirmed: !!attendee.wristbandConfirmedAt,
    phoneLinked: !!attendee.phone,
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
    raffleNumber: String(db.raffleCounter), wristbandConfirmedAt: null, registeredAt: new Date().toISOString(),
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
    checkedInAt: new Date().toISOString(),
    rating: rating || null, note: note || "", extraData: extraData || null,
  };
  const existing = db.boothCheckins.find((checkin) => (
    checkin.attendeeId === attendee.attendeeId && checkin.boothId === boothId
  ));
  if (existing) {
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
  const row = {
    id: id(),
    attendeeId: attendee.attendeeId,
    phone: attendee.phone,
    name: attendee.name,
    optionId, optionTitle: optionTitle || optionId,
    email: email || "", stars: stars || null, comment: comment || "",
    submittedAt: new Date().toISOString(),
    confirmedInPerson: false, confirmedBy: null, confirmedAt: null,
  };
  db.signups.push(row);
  writeDb(db);
  return { status: 200, body: { ok: true, signupId: row.id } };
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
  row.confirmedAt = new Date().toISOString();
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
    .map((s) => ({
      id: s.id, name: s.name || "Guest", phone: s.phone, optionId: s.optionId, optionTitle: s.optionTitle,
      submittedAt: s.submittedAt, confirmedInPerson: s.confirmedInPerson, confirmedBy: s.confirmedBy,
    }));

  return { status: 200, body: { totals, boothCounts, triviaLeaderboard, songVotes, signups } };
}

function boothDashboardData(body) {
  const authError = requireOrganizer(body);
  if (authError) return authError;
  const boothId = String((body && body.boothId) || "");
  if (!BOOTH_IDS.has(boothId)) {
    return errorResult(404, "booth not found", "BOOTH_NOT_FOUND");
  }

  const db = readDb();
  const checkins = db.boothCheckins
    .filter((checkin) => checkin.boothId === boothId)
    .sort((a, b) => new Date(b.checkedInAt) - new Date(a.checkedInAt));
  return {
    status: 200,
    body: {
      boothId,
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
  boothCheckin, submitSignup, confirmSignupInPerson, dashboardData,
  boothDashboardData, resetDemo, verifyOrganizer, myCheckins,
};
const GET_ACTIONS = {};

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
    console.log("  Phase 2 booth rooms:");
    console.log(`    Heaven:             http://localhost:${actualPort}/phase2-booths/booth-heaven.html`);
    console.log(`    Bible Bowl:         http://localhost:${actualPort}/phase2-booths/booth-trivia.html`);
    console.log(`    The Sower:          http://localhost:${actualPort}/phase2-booths/booth-story.html`);
    console.log(`    Art Therapy:        http://localhost:${actualPort}/phase2-booths/booth-art.html`);
    console.log(`    New Song:           http://localhost:${actualPort}/phase2-booths/booth-newsong.html`);
    console.log(`  Phase 3 attendee:     http://localhost:${actualPort}/phase3-signup/index.html`);
    console.log(`  Phase 2 staff hub:    http://localhost:${actualPort}/phase2-staff/index.html`);
    console.log(`  Organizer dashboard:  http://localhost:${actualPort}/organizer/dashboard.html`);
    console.log(`  QR codes (optional):  http://localhost:${actualPort}/organizer/qr-codes.html`);
    console.log("  Local testing:        open each booth room directly; no QR scan required");
    if (!process.env.EVENT_APP_ORGANIZER_KEY) {
      console.log("  Local organizer key:  demo");
    }
  });
}

if (require.main === module) startServer();

module.exports = { server, startServer, emptyDb };
