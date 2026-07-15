/**
 * Event app production backend — Google Apps Script Web App bound to a
 * Google Sheet ("EventDB"). Implements the exact same actions as
 * demo-server/server.js so web/shared/api.js works unchanged against
 * either backend — only web/shared/config.js's API_BASE_URL differs.
 *
 * SETUP
 * 1. Create a new Google Sheet, name it whatever you like (e.g. "EventDB").
 * 2. Extensions > Apps Script. Delete the default code, paste this file in.
 * 3. Deploy > New deployment > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. Copy the /exec URL it gives you.
 * 5. In web/shared/config.js, set API_BASE_URL to that /exec URL
 *    (or pass it per-device via ?base=... — see config.js).
 * 6. Reload the deployment (Deploy > Manage deployments > edit > New
 *    version) any time you change this file.
 *
 * See SHEET_SCHEMA.md for the exact column layout this creates.
 */

const SHEET_NAMES = {
  ATTENDEES: "Attendees",
  BOOTH_CHECKINS: "BoothCheckins",
  SIGNUPS: "SignUps",
  META: "Meta",
};

const HEADERS = {
  [SHEET_NAMES.ATTENDEES]: ["attendeeId", "aliasIds", "name", "phone", "raffleNumber", "wristbandConfirmedAt", "registeredAt"],
  [SHEET_NAMES.BOOTH_CHECKINS]: ["id", "attendeeId", "phone", "name", "boothId", "boothName", "checkedInBy", "checkedInAt", "rating", "note", "extraData"],
  [SHEET_NAMES.SIGNUPS]: ["id", "attendeeId", "phone", "name", "optionId", "optionTitle", "email", "stars", "comment", "submittedAt", "confirmedInPerson", "confirmedBy", "confirmedAt"],
  [SHEET_NAMES.META]: ["key", "value"],
};

// ---------- sheet helpers ----------

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows(name) {
  const sheet = getSheet(name);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = values[i][idx]));
    obj._row = i + 1; // 1-indexed sheet row, for updates
    rows.push(obj);
  }
  return rows;
}

function appendRow(name, obj) {
  const sheet = getSheet(name);
  const headers = HEADERS[name];
  sheet.appendRow(headers.map((h) => (obj[h] === undefined || obj[h] === null ? "" : obj[h])));
}

function updateRow(name, rowNumber, patch) {
  const sheet = getSheet(name);
  const headers = HEADERS[name];
  headers.forEach((h, idx) => {
    if (patch[h] !== undefined) sheet.getRange(rowNumber, idx + 1).setValue(patch[h]);
  });
}

function toJsonSafe(val, fallback) {
  if (val === "" || val === null || val === undefined) return fallback;
  if (typeof val === "object") return val; // already parsed (shouldn't happen from sheet, but defensive)
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
}

function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function newId() {
  return Utilities.getUuid();
}

function nowIso() {
  return new Date().toISOString();
}

// Raffle numbers are handed out under a lock so two simultaneous
// registrations at the door never get the same number.
function nextRaffleNumber() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET_NAMES.META);
    const rows = readRows(SHEET_NAMES.META);
    let counterRow = rows.find((r) => r.key === "raffleCounter");
    let value = counterRow ? Number(counterRow.value) : 1000;
    value += 1;
    if (counterRow) {
      updateRow(SHEET_NAMES.META, counterRow._row, { value });
    } else {
      appendRow(SHEET_NAMES.META, { key: "raffleCounter", value });
    }
    return String(value);
  } finally {
    lock.releaseLock();
  }
}

function findAttendee(attendeeId, phone) {
  const dPhone = phone ? digitsOnly(phone) : null;
  const rows = readRows(SHEET_NAMES.ATTENDEES);
  return rows.find((a) => {
    const aliasIds = toJsonSafe(a.aliasIds, []);
    if (attendeeId && (a.attendeeId === attendeeId || aliasIds.indexOf(attendeeId) !== -1)) return true;
    if (dPhone && String(a.phone) === dPhone) return true;
    return false;
  });
}

// ---------- action handlers (mirror demo-server/server.js) ----------

