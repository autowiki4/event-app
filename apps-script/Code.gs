/**
 * Event app production backend — Google Apps Script Web App bound to a
 * Google Sheet ("EventDB"). Implements the exact same actions as
 * demo-server/server.js so web/shared/api.js works unchanged against
 * either backend — only web/shared/config.js's API_BASE_URL differs.
 *
 * For full step-by-step deployment instructions (including the "Google
 * hasn't verified this app" prompt you'll hit the first time, and how to
 * push out changes after the first deploy), see README.md in this same
 * folder. For the exact spreadsheet columns this creates, see
 * SHEET_SCHEMA.md.
 */

const SHEET_NAMES = {
  ATTENDEES: "Attendees",
  BOOTH_CHECKINS: "BoothCheckins",
  SIGNUPS: "SignUps",
  BOOTH_CONTROLS: "BoothControls",
  META: "Meta",
};

const ORGANIZER_KEY_PROPERTY = "ORGANIZER_KEY";
const BOOTH_IDS = ["heaven", "trivia", "story", "art", "newsong"];
const WRISTBAND_COLORS = ["blue", "red", "orange", "green", "yellow"];
const BOOTH_PRESENTATION_STATUSES = ["waiting", "live", "paused", "wrap", "complete"];
const MAX_PRESENTATION_STEP_INDEX = 50;
const MAX_PRESENTATION_MESSAGE_LENGTH = 500;
const FINAL_SIGNUP_OPTIONS = {
  future: "Keep me posted on future events",
  bible: "One-on-one Bible study",
  course: "The 8-month course",
  art: "Art therapy",
  friend: "Help me invite a friend",
};

const HEADERS = {
  // wristbandColor is intentionally appended so an existing Attendees tab can
  // be upgraded in place without shifting any of its older columns.
  [SHEET_NAMES.ATTENDEES]: ["attendeeId", "aliasIds", "name", "phone", "raffleNumber", "wristbandConfirmedAt", "registeredAt", "wristbandColor"],
  [SHEET_NAMES.BOOTH_CHECKINS]: ["id", "attendeeId", "phone", "name", "boothId", "boothName", "checkedInBy", "checkedInAt", "rating", "note", "extraData"],
  [SHEET_NAMES.SIGNUPS]: ["id", "attendeeId", "phone", "name", "optionId", "optionTitle", "email", "stars", "comment", "submittedAt", "confirmedInPerson", "confirmedBy", "confirmedAt"],
  [SHEET_NAMES.BOOTH_CONTROLS]: ["boothId", "stepIndex", "status", "message", "createdAt", "updatedAt", "version"],
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
    return sheet;
  }
  // Existing event sheets predate wristbandColor. Append newly introduced
  // headers rather than inserting columns, preserving every stored value.
  const values = sheet.getDataRange().getValues();
  const existingHeaders = values.length ? values[0].map((header) => String(header || "")) : [];
  if (!existingHeaders.some((header) => header)) {
    HEADERS[name].forEach((header, index) => sheet.getRange(1, index + 1).setValue(header));
    sheet.setFrozenRows(1);
    return sheet;
  }
  HEADERS[name].forEach((header) => {
    if (existingHeaders.indexOf(header) !== -1) return;
    existingHeaders.push(header);
    sheet.getRange(1, existingHeaders.length).setValue(header);
  });
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
  sheet.appendRow(headers.map((h) => sheetSafeValue(obj[h])));
}

function updateRow(name, rowNumber, patch) {
  const sheet = getSheet(name);
  const headers = HEADERS[name];
  headers.forEach((h, idx) => {
    if (patch[h] !== undefined) sheet.getRange(rowNumber, idx + 1).setValue(sheetSafeValue(patch[h]));
  });
}

// Google Sheets evaluates cells beginning with these characters as formulas.
// Every public string passes through this boundary before it reaches a cell so
// names, notes, emails, and other attendee input are always stored as text.
function sheetSafeValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" && (/^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value))) {
    return "'" + value;
  }
  return value;
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

function normalizeRaffleNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeAttendeeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeWristbandColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WRISTBAND_COLORS.indexOf(normalized) === -1 ? null : normalized;
}

