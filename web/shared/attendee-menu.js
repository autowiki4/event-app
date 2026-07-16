/* Explicit attendee account menu. Identity stays on this device across
 * refreshes and browser restarts until the guest chooses Log out here. */
const AttendeeMenu = (() => {
  const mountedRoots = new Set();
  let globalListenersBound = false;

  function closeAll(except) {
    mountedRoots.forEach((root) => {
      if (root === except) return;
      root.classList.remove("open");
      const trigger = root.querySelector(".attendee-menu-trigger");
      const panel = root.querySelector(".attendee-menu-panel");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (panel) panel.hidden = true;
    });
  }

  function bindGlobalListeners() {
    if (globalListenersBound) return;
    globalListenersBound = true;
    document.addEventListener("click", (event) => {
      mountedRoots.forEach((root) => {
        if (!root.contains(event.target)) closeAll();
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAll();
    });
  }

  function logout(logoutUrl) {
    if (typeof AttendeePortal !== "undefined" && AttendeePortal.signOut) {
      AttendeePortal.signOut(logoutUrl);
      return;
    }
    Identity.clear();
    window.location.href = logoutUrl;
  }

  function mount(target, options) {
    const root = typeof target === "string" ? document.getElementById(target) : target;
    const identity = options && options.identity ? options.identity : Identity.peek();
    if (!root || !identity || !identity.attendeeId) return null;
    const displayName = String(identity.name || "Guest");
    const raffleNumber = String(identity.raffleNumber || "----");
    const logoutUrl = options && options.logoutUrl ? options.logoutUrl : "../phase1-entry/index.html";

    root.className = "attendee-menu";
    root.innerHTML = `
      <button type="button" class="attendee-menu-trigger" aria-haspopup="menu" aria-expanded="false">
        <span class="attendee-menu-name"></span><span aria-hidden="true">▾</span>
      </button>
      <div class="attendee-menu-panel" role="menu" hidden>
        <strong class="attendee-menu-full-name"></strong>
        <span class="attendee-menu-raffle"></span>
        <button type="button" class="attendee-menu-logout" role="menuitem">Log out on this device</button>
      </div>`;
    root.querySelector(".attendee-menu-name").textContent = displayName;
    root.querySelector(".attendee-menu-full-name").textContent = displayName;
    root.querySelector(".attendee-menu-raffle").textContent = `Raffle #${raffleNumber}`;
    const trigger = root.querySelector(".attendee-menu-trigger");
    const panel = root.querySelector(".attendee-menu-panel");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = !root.classList.contains("open");
      closeAll(root);
      root.classList.toggle("open", opening);
      trigger.setAttribute("aria-expanded", String(opening));
      panel.hidden = !opening;
    });
    root.querySelector(".attendee-menu-logout").addEventListener("click", () => logout(logoutUrl));
    mountedRoots.add(root);
    bindGlobalListeners();
    return root;
  }

  return { mount, closeAll, logout };
})();