function actionRegisterAttendee(payload) {
  const { attendeeId, name } = payload;
  if (!attendeeId || !name) throw new Error("attendeeId and name required");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let attendee;
  try {
    attendee = findAttendee(attendeeId, null);
    if (!attendee) {
      const raffleNumber = nextRaffleNumber();
      appendRow(SHEET_NAMES.ATTENDEES, {
        attendeeId,
        aliasIds: "[]",
        name,
        phone: "",
        raffleNumber,
        wristbandConfirmedAt: "",
        registeredAt: nowIso(),
      });
      attendee = { attendeeId, raffleNumber };
    } else {
      updateRow(SHEET_NAMES.ATTENDEES, attendee._row, { name });
    }
  } finally {
    lock.releaseLock();
  }
  return { raffleNumber: attendee.raffleNumber, attendeeId };
}

function actionConfirmWristband(payload) {
  const { attendeeId } = payload;
  const attendee = findAttendee(attendeeId, null);
  if (!attendee) throw new Error("attendee not found");
  updateRow(SHEET_NAMES.ATTENDEES, attendee._row, { wristbandConfirmedAt: nowIso() });
  return { ok: true };
}

function actionFindOrRegisterByPhone(payload) {
  const { attendeeId, phone, name } = payload;
  const dPhone = digitsOnly(phone);
  if (dPhone.length < 10) throw new Error("valid phone required");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let attendee = findAttendee(null, dPhone);
    if (attendee) {
      const aliasIds = toJsonSafe(attendee.aliasIds, []);
      if (attendeeId && attendee.attendeeId !== attendeeId && aliasIds.indexOf(attendeeId) === -1) {
        aliasIds.push(attendeeId);
        updateRow(SHEET_NAMES.ATTENDEES, attendee._row, { aliasIds: JSON.stringify(aliasIds) });
      }
      return { raffleNumber: attendee.raffleNumber, isNew: false, name: attendee.name };
    }

    attendee = attendeeId ? findAttendee(attendeeId, null) : null;
    if (attendee) {
      updateRow(SHEET_NAMES.ATTENDEES, attendee._row, { phone: dPhone });
      return { raffleNumber: attendee.raffleNumber, isNew: false, name: attendee.name };
    }

    const raffleNumber = nextRaffleNumber();
    const newAttendeeId = attendeeId || newId();
    appendRow(SHEET_NAMES.ATTENDEES, {
      attendeeId: newAttendeeId,
      aliasIds: "[]",
      name: name || "Guest",
      phone: dPhone,
      raffleNumber,
      wristbandConfirmedAt: "",
      registeredAt: nowIso(),
    });
    return { raffleNumber, isNew: true, name: name || "Guest" };
  } finally {
    lock.releaseLock();
  }
}

function actionBoothCheckin(payload) {
  const { attendeeId, phone, boothId, boothName, checkedInBy, rating, note, extraData } = payload;
  if (!boothId) throw new Error("boothId required");
  const attendee = findAttendee(attendeeId, phone);
  appendRow(SHEET_NAMES.BOOTH_CHECKINS, {
    id: newId(),
    attendeeId: attendee ? attendee.attendeeId : attendeeId || "",
    phone: attendee ? attendee.phone : digitsOnly(phone),
    name: attendee ? attendee.name : "",
    boothId,
    boothName: boothName || boothId,
    checkedInBy: checkedInBy || "self",
    checkedInAt: nowIso(),
    rating: rating || "",
    note: note || "",
    extraData: extraData ? JSON.stringify(extraData) : "",
  });
  return { ok: true };
}

function actionSubmitSignup(payload) {
  const { attendeeId, phone, optionId, optionTitle, email, stars, comment } = payload;
  if (!optionId) throw new Error("optionId required");
  const attendee = findAttendee(attendeeId, phone);
  const id = newId();
  appendRow(SHEET_NAMES.SIGNUPS, {
    id,
    attendeeId: attendee ? attendee.attendeeId : attendeeId || "",
    phone: attendee ? attendee.phone : digitsOnly(phone),
    name: attendee ? attendee.name : "",
    optionId,
    optionTitle: optionTitle || optionId,
    email: email || "",
    stars: stars || "",
    comment: comment || "",
    submittedAt: nowIso(),
    confirmedInPerson: false,
    confirmedBy: "",
    confirmedAt: "",
  });
  return { ok: true, signupId: id };
}

function actionConfirmSignupInPerson(payload) {
  const { signupId, confirmedBy } = payload;
  const rows = readRows(SHEET_NAMES.SIGNUPS);
  const row = rows.find((r) => r.id === signupId);
  if (!row) throw new Error("signup not found");
  updateRow(SHEET_NAMES.SIGNUPS, row._row, {
    confirmedInPerson: true,
    confirmedBy: confirmedBy || "staff",
    confirmedAt: nowIso(),
  });
  return { ok: true };
}