function requireWristbandColor(value) {
  const color = normalizeWristbandColor(value);
  if (!color) throw apiError("Choose a valid wristband color.", "INVALID_WRISTBAND_COLOR");
  return color;
}

function requireBoothId(value) {
  const boothId = String(value || "").trim();
  if (BOOTH_IDS.indexOf(boothId) === -1) throw apiError("booth not found", "BOOTH_NOT_FOUND");
  return boothId;
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

function boothPresentationFromRows(rows, boothId) {
  const stored = rows.find((row) => String(row.boothId) === boothId);
  if (!stored) return defaultBoothPresentation(boothId);
  const stepIndex = Number(stored.stepIndex);
  const version = Number(stored.version);
  const status = String(stored.status || "").trim().toLowerCase();
  return {
    boothId,
    stepIndex: Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex <= MAX_PRESENTATION_STEP_INDEX
      ? stepIndex
      : 0,
    status: BOOTH_PRESENTATION_STATUSES.indexOf(status) === -1 ? "waiting" : status,
    message: typeof stored.message === "string"
      ? stored.message.slice(0, MAX_PRESENTATION_MESSAGE_LENGTH)
      : "",
    createdAt: stored.createdAt || null,
    updatedAt: stored.updatedAt || null,
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
  };
}

function newId() {
  return Utilities.getUuid();
}

function nowIso() {
  return new Date().toISOString();
}

function apiError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function requireOrganizer(payload) {
  const configured = PropertiesService.getScriptProperties().getProperty(ORGANIZER_KEY_PROPERTY);
  if (!configured) {
    throw apiError("ORGANIZER_KEY is not configured in Script Properties.", "ORGANIZER_KEY_NOT_CONFIGURED");
  }
  if (!payload || payload.organizerKey !== configured) {
    throw apiError("Organizer access key is invalid.", "AUTH_REQUIRED");
  }
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn(lock);
  } finally {
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

// Raffle numbers are handed out under a lock so two simultaneous
// registrations at the door never get the same number.
function nextRaffleNumber(lock) {
  if (!lock || !lock.hasLock()) {
    throw apiError("Raffle allocation requires the script lock.", "LOCK_REQUIRED");
  }
  const rows = readRows(SHEET_NAMES.META);
  const counterRow = rows.find((r) => r.key === "raffleCounter");
  let value = counterRow ? Number(counterRow.value) : 1000;
  value += 1;
  if (counterRow) {
    updateRow(SHEET_NAMES.META, counterRow._row, { value });
  } else {
    appendRow(SHEET_NAMES.META, { key: "raffleCounter", value });
  }
  return String(value);
}

function findAttendeeInRows(rows, attendeeId, phone) {
  const dPhone = phone ? digitsOnly(phone) : null;
  return rows.find((a) => {
    const aliasIds = toJsonSafe(a.aliasIds, []);
    if (attendeeId && (a.attendeeId === attendeeId || aliasIds.indexOf(attendeeId) !== -1)) return true;
    if (dPhone && String(a.phone) === dPhone) return true;
    return false;
  });
}

function findAttendee(attendeeId, phone) {
  return findAttendeeInRows(readRows(SHEET_NAMES.ATTENDEES), attendeeId, phone);
}

function findAttendeeByRaffleInRows(rows, raffleNumber) {
  const normalized = normalizeRaffleNumber(raffleNumber);
  if (!normalized) return null;
  return rows.find((a) => String(a.raffleNumber) === normalized);
}

function meaningfulName(primary, fallback) {
  if (primary && primary !== "Guest") return primary;
  if (fallback) return fallback;
  return primary || "Guest";
}

function reassignAttendeeReferences(duplicate, canonical) {
  const duplicateIds = [duplicate.attendeeId].concat(toJsonSafe(duplicate.aliasIds, []));
  [SHEET_NAMES.BOOTH_CHECKINS, SHEET_NAMES.SIGNUPS].forEach((sheetName) => {
    readRows(sheetName).forEach((row) => {
      if (duplicateIds.indexOf(row.attendeeId) === -1) return;
      updateRow(sheetName, row._row, {
        attendeeId: canonical.attendeeId,
        phone: canonical.phone,
        name: canonical.name,
      });
    });
  });
}

function mergeAttendees(canonical, duplicate, phone) {
  if (!canonical || !duplicate || canonical._row === duplicate._row) return canonical;

  const aliasIds = Array.from(new Set(
    toJsonSafe(canonical.aliasIds, [])
      .concat([duplicate.attendeeId])
      .concat(toJsonSafe(duplicate.aliasIds, []))
  )).filter((value) => value && value !== canonical.attendeeId);
  const merged = {
    attendeeId: canonical.attendeeId,
    aliasIds: JSON.stringify(aliasIds),
    name: meaningfulName(canonical.name, duplicate.name),
    phone: digitsOnly(phone) || canonical.phone || duplicate.phone || "",
    raffleNumber: canonical.raffleNumber,
    wristbandConfirmedAt: canonical.wristbandConfirmedAt || duplicate.wristbandConfirmedAt || "",
    registeredAt: !canonical.registeredAt || (duplicate.registeredAt && duplicate.registeredAt < canonical.registeredAt)
      ? duplicate.registeredAt
      : canonical.registeredAt,
    wristbandColor: normalizeWristbandColor(canonical.wristbandColor)
      || normalizeWristbandColor(duplicate.wristbandColor)
      || "",
  };

  updateRow(SHEET_NAMES.ATTENDEES, canonical._row, merged);
  reassignAttendeeReferences(duplicate, merged);
  getSheet(SHEET_NAMES.ATTENDEES).deleteRow(duplicate._row);
  return Object.assign({}, canonical, merged);
}

// ---------- action handlers (mirror demo-server/server.js) ----------

function actionRegisterAttendee(payload) {
  const { attendeeId, name } = payload;
  if (!attendeeId || !name) throw new Error("attendeeId and name required");
  return withScriptLock((lock) => {
    let attendee;
    let isNew = false;
    attendee = findAttendee(attendeeId, null);
    if (!attendee) {
      isNew = true;
      const raffleNumber = nextRaffleNumber(lock);
      appendRow(SHEET_NAMES.ATTENDEES, {
        attendeeId,
        aliasIds: "[]",
        name,
        phone: "",
        raffleNumber,
        wristbandConfirmedAt: "",
        registeredAt: nowIso(),
        wristbandColor: "",
      });
      attendee = { attendeeId, raffleNumber, name, wristbandColor: "" };
    } else {
      updateRow(SHEET_NAMES.ATTENDEES, attendee._row, { name });
      attendee.name = name;
    }
    return {
      raffleNumber: attendee.raffleNumber,
      attendeeId: attendee.attendeeId,
      wristbandColor: normalizeWristbandColor(attendee.wristbandColor),
      isNew,
    };
  });
}

function actionConfirmWristband(payload) {
  const { attendeeId, wristbandColor } = payload;
  const color = requireWristbandColor(wristbandColor);
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    const existingColor = normalizeWristbandColor(attendee.wristbandColor);
    if (attendee.wristbandConfirmedAt && existingColor && existingColor !== color) {
      const configuredKey = PropertiesService.getScriptProperties().getProperty(ORGANIZER_KEY_PROPERTY);
      if (!configuredKey || payload.organizerKey !== configuredKey) {
        throw apiError(
          "This wristband color is already assigned. Ask an organizer to correct it.",
          "WRISTBAND_ALREADY_ASSIGNED"
        );
      }
    }
    if (attendee.wristbandConfirmedAt && existingColor === color) {
      return { ok: true, wristbandColor: existingColor };
    }
    updateRow(SHEET_NAMES.ATTENDEES, attendee._row, {
      wristbandConfirmedAt: nowIso(),
      wristbandColor: color,
    });
    return { ok: true, wristbandColor: color };
  });
}

