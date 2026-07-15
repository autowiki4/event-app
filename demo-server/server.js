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
const url = require("url");

const DB_PATH = path.join(__dirname, "db.json");
const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = process.env.PORT || 3000;

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

// Find an attendee by attendeeId (checking aliases too — a phone number
// can get linked to more than one device/attendeeId over the course of
// the day) or by phone.
function findAttendee(db, { attendeeId, phone }) {
  const dPhone = phone ? digitsOnly(phone) : null;
  return db.attendees.find((a) => {
    if (attendeeId && (a.attendeeId === attendeeId || (a.aliasIds || []).includes(attendeeId))) return true;
    if (dPhone && a.phone === dPhone) return true;
    return false;
  });
}

// ---------- API actions (request body/query already parsed) ----------

function registerAttendee(body) {
  const { attendeeId, name } = body;
  if (!attendeeId || !name) return { status: 400, body: { error: "attendeeId and name required" } };
  const db = readDb();
  let attendee = findAttendee(db, { attendeeId });
  if (!attendee) {
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
  return { status: 200, body: { raffleNumber: attendee.raffleNumber, attendeeId: attendee.attendeeId } };
}

function confirmWristband(body) {
  const { attendeeId } = body;
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId });
  if (!attendee) return { status: 404, body: { error: "attendee not found" } };
  attendee.wristbandConfirmedAt = new Date().toISOString();
  writeDb(db);
  return { status: 200, body: { ok: true } };
}

function findOrRegisterByPhone(body) {
  const { attendeeId, phone, name } = body;
  const dPhone = digitsOnly(phone);
  if (dPhone.length < 10) return { status: 400, body: { error: "valid phone required" } };
  const db = readDb();

  let attendee = db.attendees.find((a) => a.phone === dPhone);
  if (attendee) {
    if (attendeeId && attendee.attendeeId !== attendeeId && !(attendee.aliasIds || []).includes(attendeeId)) {
      attendee.aliasIds = attendee.aliasIds || [];
      attendee.aliasIds.push(attendeeId);
    }
    writeDb(db);
    return { status: 200, body: { raffleNumber: attendee.raffleNumber, isNew: false, name: attendee.name } };
  }

  attendee = attendeeId ? db.attendees.find((a) => a.attendeeId === attendeeId) : null;
  if (attendee) {
    attendee.phone = dPhone;
    writeDb(db);
    return { status: 200, body: { raffleNumber: attendee.raffleNumber, isNew: false, name: attendee.name } };
  }

  db.raffleCounter += 1;
  attendee = {
    attendeeId: attendeeId || id(), aliasIds: [], name: name || "Guest", phone: dPhone,
    raffleNumber: String(db.raffleCounter), wristbandConfirmedAt: null, registeredAt: new Date().toISOString(),
  };
  db.attendees.push(attendee);
  writeDb(db);
  return { status: 200, body: { raffleNumber: attendee.raffleNumber, isNew: true, name: attendee.name } };
}

function boothCheckin(body) {
  const { attendeeId, phone, boothId, boothName, checkedInBy, rating, note, extraData } = body;
  if (!boothId) return { status: 400, body: { error: "boothId required" } };
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId, phone });
  const row = {
    id: id(),
    attendeeId: attendee ? attendee.attendeeId : attendeeId || null,
    phone: attendee ? attendee.phone : digitsOnly(phone),
    name: attendee ? attendee.name : null,
    boothId, boothName: boothName || boothId,
    checkedInBy: checkedInBy || "self",
    checkedInAt: new Date().toISOString(),
    rating: rating || null, note: note || "", extraData: extraData || null,
  };
  db.boothCheckins.push(row);
  writeDb(db);
  return { status: 200, body: { ok: true, checkinId: row.id } };
}

function submitSignup(body) {
  const { attendeeId, phone, optionId, optionTitle, email, stars, comment } = body;
  if (!optionId) return { status: 400, body: { error: "optionId required" } };
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId, phone });
  const row = {
    id: id(),
    attendeeId: attendee ? attendee.attendeeId : attendeeId || null,
    phone: attendee ? attendee.phone : digitsOnly(phone),
    name: attendee ? attendee.name : null,
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
  const db = readDb();
  const row = db.signups.find((s) => s.id === signupId);
  if (!row) return { status: 404, body: { error: "signup not found" } };
  row.confirmedInPerson = true;
  row.confirmedBy = confirmedBy || "staff";
  row.confirmedAt = new Date().toISOString();
  writeDb(db);
  return { status: 200, body: { ok: true } };
}

function myCheckins(query) {
  const { attendeeId, phone } = query;
  const db = readDb();
  const attendee = findAttendee(db, { attendeeId, phone });
  if (!attendee) return { status: 200, body: { boothIds: [], attendee: null } };
  const ids = [attendee.attendeeId, ...(attendee.aliasIds || [])];
  const boothIds = db.boothCheckins
    .filter((c) => ids.includes(c.attendeeId) || (attendee.phone && c.phone === attendee.phone))
    .map((c) => c.boothId);
  return {
    status: 200,
    body: { boothIds: Array.from(new Set(boothIds)), attendee: { name: attendee.name, raffleNumber: attendee.raffleNumber, phone: attendee.phone } },
  };
}

function dashboardData() {
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
      id: s.id, name: s.name || "Guest", phone: s.phone, optionTitle: s.optionTitle,
      submittedAt: s.submittedAt, confirmedInPerson: s.confirmedInPerson, confirmedBy: s.confirmedBy,
    }));

  return { status: 200, body: { totals, boothCounts, triviaLeaderboard, songVotes, signups } };
}

function resetDemo() {
  writeDb(emptyDb());
  return { status: 200, body: { ok: true } };
}

const POST_ACTIONS = {
  registerAttendee, confirmWristband, findOrRegisterByPhone,
  boothCheckin, submitSignup, confirmSignupInPerson, resetDemo,
};
const GET_ACTIONS = { dashboardData, myCheckins };

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
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    const action = pathname.slice("/api/".length);

    if (req.method === "GET") {
      const handler = GET_ACTIONS[action];
      if (!handler) return sendJson(res, 404, { error: "unknown action: " + action });
      const result = handler(parsed.query);
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

server.listen(PORT, () => {
  console.log(`Event app demo server running: http://localhost:${PORT}`);
  console.log(`  Phase 1 entry:        http://localhost:${PORT}/phase1-entry/index.html`);
  console.log(`  Organizer dashboard:  http://localhost:${PORT}/organizer/dashboard.html`);
  console.log(`  Print QR codes:       http://localhost:${PORT}/organizer/qr-codes.html`);
});
