/* Staff-only pages ask for an event-long organizer key at runtime. The key
 * stays only in this page's JavaScript memory: it is never put in web storage,
 * the static site bundle, or a URL. The backend is still the authority: this
 * gate only reveals the UI after verifyOrganizer accepts the key. */
const OrganizerAuth = (function () {
  let memoryKey = "";
  let authGeneration = 0;
  let onUnlocked = null;
  let onLocked = null;

  function storedKey() {
    return memoryKey;
  }

  function saveKey(value) {
    memoryKey = value;
  }

  function clearKey() {
    memoryKey = "";
  }

  function elements() {
    return {
      gate: document.getElementById("organizer-access"),
      content: document.getElementById("organizer-content"),
      input: document.getElementById("organizer-key"),
      button: document.getElementById("btn-organizer-unlock"),
      error: document.getElementById("err-organizer-key"),
      lockButton: document.getElementById("btn-organizer-lock"),
    };
  }

  function showGate(message) {
    const el = elements();
    if (el.gate) el.gate.style.display = "block";
    if (el.content) el.content.style.display = "none";
    if (el.error) {
      el.error.textContent = message || "Enter the organizer access key.";
      el.error.style.display = message ? "block" : "none";
    }
    if (el.input) {
      el.input.value = "";
      el.input.focus();
    }
  }

  function showContent() {
    const el = elements();
    if (el.gate) el.gate.style.display = "none";
    if (el.content) el.content.style.display = "block";
    if (el.error) el.error.style.display = "none";
  }

  function lock(message) {
    authGeneration += 1;
    clearKey();
    showGate(message || "Organizer access is locked.");
    const el = elements();
    if (el.button) {
      el.button.disabled = false;
      el.button.textContent = "Unlock staff view →";
    }
    if (onLocked) onLocked();
  }

  async function verifyAndUnlock(candidate) {
    const el = elements();
    const value = String(candidate || "").trim();
    if (!value) {
      showGate("Enter the organizer access key.");
      return;
    }
    const attemptGeneration = ++authGeneration;
    if (el.button) {
      el.button.disabled = true;
      el.button.textContent = "Checking…";
    }
    try {
      await EventAPI.verifyOrganizer(value);
      if (attemptGeneration !== authGeneration) return;
      saveKey(value);
      showContent();
      if (onUnlocked) await onUnlocked();
    } catch (e) {
      if (attemptGeneration !== authGeneration) return;
      console.error(e);
      clearKey();
      if (e.code === "AUTH_REQUIRED") {
        showGate("Access key not recognized. Try again.");
      } else if (e.code === "ORGANIZER_KEY_NOT_CONFIGURED") {
        showGate("Organizer access has not been configured on the backend.");
      } else {
        showGate("Couldn't verify access — check the connection and try again.");
      }
    } finally {
      if (el.button && attemptGeneration === authGeneration) {
        el.button.disabled = false;
        el.button.textContent = "Unlock staff view →";
      }
    }
  }

  function init(options) {
    onUnlocked = options && options.onUnlocked;
    onLocked = options && options.onLocked;
    const el = elements();
    if (!el.gate || !el.content || !el.input || !el.button) {
      throw new Error("Organizer access gate is incomplete.");
    }
    el.button.addEventListener("click", () => verifyAndUnlock(el.input.value));
    el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") verifyAndUnlock(el.input.value);
    });
    if (el.lockButton) el.lockButton.addEventListener("click", () => lock());

    showGate("");
  }

  function handleError(error, expectedGeneration) {
    // A response from a page that was locked (and perhaps unlocked again)
    // must never invalidate the newer staff session.
    if (expectedGeneration !== undefined && expectedGeneration !== authGeneration) return true;
    if (!error || (error.code !== "AUTH_REQUIRED" && error.code !== "ORGANIZER_KEY_NOT_CONFIGURED")) return false;
    lock(error.code === "ORGANIZER_KEY_NOT_CONFIGURED"
      ? "Organizer access has not been configured on the backend."
      : "Organizer access expired or was rejected. Unlock again.");
    return true;
  }

  function generation() {
    return authGeneration;
  }

  function isCurrent(value) {
    return !!memoryKey && value === authGeneration;
  }

  return { init, key: storedKey, lock, handleError, generation, isCurrent };
})();