function attendeePortalResult(attendee) {
  return {
    attendeeId: attendee.attendeeId,
    name: attendee.name,
    raffleNumber: attendee.raffleNumber,
    wristbandConfirmed: !!attendee.wristbandConfirmedAt,
    wristbandColor: normalizeWristbandColor(attendee.wristbandColor),
    phoneLinked: !!attendee.phone,
    serverNow: nowIso(),
  };
}

function actionLoginAttendee(payload) {
  const normalizedName = normalizeAttendeeName(payload && payload.name);
  const raffleNumber = normalizeRaffleNumber(payload && payload.raffleNumber);
  if (!normalizedName || !raffleNumber) {
    throw apiError("name and raffle number are required", "LOGIN_FIELDS_REQUIRED");
  }
  return withScriptLock(() => {
    const attendees = readRows(SHEET_NAMES.ATTENDEES);
    const attendee = findAttendeeByRaffleInRows(attendees, raffleNumber);
    if (!attendee || normalizeAttendeeName(attendee.name) !== normalizedName) {
      throw apiError("We couldn't match that name and raffle number.", "ATTENDEE_LOGIN_FAILED");
    }
    if (payload.portal === "phase2" && !attendee.wristbandConfirmedAt) {
      throw apiError("Finish Phase 1 wristband check-in before opening Phase 2.", "PHASE1_INCOMPLETE");
    }
    return attendeePortalResult(attendee);
  });
}

