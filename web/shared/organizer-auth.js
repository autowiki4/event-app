/* Staff-only pages ask for their portal-specific password at runtime. The key
 * stays only in this page's JavaScript memory: it is never put in web storage,
 * the static site bundle, or a URL. The non-secret scope only identifies which
 * portal is being opened; every protected backend action independently enforces
 * that same role so changing browser code cannot grant access. */
const OrganizerAuth = (function () {
  const validScopes = new Set(["overall", "heaven", "trivia", "story", "art", "newsong"]);
  let memoryKey = "";
  let staffScope = "overall";
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
      el.error.textContent = message || "Enter this portal's staff password.";
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
      showGate("Enter this portal's staff password.");
      return;
    }
    const attemptGeneration = ++authGeneration;
    if (el.button) {
      el.button.disabled = true;
      el.button.textContent = "Checking…";
    }
    try {
      await EventAPI.verifyOrganizer(value, staffScope);
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
      } else if (["STAFF_KEY_NOT_CONFIGURED", "ORGANIZER_KEY_NOT_CONFIGURED"].includes(e.code)) {
        showGate("This portal's staff password has not been configured on the backend.");
      } else if (e.code === "STAFF_KEY_CONFIGURATION_INVALID") {
        showGate("This portal needs a unique password before it can be unlocked.");
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
    const requestedScope = String((options && options.scope) || "overall").trim().toLowerCase();
    if (!validScopes.has(requestedScope)) throw new Error("Choose a valid staff portal scope.");
    staffScope = requestedScope;
    const el = elements();
    if (!el.gate || !el.content || !el.input || !el.button) {
      throw new Error("Organizer access gate is incomplete.");
    }
    el.button.addEventListener("click", () => verifyAndUnlock(el.input.value));
    el.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Return") return;
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      if (el.button.disabled) return;
      // Use the same action as a tap so keyboard and pointer submissions can
      // never drift into separate unlock behavior.
      el.button.click();
    });
    if (el.lockButton) el.lockButton.addEventListener("click", () => lock());

    showGate("");
  }

  function handleError(error, expectedGeneration) {
    // A response from a page that was locked (and perhaps unlocked again)
    // must never invalidate the newer staff session.
    if (expectedGeneration !== undefined && expectedGeneration !== authGeneration) return true;
    if (!error || ![
      "AUTH_REQUIRED",
      "STAFF_KEY_NOT_CONFIGURED",
      "ORGANIZER_KEY_NOT_CONFIGURED",
      "STAFF_KEY_CONFIGURATION_INVALID",
    ].includes(error.code)) return false;
    const message = ["STAFF_KEY_NOT_CONFIGURED", "ORGANIZER_KEY_NOT_CONFIGURED"].includes(error.code)
      ? "This portal's staff password has not been configured on the backend."
      : error.code === "STAFF_KEY_CONFIGURATION_INVALID"
        ? "This portal needs a unique password before it can be unlocked."
        : "Staff access expired or was rejected. Unlock again.";
    lock(message);
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
