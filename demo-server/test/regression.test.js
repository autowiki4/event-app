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
  assert.deepEqual(res.body, {
    attendeeId: "entry-a",
    name: "Avery",
    raffleNumber: "1001",
    wristbandConfirmed: false,
    phoneLinked: false,
  });
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
  assert.equal(res.status, 200);
  res = await request(port, "loginAttendee", {
    name: "Avery",
    raffleNumber: "1001",
    portal: "phase2",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.wristbandConfirmed, true);
  res = await request(port, "attendeePortalSession", { attendeeId: "entry-a", portal: "phase2" });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendeeId, "entry-a");

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
  res = await request(port, "boothDashboardData", { boothId: "newsong", organizerKey });
  assert.equal(res.body.totalCheckins, 1);
  assert.deepEqual(res.body.recentCheckins.map((checkin) => checkin.name), ["Casey"]);

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
  const identityContext = {
    window: { crypto: { randomUUID: () => "generated-id" }, location: { href: "" } },
    localStorage: identityStorage,
    sessionStorage: portalStorage,
    EventAPI: {
      loginAttendee: async (name, raffleNumber) => ({
        attendeeId: "portal-attendee",
        name: name.trim(),
        raffleNumber,
        phoneLinked: false,
      }),
      attendeePortalSession: async (attendeeId) => ({
        attendeeId,
        name: "Jordan Lee",
        raffleNumber: "1001",
        phoneLinked: true,
      }),
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
  let portalIdentity = await attendeePortal.signIn("phase2", "Jordan Lee", "1001");
  assert.equal(portalIdentity.attendeeId, "portal-attendee");
  assert.equal(attendeePortal.hasAccess("phase2"), true);
  assert.equal(attendeePortal.hasAccess("phase3"), false);
  portalIdentity = await attendeePortal.restore("phase2");
  assert.equal(portalIdentity.phoneLinked, true);
  await attendeePortal.signIn("phase3", "Jordan Lee", "1001");
  assert.equal(attendeePortal.hasAccess("phase2"), true);
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
  assert.match(dashboardSource, /if \(!OrganizerAuth\.isCurrent\(authGeneration\)\) return false/);
  assert.match(dashboardSource, /groupSignupsByOption\(data\.signups\)/);
  assert.match(dashboardSource, /Phone\.formatDisplay\(s\.phone\)/);
  assert.doesNotMatch(dashboardSource, /id="signup-table"/);
  assert.match(artKioskSource, /OrganizerAuth\.isCurrent\(authGeneration\)/);
  assert.match(songKioskSource, /let isSaving = false/);
  assert.match(songKioskSource, /if \(isSaving \|\| !currentVisitor\) return/);
  assert.doesNotMatch(phase1Source, /window\.location\.href = "\.\.\/phase2-booths\/hub\.html"/);
  assert.match(phase1Source, /Phase 1 complete/);
  assert.match(phase2Source, /AttendeePortal\.signIn\("phase2"/);
  assert.doesNotMatch(phase2Source, /AttendeePortal\.prefill/);
  assert.match(phase2Source, /id="phase2-name"[^>]*autocomplete="off"/);
  assert.doesNotMatch(phase2Source, /window\.location\.href = "\.\.\/phase3-signup\/index\.html"/);
  assert.match(phase3Source, /AttendeePortal\.signIn\("phase3"/);
  assert.doesNotMatch(phase3Source, /AttendeePortal\.prefill/);
  assert.match(phase3Source, /id="phase3-name"[^>]*autocomplete="off"/);
  assert.match(phase3Source, /you can continue even if you skipped the booths/i);
  assert.match(doneSource, /AttendeePortal\.restore\("phase3"\)/);

  [dashboardSource, artKioskSource, songKioskSource].forEach((source) => {
    assert.match(source, /shared\/phone\.js/);
  });
  ["booth-heaven.html", "booth-story.html", "booth-trivia.html"].forEach((filename) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-booths", filename), "utf8");
    assert.match(source, /shared\/phone\.js/);
    assert.match(source, /shared\/attendee-portal\.js/);
    assert.match(source, /maxlength="14"/);
  });

  const boothStaffCommon = fs.readFileSync(path.join(__dirname, "..", "..", "web", "shared", "booth-staff-common.js"), "utf8");
  assert.match(boothStaffCommon, /EventAPI\.boothDashboardData/);
  assert.doesNotMatch(boothStaffCommon, /EventAPI\.dashboardData\(/);
  ["heaven", "trivia", "story", "art", "newsong"].forEach((boothId) => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "web", "phase2-staff", `${boothId}.html`), "utf8");
    assert.match(source, new RegExp(`initBoothStaff\\("${boothId}"\\)`));
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
    actionConfirmSignupInPerson,
    actionDashboardData,
    actionBoothDashboardData,
    actionMyCheckins,
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
  assert.equal(result.phoneLinked, false);
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
  gas.actionConfirmWristband({ attendeeId: "gas-entry-a" });
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
  result = gas.actionAttendeePortalSession({ attendeeId: "gas-entry-a", portal: "phase2" });
  assert.equal(result.attendeeId, "gas-entry-a");
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
  result = gas.actionMyCheckins({ attendeeId: kioskId });
  assert.deepEqual(Array.from(result.boothIds), ["newsong"]);

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

  function post(action, payload) {
    const output = gas.doPost({ pathInfo: action, postData: { contents: JSON.stringify(payload || {}) } });
    assert.equal(output.mimeType, "json");
    return JSON.parse(output.content);
  }
  assert.equal(post("registerAttendee", { attendeeId: "gas-http-entry", name: "HTTP" }).raffleNumber, "1004");
  assert.equal(post("loginAttendee", { name: "HTTP", raffleNumber: "1004", portal: "phase3" }).attendeeId, "gas-http-entry");
  assert.equal(post("dashboardData", { organizerKey: "wrong" }).code, "AUTH_REQUIRED");
  assert.equal(post("myCheckins", {}).code, "ATTENDEE_ID_REQUIRED");
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