function actionAttendeePortalSession(payload) {
  const attendeeId = payload && payload.attendeeId;
  if (!attendeeId) throw apiError("attendeeId required", "ATTENDEE_ID_REQUIRED");
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    if (payload.portal === "phase2" && !attendee.wristbandConfirmedAt) {
      throw apiError("Finish Phase 1 wristband check-in before opening Phase 2.", "PHASE1_INCOMPLETE");
    }
    return attendeePortalResult(attendee);
  });
}

function actionFindOrRegisterByPhone(payload) {
  const { attendeeId, phone, name, raffleNumber, allowCreate, organizerKey, confirmPairing } = payload;
  const dPhone = digitsOnly(phone);
  if (dPhone.length !== 10) {
    throw apiError("phone must contain exactly 10 digits", "INVALID_PHONE");
  }
  const normalizedRaffle = normalizeRaffleNumber(raffleNumber);
  if (!attendeeId || normalizedRaffle) requireOrganizer(payload);

  return withScriptLock((lock) => {
    const attendees = readRows(SHEET_NAMES.ATTENDEES);
    const phoneAttendee = findAttendeeInRows(attendees, null, dPhone);
    const idAttendee = findAttendeeInRows(attendees, attendeeId, null);
    const configuredKey = PropertiesService.getScriptProperties().getProperty(ORGANIZER_KEY_PROPERTY);
    const isOrganizer = !!configuredKey && organizerKey === configuredKey;

    if (normalizedRaffle) {
      let raffleAttendee = findAttendeeByRaffleInRows(attendees, normalizedRaffle);
      if (!raffleAttendee) throw apiError("No attendee has that raffle number.", "RAFFLE_NOT_FOUND");
      if (raffleAttendee.phone && String(raffleAttendee.phone) !== dPhone) {
        throw apiError("That raffle number is already linked to another phone.", "IDENTITY_CONFLICT");
      }
      const needsPairing = !raffleAttendee.phone || (phoneAttendee && phoneAttendee._row !== raffleAttendee._row);
      if (needsPairing && confirmPairing !== true) {
        return {
          requiresPairingConfirmation: true,
          raffleNumber: raffleAttendee.raffleNumber,
          name: raffleAttendee.name,
        };
      }
      if (phoneAttendee && phoneAttendee._row !== raffleAttendee._row) {
        raffleAttendee = mergeAttendees(raffleAttendee, phoneAttendee, dPhone);
      } else {
        updateRow(SHEET_NAMES.ATTENDEES, raffleAttendee._row, { phone: dPhone });
        raffleAttendee.phone = dPhone;
      }
      return {
        attendeeId: raffleAttendee.attendeeId,
        raffleNumber: raffleAttendee.raffleNumber,
        isNew: false,
        name: raffleAttendee.name,
        wristbandColor: normalizeWristbandColor(raffleAttendee.wristbandColor),
      };
    }

    if (phoneAttendee) {
      if (idAttendee && phoneAttendee._row !== idAttendee._row) {
        throw apiError(
          "That phone is already linked on another device. Restart at entry on this device, then ask staff for help.",
          "PHONE_ALREADY_LINKED"
        );
      }
      if (!idAttendee && attendeeId && !isOrganizer) {
        throw apiError("That phone is already linked. Ask staff for help.", "PHONE_ALREADY_LINKED");
      }
      const aliasIds = toJsonSafe(phoneAttendee.aliasIds, []);
      if (attendeeId && phoneAttendee.attendeeId !== attendeeId && aliasIds.indexOf(attendeeId) === -1) {
        aliasIds.push(attendeeId);
        updateRow(SHEET_NAMES.ATTENDEES, phoneAttendee._row, { aliasIds: JSON.stringify(aliasIds) });
      }
      return {
        attendeeId: phoneAttendee.attendeeId,
        raffleNumber: phoneAttendee.raffleNumber,
        isNew: false,
        name: phoneAttendee.name,
        wristbandColor: normalizeWristbandColor(phoneAttendee.wristbandColor),
      };
    }

    if (idAttendee) {
      if (idAttendee.phone && String(idAttendee.phone) !== dPhone) {
        throw apiError("This attendee is already linked to another phone.", "IDENTITY_CONFLICT");
      }
      updateRow(SHEET_NAMES.ATTENDEES, idAttendee._row, { phone: dPhone });
      return {
        attendeeId: idAttendee.attendeeId,
        raffleNumber: idAttendee.raffleNumber,
        isNew: false,
        name: idAttendee.name,
        wristbandColor: normalizeWristbandColor(idAttendee.wristbandColor),
      };
    }

    // Self-service devices must have registered at Entry first. Only an
    // authenticated staff kiosk may create a true skipped-entry visitor.
    if (attendeeId && !isOrganizer) {
      throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    }

    if (!attendeeId && allowCreate !== true) {
      throw apiError(
        "Enter the visitor's raffle number, or mark that they skipped entry.",
        "RAFFLE_REQUIRED"
      );
    }

    const newRaffleNumber = nextRaffleNumber(lock);
    const newAttendeeId = attendeeId || newId();
    appendRow(SHEET_NAMES.ATTENDEES, {
      attendeeId: newAttendeeId,
      aliasIds: "[]",
      name: name || "Guest",
      phone: dPhone,
      raffleNumber: newRaffleNumber,
      wristbandConfirmedAt: "",
      registeredAt: nowIso(),
      wristbandColor: "",
    });
    return {
      attendeeId: newAttendeeId,
      raffleNumber: newRaffleNumber,
      isNew: true,
      name: name || "Guest",
      wristbandColor: null,
    };
  });
}

