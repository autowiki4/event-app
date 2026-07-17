/* Shared behavior for attendee booth rooms. Registration happens once at
 * Phase 1, so a timed booth only restores the signed-in attendee and opens
 * its activity. Each booth page can define window.getBoothExtraData() so its
 * activity-specific result rides along on the completion record. */

let _boothIdentity = null;
window.getCurrentBoothIdentity = () => _boothIdentity || Identity.peek();

function currentBoothRoomUrl() {
  return window.location.pathname.split("/").pop() || "./";
}

function initBoothGate({ boothId, boothName, onReady, identity: signedInIdentity }) {
  const identity = signedInIdentity || Identity.peek();
  _boothIdentity = identity;
  const gateEl = document.getElementById("booth-gate");
  const ifaceEl = document.getElementById("booth-interface");

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
    onReady();
  }

  ifaceEl.style.display = "none";
  gateEl.style.display = "block";
  EventAPI.myCheckins(identity.attendeeId)
    .then(showInterface)
    .catch((error) => {
      console.error(error);
      Identity.restartIfMissing(error, currentBoothRoomUrl());
      toast("You're still signed in. Live saving is reconnecting.");
      showInterface();
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
  const extraData = typeof window.getBoothExtraData === "function" ? window.getBoothExtraData() : null;
  const completion = {
    attendeeId: identity.attendeeId,
    phone: identity.phone,
    boothId,
    boothName,
    checkedInBy: "self",
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
