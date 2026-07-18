/* Each attendee booth is its own Phase 2 room. This module mounts a blank
 * name + phone login, enforces the attendee's timed route, and leaves the
 * room-specific activity to booth-common.js. Staff and kiosk pages do not
 * load this module, so their controls are not affected by the attendee gate. */
function initBoothRoom({ boothId, boothName, roomName = boothName, onReady }) {
  const portal = `phase2.${boothId}`;
  const demoBackend = String(window.EVENT_APP_CONFIG.API_BASE_URL || "").replace(/\/$/, "") === "/api";
  const demoClockReady = demoBackend && typeof EventSchedule.startDemoClockSync === "function"
    ? Promise.resolve(EventSchedule.startDemoClockSync(5000)).catch((error) => console.warn("Demo clock sync unavailable", error))
    : Promise.resolve();
  const phone = document.getElementById("phone");
  const room = document.getElementById("booth-room-content");
  const phoneGate = document.getElementById("booth-gate");
  if (!phone || !room || !phoneGate) throw new Error("Booth room shell is incomplete.");

  const login = document.createElement("section");
  login.className = "screen";
  login.id = "booth-room-login";
  login.innerHTML = `
    <p class="eyebrow">Phase 2 · Booth room</p>
    <h1 class="display">Welcome to the <em id="booth-login-room-name"></em> room.</h1>
    <p class="lede">On a new device or direct link, enter the name and mobile number used at registration. Opening this room from your schedule skips this step.</p>
    <div class="field">
      <label for="booth-login-name">Name used in Phase 1</label>
      <input id="booth-login-name" type="text" autocomplete="off" placeholder="e.g. Jordan Lee">
    </div>
    <div class="field">
      <label for="booth-login-phone">Mobile number</label>
      <input id="booth-login-phone" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="(555) 555-5555">
      <div class="hint">Both fields are required when the room cannot restore your event sign-in.</div>
      <div class="err" id="booth-login-error"></div>
    </div>
    <button class="btn btn-primary" id="btn-booth-login"></button>
    <p class="top-note">Your wristband route and the shared event timer decide when this booth unlocks.</p>
  `;
  phone.insertBefore(login, room);
  document.getElementById("booth-login-room-name").textContent = roomName;
  const loginButton = document.getElementById("btn-booth-login");
  loginButton.textContent = `Check my ${roomName} session →`;

  const locked = document.createElement("section");
  locked.className = "screen booth-room-locked";
  locked.id = "booth-room-locked";
  locked.style.display = "none";
  locked.innerHTML = `
    <div class="attendee-banner">
      <div><span class="attendee-label">Attendee</span><strong id="booth-locked-attendee-name">Guest</strong><span class="attendee-raffle" id="booth-locked-attendee-raffle">Raffle #----</span></div>
      <div class="attendee-banner-actions"><div id="booth-locked-attendee-menu"></div></div>
    </div>
    <div class="booth-lock-card">
      <div class="booth-lock-icon" aria-hidden="true">🔒</div>
      <p class="eyebrow" id="booth-lock-kicker">Timed booth access</p>
      <h1 class="display" id="booth-lock-title">This booth is locked.</h1>
      <p class="lede" id="booth-lock-copy"></p>
      <div class="booth-lock-time" id="booth-lock-time" style="display:none;"></div>
    </div>
    <a class="btn btn-primary" id="btn-booth-route" href="hub.html" style="display:block; text-decoration:none;">View my booth schedule →</a>
  `;
  phone.insertBefore(locked, room);

  const welcome = document.createElement("section");
  welcome.className = "screen booth-room-welcome";
  welcome.id = "booth-room-welcome";
  welcome.innerHTML = `
    <div class="attendee-banner">
      <div><span class="attendee-label">Attendee</span><strong id="booth-room-attendee-name">Guest</strong><span class="attendee-raffle" id="booth-room-attendee-raffle">Raffle #----</span></div>
      <div class="attendee-banner-actions"><div id="booth-room-attendee-menu"></div></div>
    </div>
    <div class="booth-guide">
      <div class="g-kicker">Your active booth · Open now</div>
      <div class="g-loc" id="booth-welcome-title"></div>
      <div class="g-detail"><span id="booth-welcome-raffle"></span> · This room stays available until the current 20-minute session ends.</div>
    </div>
  `;
  room.insertBefore(welcome, phoneGate);

  const warning = document.createElement("div");
  warning.className = "booth-ending-warning booth-room-ending-warning";
  warning.id = "booth-room-ending-warning";
  warning.setAttribute("role", "status");
  warning.setAttribute("aria-live", "assertive");
  warning.style.display = "none";
  warning.innerHTML = `
    <strong>15 seconds left</strong>
    <span>Go to the end and tap Finish now so your visit saves before this booth closes.</span>
  `;
  room.insertBefore(warning, phoneGate);

  const complete = document.createElement("section");
  complete.className = "screen";
  complete.id = "booth-room-complete";
  complete.style.display = "none";
  complete.innerHTML = `
    <div class="attendee-banner">
      <div><span class="attendee-label">Attendee</span><strong id="booth-complete-attendee-name">Guest</strong><span class="attendee-raffle" id="booth-complete-attendee-raffle">Raffle #----</span></div>
      <div class="attendee-banner-actions"><div id="booth-complete-attendee-menu"></div></div>
    </div>
    <div class="done-badge booth-visited-badge">✓</div>
    <p class="eyebrow" style="text-align:center;">Visit saved</p>
    <h1 class="display" style="text-align:center;">Thank you for visiting <em id="booth-complete-name"></em></h1>
    <p class="lede" style="text-align:center;">This booth is marked visited. You may reopen it until your session ends.</p>
    <button class="btn btn-ghost" id="btn-booth-reopen">Reopen this booth</button>
    <a class="btn btn-primary" id="btn-booth-complete-route" href="hub.html" style="display:block; text-decoration:none; margin-top:10px;">Return to my schedule →</a>
  `;
  phone.appendChild(complete);
  const completeName = complete.querySelector("#booth-complete-name");
  completeName.textContent = boothName;

  const nameInput = document.getElementById("booth-login-name");
  const phoneInput = document.getElementById("booth-login-phone");
  const loginError = document.getElementById("booth-login-error");
  nameInput.value = "";
  phoneInput.value = "";
  Phone.bind(phoneInput);
  let currentIdentity = null;
  let roomStarted = false;
  let roomCompleted = false;
  let visibleView = "";

  function renderAttendeeIdentity() {
    if (!currentIdentity) return;
    ["booth-locked-attendee-name", "booth-room-attendee-name", "booth-complete-attendee-name"].forEach((id) => {
      const target = document.getElementById(id);
      if (target) target.textContent = currentIdentity.name || "Guest";
    });
    ["booth-locked-attendee-raffle", "booth-room-attendee-raffle", "booth-complete-attendee-raffle"].forEach((id) => {
      const target = document.getElementById(id);
      if (target) target.textContent = `Raffle #${currentIdentity.raffleNumber || "----"}`;
    });
    const logoutUrl = EventSchedule.linkWithPreview("../phase1-entry/index.html");
    ["booth-locked-attendee-menu", "booth-room-attendee-menu", "booth-complete-attendee-menu"].forEach((id) => {
      AttendeeMenu.mount(id, { identity: currentIdentity, logoutUrl });
    });
  }

  function boothAccess(identity, snapshot) {
    if (!identity || !identity.wristbandColor) return false;
    if (typeof EventSchedule.canOpenBooth === "function") {
      return Boolean(EventSchedule.canOpenBooth(
        identity.wristbandColor,
        boothId,
        snapshot,
        identity.boothArrivalPlan || identity.wristbandConfirmedAt
      ));
    }
    const route = EventSchedule.route(identity.wristbandColor);
    return snapshot.phase === "active" && route[snapshot.sessionIndex] === boothId;
  }

  function routeDetails(identity, snapshot) {
    const route = EventSchedule.route(identity.wristbandColor);
    if (snapshot.phase === "ended") {
      return {
        kicker: "Message time",
        title: "It's time for the main message.",
        copy: "Both booth rotations are complete. Please get seated and turn your attention to the message.",
        time: "Starting now",
      };
    }
    if (snapshot.phase === "waiting") {
      return {
        kicker: "Booths finished",
        title: "The main message starts at 4:00 PM.",
        copy: "Return to your schedule, finish the quick Phase 3 selection if needed, and stay nearby for the message.",
        time: `${EventSchedule.formatCountdown(snapshot.remainingMs)} until the message`,
      };
    }
    const routeIndex = route.indexOf(boothId);
    if (routeIndex < 0) {
      return {
        kicker: "Not on your wristband route",
        title: `${roomName} is not one of your stops.`,
        copy: `Use your personal booth schedule to see the ${route.length || BOOTH_SESSIONS.length} rooms assigned to your wristband color.`,
        time: "",
      };
    }
    const session = BOOTH_SESSIONS[routeIndex];
    const sessionTime = session ? `${EventSchedule.formattedTime(session.startsAt)}–${EventSchedule.formattedTime(session.endsAt)}` : "";
    const arrival = typeof EventSchedule.arrivalPlan === "function"
      ? EventSchedule.arrivalPlan(identity.boothArrivalPlan || identity.wristbandConfirmedAt)
      : { missedSessionIndices: [] };
    if (arrival.missedSessionIndices.includes(routeIndex)) {
      const nextNumber = arrival.firstEligibleSessionNumber;
      return {
        kicker: "Catch-up needed",
        title: `${roomName} is saved as a catch-up stop.`,
        copy: nextNumber
          ? `You checked in near the end of this rotation, so this room will stay closed. Wait for Session ${nextNumber} and follow your schedule to the next booth.`
          : "The final rotation is almost over. Ask an organizer how to complete this catch-up booth.",
        time: sessionTime ? `Original session: ${sessionTime}` : "",
      };
    }
    const isPast = snapshot.phase === "active" && routeIndex < snapshot.sessionIndex;
    if (isPast) {
      return {
        kicker: "Session ended",
        title: `${roomName} is now closed.`,
        copy: "Booth rooms cannot be reopened after their assigned session. Return to your schedule for your current stop.",
        time: sessionTime,
      };
    }
    return {
      kicker: `Your stop ${routeIndex + 1} of ${route.length}`,
      title: `${roomName} is not open yet.`,
      copy: "This booth unlocks automatically when its assigned session begins. You do not need to refresh.",
      time: sessionTime ? `Opens for you at ${sessionTime}` : "",
    };
  }

  function showOnly(viewName) {
    if (visibleView === viewName) return;
    login.style.display = viewName === "login" ? "block" : "none";
    locked.style.display = viewName === "locked" ? "block" : "none";
    room.style.display = viewName === "room" ? "block" : "none";
    complete.style.display = viewName === "complete" ? "block" : "none";
    visibleView = viewName;
  }

  function showLogin(message, clearFields) {
    showOnly("login");
    if (clearFields) {
      nameInput.value = "";
      phoneInput.value = "";
    }
    loginError.textContent = message || "";
    loginError.style.display = message ? "block" : "none";
  }

  function showLocked(snapshot) {
    showOnly("locked");
    const details = routeDetails(currentIdentity, snapshot);
    document.getElementById("booth-lock-kicker").textContent = details.kicker;
    document.getElementById("booth-lock-title").textContent = details.title;
    document.getElementById("booth-lock-copy").textContent = details.copy;
    const lockTime = document.getElementById("booth-lock-time");
    lockTime.textContent = details.time;
    lockTime.style.display = details.time ? "block" : "none";
  }

  function showRoom(identity, snapshot) {
    showOnly("room");
    document.getElementById("booth-welcome-title").textContent = `Welcome, ${identity.name || "friend"}, to the ${roomName} room.`;
    document.getElementById("booth-welcome-raffle").textContent = `Raffle #${identity.raffleNumber || "----"}`;
    if (!roomStarted) {
      roomStarted = true;
      initBoothGate({ boothId, boothName, onReady, identity });
    }
    updateEndingWarning(snapshot);
  }

  function showComplete() {
    showOnly("complete");
  }

  function updateEndingWarning(snapshot) {
    const endingSoon = snapshot.phase === "active"
      && (typeof EventSchedule.isEndingSoon === "function"
        ? EventSchedule.isEndingSoon(snapshot, 15000)
        : snapshot.remainingMs > 0 && snapshot.remainingMs <= 15000);
    warning.style.display = endingSoon && !roomCompleted ? "flex" : "none";
  }

  function refreshBoothRoomAccess() {
    if (!currentIdentity) return false;
    const snapshot = EventSchedule.current();
    if (!boothAccess(currentIdentity, snapshot)) {
      showLocked(snapshot);
      return false;
    }
    if (roomCompleted) showComplete();
    else showRoom(currentIdentity, snapshot);
    return true;
  }

  async function restoreRoomState(identity) {
    currentIdentity = identity;
    renderAttendeeIdentity();
    try {
      const checkins = await EventAPI.myCheckins(identity.attendeeId);
      // Startup can validate the cached device identity and the refreshed
      // backend session concurrently. Completion is append-only, so a slower
      // stale response must never turn a restored completed visit back into
      // an unfinished room.
      roomCompleted = roomCompleted || (checkins.boothIds || []).includes(boothId);
    } catch (error) {
      // Access can still render from the signed-in identity. The booth gate
      // will retry its normal backend session restore before showing activity.
      console.warn("Couldn't restore this booth's completion state", error);
    }
    refreshBoothRoomAccess();
  }

  async function submitLogin() {
    const name = nameInput.value.trim();
    const phone = Phone.digits(phoneInput);
    if (!name || !Phone.isValid(phoneInput)) {
      showLogin("Enter the name and 10-digit mobile number used at registration.");
      return;
    }
    loginButton.disabled = true;
    loginButton.textContent = "Finding your session…";
    try {
      await demoClockReady;
      await restoreRoomState(await AttendeePortal.signIn(portal, name, phone));
    } catch (error) {
      console.error(error);
      if (["ATTENDEE_LOGIN_FAILED", "LOGIN_FIELDS_REQUIRED", "PHASE1_INCOMPLETE"].includes(error.code)) {
        showLogin(error.message);
      } else {
        toast("Couldn't sign in — check the connection and try again.");
      }
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = `Check my ${roomName} session →`;
    }
  }

  loginButton.addEventListener("click", submitLogin);
  [nameInput, phoneInput].forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Return") return;
    if (event.isComposing || event.repeat) return;
    event.preventDefault();
    if (loginButton.disabled) return;
    loginButton.click();
  }));
  document.getElementById("btn-booth-reopen").addEventListener("click", () => {
    roomCompleted = false;
    refreshBoothRoomAccess();
  });

  const routeUrl = EventSchedule.linkWithPreview("hub.html");
  document.getElementById("btn-booth-route").href = routeUrl;
  document.getElementById("btn-booth-complete-route").href = routeUrl;

  window.isCurrentBoothRoomOpen = () => {
    if (!currentIdentity) return false;
    return boothAccess(currentIdentity, EventSchedule.current());
  };
  window.refreshBoothRoomAccess = refreshBoothRoomAccess;
  window.completeBoothRoom = (completedBoothName) => {
    roomCompleted = true;
    completeName.textContent = typeof completedBoothName === "string" && completedBoothName.trim()
      ? completedBoothName
      : boothName;
    refreshBoothRoomAccess();
  };

  setInterval(refreshBoothRoomAccess, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBoothRoomAccess();
  });

  demoClockReady.then(() => {
    const savedIdentity = Identity.peek();
    const hasRoomAccess = AttendeePortal.hasAccess(portal);
    const hasArrivalRecord = Boolean(
      savedIdentity.wristbandConfirmedAt
        || (savedIdentity.boothArrivalPlan && savedIdentity.boothArrivalPlan.confirmedAt)
    );
    if (!savedIdentity.attendeeId) {
      showLogin("", true);
      return;
    }
    if (savedIdentity.wristbandColor && hasArrivalRecord) restoreRoomState(savedIdentity);
    const restoreIdentity = hasRoomAccess
      ? AttendeePortal.restore(portal)
      : AttendeePortal.continueAs(portal);
    restoreIdentity
      .then(restoreRoomState)
      .catch((error) => {
        console.error(error);
        if (savedIdentity.wristbandColor && hasArrivalRecord) {
          toast("You're still signed in. Live progress is reconnecting.");
          refreshBoothRoomAccess();
        } else {
          const message = error.code === "PHASE1_INCOMPLETE"
            ? error.message
            : `We couldn't restore ${roomName} yet. Check the connection and retry.`;
          showLogin(message, false);
        }
      });
  });
}