function actionBoothCheckin(payload) {
  const { attendeeId, phone, boothId, boothName, checkedInBy, rating, note, extraData } = payload;
  if (!boothId) throw new Error("boothId required");
  if (checkedInBy === "staff-kiosk") requireOrganizer(payload);
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    if (phone && attendee.phone && String(attendee.phone) !== digitsOnly(phone)) {
      throw apiError("phone does not match attendee", "IDENTITY_CONFLICT");
    }
    const existing = readRows(SHEET_NAMES.BOOTH_CHECKINS).find((checkin) => (
      String(checkin.attendeeId) === String(attendee.attendeeId)
        && String(checkin.boothId) === String(boothId)
    ));
    const existingExtra = existing ? toJsonSafe(existing.extraData, {}) : {};
    const incomingExtra = extraData && typeof extraData === "object" && !Array.isArray(extraData) ? extraData : {};
    const mergedExtra = Object.assign({}, existingExtra, incomingExtra);
    const checkin = {
      attendeeId: attendee.attendeeId,
      phone: attendee.phone,
      name: attendee.name,
      boothId,
      boothName: boothName || boothId,
      checkedInBy: checkedInBy || "self",
      checkedInAt: nowIso(),
      rating: rating || "",
      note: note || "",
      extraData: Object.keys(mergedExtra).length ? JSON.stringify(mergedExtra) : "",
    };
    if (existing) {
      if (!Object.prototype.hasOwnProperty.call(payload, "rating")) checkin.rating = existing.rating || "";
      if (!Object.prototype.hasOwnProperty.call(payload, "note")) checkin.note = existing.note || "";
      updateRow(SHEET_NAMES.BOOTH_CHECKINS, existing._row, checkin);
      return { ok: true, checkinId: existing.id, updated: true };
    }
    const checkinId = newId();
    appendRow(SHEET_NAMES.BOOTH_CHECKINS, Object.assign({ id: checkinId }, checkin));
    return { ok: true, checkinId };
  });
}

