/* Shared behavior for every attendee booth room: the phone-number gate
 * (asked once, reused everywhere after) and the note/star-rating/done
 * footer that logs the visit back to the shared backend. Each booth page
 * defines window.getBoothExtraData() before calling initBoothRoom() so its
 * own score/answers/etc. rides along on the check-in record. */

let _boothStars = 0;
let _boothIdentity = null;
let _boothFooterId = "";
let _boothFooterRestoredFor = "";
window.getCurrentBoothIdentity = () => _boothIdentity || Identity.peek();

function boothFooterDraftScope(boothId) {
  return `booth.${boothId}.footer`;
}

function paintBoothStars() {
  document.querySelectorAll("#booth-stars .star").forEach((star) => {
    star.classList.toggle("on", parseInt(star.dataset.n, 10) <= _boothStars);
  });
}

function saveBoothFooterDraft(boothId = _boothFooterId) {
  if (!boothId || typeof JourneyState === "undefined") return false;
  const note = document.getElementById("booth-note");
  return JourneyState.save(boothFooterDraftScope(boothId), {
    note: note ? note.value : "",
    rating: _boothStars,
  });
}

function restoreBoothFooterDraft(boothId = _boothFooterId) {
  if (!boothId || typeof JourneyState === "undefined") return false;
  const identity = _boothIdentity || Identity.peek();
  const attendeeId = String((identity && identity.attendeeId) || "");
  if (!attendeeId || _boothFooterRestoredFor === attendeeId) return false;
  const saved = JourneyState.load(boothFooterDraftScope(boothId), { note: "", rating: 0 }) || {};
  const note = document.getElementById("booth-note");
  if (note) note.value = typeof saved.note === "string" ? saved.note : "";
  const rating = Number(saved.rating);
  _boothStars = Number.isInteger(rating) ? Math.min(5, Math.max(0, rating)) : 0;
  paintBoothStars();
  _boothFooterRestoredFor = attendeeId;
  return true;
}

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

  function handlePendingResult(result) {
    if (!(result.completedBoothIds || []).includes(boothId)) return;
    toast("Your booth completion finished saving.");
    if (typeof window.completeBoothRoom === "function") window.completeBoothRoom(boothName);
  }

  if (typeof PendingCheckins !== "undefined") {
    PendingCheckins.retry(identity.attendeeId, handlePendingResult);
  }

  function showInterface() {
    gateEl.style.display = "none";
    ifaceEl.style.display = "block";
    restoreBoothFooterDraft(boothId);
    onReady();
  }

  if (identity.phone || identity.phoneLinked || identity.phoneSkipped) {
    gateEl.style.display = "none";
    ifaceEl.style.display = "none";
    EventAPI.myCheckins(identity.attendeeId)
      .then(showInterface)
      .catch((error) => {
        console.error(error);
        Identity.restartIfMissing(error, currentBoothRoomUrl());
        toast("You're still signed in. Live saving is reconnecting.");
        showInterface();
      });
    return;
  }

  gateEl.style.display = "block";
  ifaceEl.style.display = "none";
  const checkinButton = document.getElementById("btn-booth-checkin");
  let skipButton = document.getElementById("btn-booth-skip-phone");
  if (!skipButton) {
    skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.id = "btn-booth-skip-phone";
    skipButton.className = "btn btn-ghost";
    skipButton.style.marginTop = "10px";
    skipButton.textContent = "I don't have my own number — use my raffle entry";
    checkinButton.insertAdjacentElement("afterend", skipButton);
  }
  skipButton.addEventListener("click", () => {
    identity = Identity.set({ phoneSkipped: true });
    _boothIdentity = identity;
    toast("Continuing with your name and raffle number.");
    showInterface();
  });
  checkinButton.addEventListener("click", async () => {
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
        phoneSkipped: false,
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
  phoneInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Return") return;
    if (event.isComposing || event.repeat) return;
    event.preventDefault();
    if (checkinButton.disabled) return;
    checkinButton.click();
  });
}

function renderBoothFooter(boothId) {
  _boothFooterId = boothId || _boothFooterId;
  const note = document.getElementById("booth-note");
  if (note) note.addEventListener("input", () => saveBoothFooterDraft());
  document.querySelectorAll("#booth-stars .star").forEach((s) => {
    s.addEventListener("click", () => {
      const n = parseInt(s.dataset.n, 10);
      _boothStars = n;
      paintBoothStars();
      saveBoothFooterDraft();
    });
  });
  restoreBoothFooterDraft();
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
  saveBoothFooterDraft(boothId);
  const extraData = typeof window.getBoothExtraData === "function" ? window.getBoothExtraData() : null;
  const completion = {
    attendeeId: identity.attendeeId,
    phone: identity.phone,
    boothId,
    boothName,
    checkedInBy: "self",
    rating: _boothStars || null,
    note: note || "",
    extraData,
  };

  const btn = document.getElementById("btn-booth-done");
  btn.disabled = true; btn.textContent = "Saving…";
  const pendingQueueId = typeof PendingCheckins !== "undefined" ? PendingCheckins.stage(completion) : null;
  try {
    await EventAPI.boothCheckin(completion);
    if (typeof PendingCheckins !== "undefined") PendingCheckins.remove(completion, pendingQueueId);
    toast("Marked complete!");
    if (typeof window.completeBoothRoom === "function") window.completeBoothRoom(boothName);
  } catch (e) {
    console.error(e);
    if (Identity.restartIfMissing(e, currentBoothRoomUrl())) return;
    toast("Couldn't save — check the connection and try again.");
    btn.disabled = false; btn.textContent = "Finish this booth →";
    if (typeof PendingCheckins !== "undefined") {
      PendingCheckins.retry(identity.attendeeId, (result) => {
        if ((result.completedBoothIds || []).includes(boothId)) {
          toast("Your booth completion finished saving.");
          if (typeof window.completeBoothRoom === "function") window.completeBoothRoom(boothName);
        }
      });
    }
  }
}
