/* Each attendee booth is its own Phase 2 room. This module mounts a blank
 * name + raffle login, grants access only to the current booth, and leaves
 * the room-specific activity to booth-common.js. */
function initBoothRoom({ boothId, boothName, roomName = boothName, onReady }) {
  const portal = `phase2.${boothId}`;
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
    <p class="lede">You are at this booth now. Enter the name and raffle number from Phase 1 to open this room only.</p>
    <div class="field">
      <label for="booth-login-name">Name used in Phase 1</label>
      <input id="booth-login-name" type="text" autocomplete="off" placeholder="e.g. Jordan Lee">
    </div>
    <div class="field">
      <label for="booth-login-raffle">Raffle number</label>
      <input id="booth-login-raffle" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 1001">
      <div class="hint">Both fields are required and start blank at every booth.</div>
      <div class="err" id="booth-login-error"></div>
    </div>
    <button class="btn btn-primary" id="btn-booth-login"></button>
    <p class="top-note">You will log in separately when you arrive at another booth.</p>
  `;
  phone.insertBefore(login, room);
  document.getElementById("booth-login-room-name").textContent = roomName;
  const loginButton = document.getElementById("btn-booth-login");
  loginButton.textContent = `Enter the ${roomName} room →`;

  const welcome = document.createElement("section");
  welcome.className = "screen booth-room-welcome";
  welcome.id = "booth-room-welcome";
  welcome.innerHTML = `
    <div class="staff-toolbar"><button class="btn-link" id="btn-booth-switch">Switch attendee</button></div>
    <div class="booth-guide">
      <div class="g-kicker">Signed into this booth only</div>
      <div class="g-loc" id="booth-welcome-title"></div>
      <div class="g-detail">When you visit another booth, open that booth's link and log in there.</div>
    </div>
  `;
  room.insertBefore(welcome, phoneGate);

  const complete = document.createElement("section");
  complete.className = "screen";
  complete.id = "booth-room-complete";
  complete.style.display = "none";
  complete.innerHTML = `
    <div class="done-badge">✓</div>
    <p class="eyebrow" style="text-align:center;">Booth complete</p>
    <h1 class="display" style="text-align:center;">Thank you for visiting <em id="booth-complete-name"></em></h1>
    <p class="lede" style="text-align:center;">You can close this link now. When you get to another booth, open that booth's link and log in there.</p>
  `;
  phone.appendChild(complete);
  const completeName = complete.querySelector("#booth-complete-name");
  completeName.textContent = boothName;

  const nameInput = document.getElementById("booth-login-name");
  const raffleInput = document.getElementById("booth-login-raffle");
  const loginError = document.getElementById("booth-login-error");
  nameInput.value = "";
  raffleInput.value = "";
  let roomStarted = false;

  function showLogin(message, clearFields) {
    room.style.display = "none";
    complete.style.display = "none";
    login.style.display = "block";
    if (clearFields) {
      nameInput.value = "";
      raffleInput.value = "";
    }
    loginError.textContent = message || "";
    loginError.style.display = message ? "block" : "none";
  }

  function showRoom(identity) {
    login.style.display = "none";
    complete.style.display = "none";
    room.style.display = "block";
    document.getElementById("booth-welcome-title").textContent = `Welcome, ${identity.name || "friend"}, to the ${roomName} room.`;
    if (!roomStarted) {
      roomStarted = true;
      initBoothGate({ boothId, boothName, onReady, identity });
    }
  }

  async function submitLogin() {
    const name = nameInput.value.trim();
    const raffleNumber = raffleInput.value.trim();
    if (!name || !raffleNumber) {
      showLogin("Enter both your Phase 1 name and raffle number.");
      return;
    }
    loginButton.disabled = true;
    loginButton.textContent = "Finding registration…";
    try {
      showRoom(await AttendeePortal.signIn(portal, name, raffleNumber));
    } catch (error) {
      console.error(error);
      if (["ATTENDEE_LOGIN_FAILED", "LOGIN_FIELDS_REQUIRED", "PHASE1_INCOMPLETE"].includes(error.code)) {
        showLogin(error.message);
      } else {
        toast("Couldn't sign in — check the connection and try again.");
      }
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = `Enter the ${roomName} room →`;
    }
  }

  loginButton.addEventListener("click", submitLogin);
  [nameInput, raffleInput].forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitLogin();
  }));
  document.getElementById("btn-booth-switch").addEventListener("click", () => {
    AttendeePortal.clearAccess(portal);
    window.location.reload();
  });

  window.completeBoothRoom = (completedBoothName) => {
    login.style.display = "none";
    room.style.display = "none";
    complete.style.display = "block";
    completeName.textContent = typeof completedBoothName === "string" && completedBoothName.trim()
      ? completedBoothName
      : boothName;
  };

  if (!AttendeePortal.hasAccess(portal)) {
    showLogin("", true);
    return;
  }
  AttendeePortal.restore(portal)
    .then(showRoom)
    .catch((error) => {
      console.error(error);
      AttendeePortal.clearAccess(portal);
      const message = error.code === "PHASE1_INCOMPLETE"
        ? error.message
        : `Log in to enter the ${roomName} room.`;
      showLogin(message, true);
    });
}
