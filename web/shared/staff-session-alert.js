/* Shared session warning for every booth-leader portal. The event clock is
 * authoritative; this view only translates its live countdown into the
 * 20-, 10-, 5-minute and final-15-second operational cues. */
const StaffSessionAlert = (() => {
  let timer = null;
  let root = null;

  function render() {
    if (!root || typeof EventSchedule === "undefined") return;
    const snapshot = EventSchedule.current();
    const notice = typeof EventSchedule.sessionTimeNotice === "function"
      ? EventSchedule.sessionTimeNotice(snapshot)
      : null;
    if (!notice) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.className = `staff-rotation-alert ${notice.level}`;
    root.querySelector("strong").textContent = notice.title;
    root.querySelector("span").textContent = `Session ${snapshot.session.number} · shared event clock`;
    root.querySelector("p").textContent = notice.message;
  }

  function init() {
    if (root) return root;
    const settings = document.getElementById("staff-settings");
    if (!settings) return null;
    root = document.createElement("section");
    root.id = "staff-rotation-alert";
    root.className = "staff-rotation-alert";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.innerHTML = "<span></span><strong></strong><p></p>";
    settings.insertBefore(root, settings.firstChild);
    render();
    timer = window.setInterval(render, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) render();
    });
    return root;
  }

  return { init, render };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => StaffSessionAlert.init(), { once: true });
} else {
  StaffSessionAlert.init();
}