function actionMyCheckins(params) {
  const { attendeeId, phone } = params;
  const attendee = findAttendee(attendeeId, phone);
  if (!attendee) return { boothIds: [], attendee: null };
  const aliasIds = toJsonSafe(attendee.aliasIds, []);
  const ids = [attendee.attendeeId].concat(aliasIds);
  const checkins = readRows(SHEET_NAMES.BOOTH_CHECKINS);
  const boothIds = checkins
    .filter((c) => ids.indexOf(c.attendeeId) !== -1 || (attendee.phone && String(c.phone) === String(attendee.phone)))
    .map((c) => c.boothId);
  return {
    boothIds: Array.from(new Set(boothIds)),
    attendee: { name: attendee.name, raffleNumber: attendee.raffleNumber, phone: attendee.phone },
  };
}

function actionDashboardData() {
  const attendees = readRows(SHEET_NAMES.ATTENDEES);
  const checkins = readRows(SHEET_NAMES.BOOTH_CHECKINS);
  const signups = readRows(SHEET_NAMES.SIGNUPS);

  const totals = {
    registered: attendees.length,
    wristbandsConfirmed: attendees.filter((a) => a.wristbandConfirmedAt).length,
    raffleEntries: attendees.length,
  };

  const boothCountsMap = {};
  checkins.forEach((c) => {
    if (!boothCountsMap[c.boothId]) boothCountsMap[c.boothId] = { boothId: c.boothId, boothName: c.boothName, count: 0 };
    boothCountsMap[c.boothId].count += 1;
  });
  const boothCounts = Object.keys(boothCountsMap)
    .map((k) => boothCountsMap[k])
    .sort((a, b) => b.count - a.count);

  const triviaLeaderboard = checkins
    .filter((c) => c.boothId === "trivia" && c.extraData)
    .map((c) => {
      const extra = toJsonSafe(c.extraData, {});
      return { name: c.name || "Guest", score: Number(extra.score) || 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const songVotesMap = {};
  checkins
    .filter((c) => c.boothId === "newsong" && c.extraData)
    .forEach((c) => {
      const extra = toJsonSafe(c.extraData, {});
      if (extra.votedFor) songVotesMap[extra.votedFor] = (songVotesMap[extra.votedFor] || 0) + 1;
    });
  const songVotes = Object.keys(songVotesMap)
    .map((title) => ({ title, votes: songVotesMap[title] }))
    .sort((a, b) => b.votes - a.votes);

  const signupsOut = signups
    .slice()
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
    .map((s) => ({
      id: s.id,
      name: s.name || "Guest",
      phone: s.phone,
      optionTitle: s.optionTitle,
      submittedAt: s.submittedAt,
      confirmedInPerson: !!s.confirmedInPerson,
      confirmedBy: s.confirmedBy,
    }));

  return { totals, boothCounts, triviaLeaderboard, songVotes, signups: signupsOut };
}

// ---------- HTTP entry points ----------
// Apps Script Web Apps expose extra URL path segments (after /exec) via
// e.pathInfo, which is what lets web/shared/api.js call e.g. POST /exec/boothCheckin
// the same way it calls POST /api/boothCheckin against the demo server.

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const action = e.pathInfo;
  let payload = {};
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    // ignore — payload stays {}
  }
  try {
    let result;
    switch (action) {
      case "registerAttendee": result = actionRegisterAttendee(payload); break;
      case "confirmWristband": result = actionConfirmWristband(payload); break;
      case "findOrRegisterByPhone": result = actionFindOrRegisterByPhone(payload); break;
      case "boothCheckin": result = actionBoothCheckin(payload); break;
      case "submitSignup": result = actionSubmitSignup(payload); break;
      case "confirmSignupInPerson": result = actionConfirmSignupInPerson(payload); break;
      default: return jsonOutput({ error: "unknown action: " + action });
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: String(err) });
  }
}

function doGet(e) {
  const action = e.pathInfo;
  try {
    let result;
    switch (action) {
      case "dashboardData": result = actionDashboardData(); break;
      case "myCheckins": result = actionMyCheckins(e.parameter); break;
      default: return jsonOutput({ error: "unknown action: " + action });
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: String(err) });
  }
}
