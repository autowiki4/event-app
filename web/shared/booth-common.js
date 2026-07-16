/* Shared behavior for every attendee booth room: the phone-number gate
 * (asked once, reused everywhere after) and the note/star-rating/done
 * footer that logs the visit back to the shared backend. Each booth page
 * defines window.getBoothExtraData() before calling initBoothRoom() so its
 * own score/answers/etc. rides along on the check-in record. */

let _boothStars = 0;
let _boothIdentity = null;

function currentBoothRoomUrl() {
  return window.location.pathname.split("/").pop() || "./";
}

function initBoothGate({ boothId, boothName, onReady, identity: signedInIdentity }) {
  let identity = signedInIdentity || Identity.peek();
  _boothIdentity = identity;
  const gateEl = document.getElementById("booth-gate");
  const ifaceEl = document.getElementById("booth-interface");
  const phoneInput = document.getElementById("booth-phone-input");
  Phone.bind(phoneInput);

  function showInterface() {
    gateEl.style.display = "none";
    ifaceEl.style.display = "block";
    onReady();
  }

  if (identity.phone || identity.phoneLinked) {
    gateEl.style.display = "none";
    ifaceEl.style.display = "none";
    EventAPI.myCheckins(identity.attendeeId)
      .then(showInterface)
      .catch((error) => {
        console.error(error);
        if (Identity.restartIfMissing(error, currentBoothRoomUrl())) return;
        toast("Couldn't verify your check-in — check the connection and reload.");
      });
    return;
  }

  gateEl.style.display = "block";
  ifaceEl.style.display = "none";
  document.getElementById("btn-booth-checkin").addEventListener("click", async () => {
    const err = document.getElementById("err-booth-phone");
    const digits = Phone.digits(phoneInput);
    err.textContent = "Enter a 10-digit phone number.";
    if (!Phone.isValid(phoneInput)) { err.style.display = "block"; return; }
    err.style.display = "none";

    const btn = document.getElementById("btn-booth-checkin");
    btn.disabled = true; btn.textContent = "Checking in…";
    try {
      const result = await EventAPI.findOrRegisterByPhone(identity.attendeeId, digits, identity.name);
      identity = Identity.set({
        attendeeId: result.attendeeId || identity.attendeeId,
        phone: digits,
        phoneLinked: true,
        name: result.name || identity.name,
        raffleNumber: result.raffleNumber,
      });
      _boothIdentity = identity;
      if (!result.isNew) toast("Checked in! Welcome back, " + (result.name || "friend") + ".");
      else toast("Checked in!");
      showInterface();
    } catch (e) {
      console.error(e);
      if (e.code === "PHONE_ALREADY_LINKED") {
        err.textContent = "That phone is connected on another device. Restart at Entry on this device, then ask staff to pair the new raffle ticket.";
        err.style.display = "block";
      } else if (Identity.restartIfMissing(e, currentBoothRoomUrl())) {
        return;
      } else {
        toast("Couldn't check in — check the connection and try again.");
      }
      btn.disabled = false; btn.textContent = "Check in to this room →";
    }
  });
}

function renderBoothFooter() {
  document.querySelectorAll("#booth-stars .star").forEach((s) => {
    s.addEventListener("click", () => {
      const n = parseInt(s.dataset.n, 10);
      _boothStars = n;
      document.querySelectorAll("#booth-stars .star").forEach((el) => {
        el.classList.toggle("on", parseInt(el.dataset.n, 10) <= n);
      });
    });
  });
}

async function finishBooth(boothId, boothName) {
  // Keep this room tied to the attendee who signed into it. Another booth
  // may be open in a different tab and replace the shared local identity.
  const identity = _boothIdentity || Identity.peek();
  // The timer can cross a session boundary while an attendee is completing
  // the activity, so check access again at the exact moment they tap Finish.
  if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
    toast("This booth session has ended. Return to your schedule for the current stop.");
    if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
    return;
  }
  const note = document.getElementById("booth-note") ? document.getElementById("booth-note").value : "";
  const extraData = typeof window.getBoothExtraData === "function" ? window.getBoothExtraData() : null;

  const btn = document.getElementById("btn-booth-done");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await EventAPI.boothCheckin({
      attendeeId: identity.attendeeId,
      phone: identity.phone,
      boothId,
      boothName,
      checkedInBy: "self",
      rating: _boothStars || null,
      note: note || "",
      extraData,
    });
    toast("Marked complete!");
    if (typeof window.completeBoothRoom === "function") window.completeBoothRoom(boothName);
  } catch (e) {
    console.error(e);
    if (Identity.restartIfMissing(e, currentBoothRoomUrl())) return;
    toast("Couldn't save — check the connection and try again.");
    btn.disabled = false; btn.textContent = "Finish this booth →";
  }
}