function actionSubmitSignup(payload) {
  const { attendeeId, phone, optionId, optionTitle, email, stars, comment } = payload;
  if (!optionId) throw new Error("optionId required");
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    if (phone && attendee.phone && String(attendee.phone) !== digitsOnly(phone)) {
      throw apiError("phone does not match attendee", "IDENTITY_CONFLICT");
    }
    const existing = readRows(SHEET_NAMES.SIGNUPS).find((signup) => (
      String(signup.attendeeId) === String(attendee.attendeeId)
        && String(signup.optionId) === String(optionId)
    ));
    if (existing) {
      const patch = {
        phone: attendee.phone,
        name: attendee.name,
        optionTitle: optionTitle || optionId,
      };
      if (Object.prototype.hasOwnProperty.call(payload, "email")) patch.email = email || "";
      if (Object.prototype.hasOwnProperty.call(payload, "stars")) patch.stars = stars || "";
      if (Object.prototype.hasOwnProperty.call(payload, "comment")) patch.comment = comment || "";
      updateRow(SHEET_NAMES.SIGNUPS, existing._row, patch);
      return { ok: true, signupId: existing.id, updated: true };
    }
    const id = newId();
    appendRow(SHEET_NAMES.SIGNUPS, {
      id,
      attendeeId: attendee.attendeeId,
      phone: attendee.phone,
      name: attendee.name,
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
  });
}

function actionSaveSignupSelections(payload) {
  const attendeeId = payload && payload.attendeeId;
  const rawOptionIds = payload && payload.optionIds;
  if (!attendeeId) throw apiError("attendeeId required", "ATTENDEE_ID_REQUIRED");
  if (!Array.isArray(rawOptionIds)) throw apiError("optionIds must be a list", "INVALID_SIGNUP_OPTIONS");
  const optionIds = Array.from(new Set(
    rawOptionIds.map((value) => String(value || "").trim()).filter(Boolean)
  ));
  if (optionIds.some((optionId) => !Object.prototype.hasOwnProperty.call(FINAL_SIGNUP_OPTIONS, optionId))) {
    throw apiError("Choose only valid Phase 3 options.", "INVALID_SIGNUP_OPTIONS");
  }

  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    const selected = new Set(optionIds);
    const staleRows = readRows(SHEET_NAMES.SIGNUPS)
      .filter((signup) => (
        String(signup.attendeeId) === String(attendee.attendeeId)
          && Object.prototype.hasOwnProperty.call(FINAL_SIGNUP_OPTIONS, String(signup.optionId))
          && !selected.has(String(signup.optionId))
          && !(signup.confirmedInPerson === true || String(signup.confirmedInPerson).toLowerCase() === "true")
      ))
      .sort((a, b) => b._row - a._row);
    staleRows.forEach((signup) => getSheet(SHEET_NAMES.SIGNUPS).deleteRow(signup._row));

    const currentRows = readRows(SHEET_NAMES.SIGNUPS);
    const signupIds = optionIds.map((optionId) => {
      const existing = currentRows.find((signup) => (
        String(signup.attendeeId) === String(attendee.attendeeId)
          && String(signup.optionId) === optionId
      ));
      if (existing) {
        updateRow(SHEET_NAMES.SIGNUPS, existing._row, {
          phone: attendee.phone,
          name: attendee.name,
          optionTitle: FINAL_SIGNUP_OPTIONS[optionId],
        });
        return existing.id;
      }
      const signupId = newId();
      appendRow(SHEET_NAMES.SIGNUPS, {
        id: signupId,
        attendeeId: attendee.attendeeId,
        phone: attendee.phone,
        name: attendee.name,
        optionId,
        optionTitle: FINAL_SIGNUP_OPTIONS[optionId],
        email: "",
        stars: "",
        comment: "",
        submittedAt: nowIso(),
        confirmedInPerson: false,
        confirmedBy: "",
        confirmedAt: "",
      });
      return signupId;
    });
    const savedRows = readRows(SHEET_NAMES.SIGNUPS);
    const savedOptionIds = Object.keys(FINAL_SIGNUP_OPTIONS).filter((optionId) => (
      savedRows.some((signup) => (
        String(signup.attendeeId) === String(attendee.attendeeId)
          && String(signup.optionId) === optionId
      ))
    ));
    return { ok: true, optionIds: savedOptionIds, signupIds };
  });
}

