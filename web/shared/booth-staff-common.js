/* Shared behavior for the five booth-specific staff portals. The backend
 * response is already scoped to one booth, so these pages never download
 * the overall organizer dashboard or Phase 3 attendee data. */
function initBoothStaff(boothId) {
  const booth = CONNECTOR_BOOTHS.find((item) => item.id === boothId);
  if (!booth) {
    document.getElementById("staff-booth-name").textContent = "Unknown booth";
    document.getElementById("organizer-access").style.display = "none";
    return;
  }

  document.title = `${booth.title} — Booth Staff`;
  document.getElementById("staff-booth-name").textContent = booth.title;
  document.getElementById("staff-booth-description").textContent = booth.blurb;
  document.getElementById("staff-booth-mode").textContent = booth.mode === "kiosk"
    ? "Staff-guided booth dashboard"
    : "Self-service booth dashboard";

  const roomLaunch = document.getElementById("staff-room-launch");
  roomLaunch.innerHTML = `<a class="btn btn-primary" href="../phase2-booths/${escapeHtml(booth.page)}">Open attendee booth room →</a>`;

  const kioskLaunch = document.getElementById("staff-kiosk-launch");
  if (booth.kioskPage) {
    kioskLaunch.innerHTML = `<div style="margin-top:10px;"><a class="btn btn-ghost" href="${escapeHtml(booth.kioskPage)}">Open optional staff kiosk →</a></div>`;
  } else {
    kioskLaunch.innerHTML = "";
  }
  document.getElementById("staff-settings").textContent = `Only ${booth.title} settings will appear here. Controls will be added after this booth's rules are defined.`;

  let refreshTimer = null;

  function clearBoothData() {
    document.getElementById("staff-total").textContent = "0";
    document.getElementById("staff-last-updated").textContent = "";
    document.querySelector("#staff-roster tbody").innerHTML = "";
  }

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  async function refresh() {
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!organizerKey) return false;
    try {
      const data = await EventAPI.boothDashboardData(booth.id, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return false;
      document.getElementById("staff-total").textContent = data.totalCheckins;
      document.getElementById("staff-last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      const body = document.querySelector("#staff-roster tbody");
      body.innerHTML = data.recentCheckins.length
        ? data.recentCheckins.map((checkin) => `
            <tr>
              <td>${escapeHtml(checkin.name)}</td>
              <td>${escapeHtml(formatTime(checkin.checkedInAt))}</td>
              <td>${escapeHtml(checkin.checkedInBy || "self")}</td>
              <td>${checkin.rating ? `${Number(checkin.rating)}/5` : "—"}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="4" style="color:var(--ink-soft);">No check-ins at this booth yet.</td></tr>`;
      return true;
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return false;
      toast("Couldn't load this booth — check the connection and try again.");
      return false;
    }
  }

  document.getElementById("btn-staff-refresh").addEventListener("click", refresh);

  OrganizerAuth.init({
    onUnlocked: async () => {
      const refreshed = await refresh();
      if (refreshed && OrganizerAuth.key() && !refreshTimer) refreshTimer = setInterval(refresh, 5000);
    },
    onLocked: () => {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      clearBoothData();
    },
  });
}
