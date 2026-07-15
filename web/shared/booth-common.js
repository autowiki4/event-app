/* Shared behavior for every self-service booth page: the phone-number gate
 * (asked once, reused everywhere after) and the note/star-rating/done
 * footer that logs the visit back to the shared backend. Each booth page
 * defines window.getBoothExtraData() before calling initBoothGate() so its
 * own score/answers/etc. rides along on the check-in record. */

let _boothStars = 0;

function initBoothGate({ boothId, boothName, onReady }) {
  let identity = Identity.get();
  const gateEl = document.getElementById("booth-gate");
  const ifaceEl = document.getElementById("booth-interface");

  function showInterface() {
    gateEl.style.display = "none";
    ifaceEl.style.display = "block";
    onReady();
  }

  if (identity.phone) {
    gateEl.style.display = "none";
    ifaceEl.style.display = "none";
    EventAPI.myCheckins(identity.attendeeId)
      .then(showInterface)
      .catch((error) => {
        console.error(error);
        if (Identity.restartIfMissing(error, "../phase1-entry/index.html")) return;
        toast("Couldn't verify your check-in — check the connection and reload.");
      });
    return;
  }

  gateEl.style.display = "block";
  ifaceEl.style.display = "none";
  document.getElementById("btn-booth-checkin").addEventListener("click", async () => {
    const input = document.getElementById("booth-phone-input");
    const err = document.getElementById("err-booth-phone");
    const digits = input.value.replace(/\D/g, "");
    err.textContent = "Enter your number to check in at this booth.";
    if (digits.length < 10) { err.style.display = "block"; return; }
    err.style.display = "none";

    const btn = document.getElementById("btn-booth-checkin");
    btn.disabled = true; btn.textContent = "Checking in…";
    try {
      const result = await EventAPI.findOrRegisterByPhone(identity.attendeeId, digits, identity.name);
      Identity.set({
        attendeeId: result.attendeeId || identity.attendeeId,
        phone: digits,
        name: result.name || identity.name,
        raffleNumber: result.raffleNumber,
      });
      if (!result.isNew) toast("Checked in! Welcome back, " + (result.name || "friend") + ".");
      else toast("Checked in!");
      showInterface();
    } catch (e) {
      console.error(e);
      if (e.code === "PHONE_ALREADY_LINKED") {
        err.textContent = "That phone is connected on another device. Restart at Entry on this device, then ask staff to pair the new raffle ticket.";
        err.style.display = "block";
      } else if (Identity.restartIfMissing(e, "../phase1-entry/index.html")) {
        return;
      } else {
        toast("Couldn't check in — check the connection and try again.");
      }
      btn.disabled = false; btn.textContent = "Check in at this booth →";
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
  const identity = Identity.get();
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
    window.location.href = "hub.html";
  } catch (e) {
    console.error(e);
    if (Identity.restartIfMissing(e, "../phase1-entry/index.html")) return;
    toast("Couldn't save — check the connection and try again.");
    btn.disabled = false; btn.textContent = "Done — back to Gym →";
  }
}