function actionConfirmSignupInPerson(payload) {
  const { signupId, confirmedBy } = payload;
  requireOrganizer(payload);
  return withScriptLock(() => {
    const rows = readRows(SHEET_NAMES.SIGNUPS);
    const row = rows.find((r) => r.id === signupId);
    if (!row) throw new Error("signup not found");
    updateRow(SHEET_NAMES.SIGNUPS, row._row, {
      confirmedInPerson: true,
      confirmedBy: confirmedBy || "staff",
      confirmedAt: nowIso(),
    });
    return { ok: true };
  });
}

function actionMyCheckins(params) {
  const { attendeeId } = params;
  if (!attendeeId) throw apiError("attendeeId required", "ATTENDEE_ID_REQUIRED");
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    const aliasIds = toJsonSafe(attendee.aliasIds, []);
    const ids = [attendee.attendeeId].concat(aliasIds);
    const checkins = readRows(SHEET_NAMES.BOOTH_CHECKINS);
    const boothIds = checkins
      .filter((c) => ids.indexOf(c.attendeeId) !== -1 || (attendee.phone && String(c.phone) === String(attendee.phone)))
      .map((c) => c.boothId);
    return { boothIds: Array.from(new Set(boothIds)) };
  });
}

function actionMySignupSelections(payload) {
  const attendeeId = payload && payload.attendeeId;
  if (!attendeeId) throw apiError("attendeeId required", "ATTENDEE_ID_REQUIRED");
  return withScriptLock(() => {
    const attendee = findAttendee(attendeeId, null);
    if (!attendee) throw apiError("attendee not found", "ATTENDEE_NOT_FOUND");
    const signups = readRows(SHEET_NAMES.SIGNUPS);
    const optionIds = Object.keys(FINAL_SIGNUP_OPTIONS).filter((optionId) => (
      signups.some((signup) => (
        String(signup.attendeeId) === String(attendee.attendeeId)
          && String(signup.optionId) === optionId
      ))
    ));
    return { optionIds };
  });
}

function actionDashboardData(payload) {
  requireOrganizer(payload);
  return withScriptLock(() => {
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
      .map((s) => {
        const attendee = findAttendeeInRows(attendees, s.attendeeId, null);
        return {
          id: s.id,
          name: s.name || "Guest",
          phone: s.phone,
          raffleNumber: attendee ? attendee.raffleNumber : "",
          optionId: s.optionId,
          optionTitle: s.optionTitle,
          submittedAt: s.submittedAt,
          confirmedInPerson: !!s.confirmedInPerson,
          confirmedBy: s.confirmedBy,
        };
      });

    return { totals, boothCounts, triviaLeaderboard, songVotes, signups: signupsOut };
  });
}

function actionBoothPresentation(payload) {
  const boothId = requireBoothId(payload && payload.boothId);
  const presentation = boothPresentationFromRows(readRows(SHEET_NAMES.BOOTH_CONTROLS), boothId);
  return Object.assign({}, presentation, { serverNow: nowIso() });
}

function actionUpdateBoothPresentation(payload) {
  requireOrganizer(payload);
  const boothId = requireBoothId(payload && payload.boothId);
  const stepIndex = Number(payload && payload.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > MAX_PRESENTATION_STEP_INDEX) {
    throw apiError(
      `stepIndex must be an integer from 0 to ${MAX_PRESENTATION_STEP_INDEX}.`,
      "INVALID_PRESENTATION_STEP"
    );
  }
  const status = String((payload && payload.status) || "").trim().toLowerCase();
  if (BOOTH_PRESENTATION_STATUSES.indexOf(status) === -1) {
    throw apiError("Choose a valid booth presentation status.", "INVALID_PRESENTATION_STATUS");
  }
  if (payload && payload.message !== undefined && payload.message !== null && typeof payload.message !== "string") {
    throw apiError("message must be text.", "INVALID_PRESENTATION_MESSAGE");
  }
  const message = String((payload && payload.message) || "").trim();
  if (message.length > MAX_PRESENTATION_MESSAGE_LENGTH) {
    throw apiError(
      `message must be ${MAX_PRESENTATION_MESSAGE_LENGTH} characters or fewer.`,
      "INVALID_PRESENTATION_MESSAGE"
    );
  }

  return withScriptLock(() => {
    const rows = readRows(SHEET_NAMES.BOOTH_CONTROLS);
    const existing = rows.find((row) => String(row.boothId) === boothId);
    const previous = boothPresentationFromRows(rows, boothId);
    if (payload && payload.version !== undefined) {
      const expectedVersion = Number(payload.version);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) {
        throw apiError(
          "This booth screen was updated in another tab. Refresh and try again.",
          "PRESENTATION_CONFLICT"
        );
      }
    }
    const now = nowIso();
    const presentation = {
      boothId,
      stepIndex,
      status,
      message,
      createdAt: previous.createdAt || now,
      updatedAt: now,
      version: Math.min(Number.MAX_SAFE_INTEGER, previous.version + 1),
    };
    if (existing) {
      updateRow(SHEET_NAMES.BOOTH_CONTROLS, existing._row, presentation);
    } else {
      appendRow(SHEET_NAMES.BOOTH_CONTROLS, presentation);
    }
    return Object.assign({}, presentation, { serverNow: now });
  });
}

function actionBoothDashboardData(payload) {
  requireOrganizer(payload);
  const boothId = requireBoothId(payload && payload.boothId);
  return withScriptLock(() => {
    const checkins = readRows(SHEET_NAMES.BOOTH_CHECKINS)
      .filter((checkin) => String(checkin.boothId) === boothId)
      .sort((a, b) => new Date(b.checkedInAt) - new Date(a.checkedInAt));
    return {
      boothId,
      presentation: boothPresentationFromRows(readRows(SHEET_NAMES.BOOTH_CONTROLS), boothId),
      serverNow: nowIso(),
      totalCheckins: checkins.length,
      recentCheckins: checkins.slice(0, 50).map((checkin) => ({
        id: checkin.id,
        name: checkin.name || "Guest",
        checkedInAt: checkin.checkedInAt,
        checkedInBy: checkin.checkedInBy,
        rating: checkin.rating || null,
      })),
    };
  });
}

function actionVerifyOrganizer(payload) {
  requireOrganizer(payload);
  return { ok: true };
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
      case "loginAttendee": result = actionLoginAttendee(payload); break;
      case "attendeePortalSession": result = actionAttendeePortalSession(payload); break;
      case "findOrRegisterByPhone": result = actionFindOrRegisterByPhone(payload); break;
      case "boothCheckin": result = actionBoothCheckin(payload); break;
      case "submitSignup": result = actionSubmitSignup(payload); break;
      case "saveSignupSelections": result = actionSaveSignupSelections(payload); break;
      case "confirmSignupInPerson": result = actionConfirmSignupInPerson(payload); break;
      case "dashboardData": result = actionDashboardData(payload); break;
      case "boothPresentation": result = actionBoothPresentation(payload); break;
      case "updateBoothPresentation": result = actionUpdateBoothPresentation(payload); break;
      case "boothDashboardData": result = actionBoothDashboardData(payload); break;
      case "verifyOrganizer": result = actionVerifyOrganizer(payload); break;
      case "myCheckins": result = actionMyCheckins(payload); break;
      case "mySignupSelections": result = actionMySignupSelections(payload); break;
      default: return jsonOutput({ error: "unknown action: " + action, code: "UNKNOWN_ACTION" });
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ error: err.message || String(err), code: err.code || "BACKEND_ERROR" });
  }
}

function doGet(e) {
  const action = e.pathInfo;
  try {
    return jsonOutput({ error: "unknown action: " + action, code: "UNKNOWN_ACTION" });
  } catch (err) {
    return jsonOutput({ error: err.message || String(err), code: err.code || "BACKEND_ERROR" });
  }
}
