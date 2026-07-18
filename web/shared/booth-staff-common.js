/* Shared behavior for the five booth-leader portals. Each page is scoped to
 * one booth: leaders can publish the step/status/message shown to attendees,
 * and can see only that booth's check-ins. */
function initBoothStaff(boothId) {
  const booth = CONNECTOR_BOOTHS.find((item) => item.id === boothId);
  if (!booth) {
    document.getElementById("staff-booth-name").textContent = "Unknown booth";
    document.getElementById("organizer-access").style.display = "none";
    return;
  }

  const statusOptions = [
    { value: "waiting", label: "Waiting", help: "Ask the next group to wait for the leader." },
    { value: "live", label: "Live", help: "Show the selected activity step." },
    { value: "paused", label: "Paused", help: "Hold the group on the current step." },
    { value: "wrap", label: "Wrap up", help: "Tell the group this booth is nearly finished." },
    { value: "complete", label: "Closed", help: "Mark this booth session complete." },
  ];
  const statusValues = statusOptions.map((option) => option.value);
  const steps = (Array.isArray(booth.leaderSteps) && booth.leaderSteps.length
    ? booth.leaderSteps
    : [{ title: "Welcome", text: `Welcome the group to ${booth.title}.` }])
    .map((step, index) => ({
      title: String((step && (step.title || step.label || step.name)) || `Step ${index + 1}`),
      text: String((step && (step.body || step.text || step.description || step.attendeeText || step.prompt)) || ""),
    }));

  let refreshTimer = null;
  let scheduleTimer = null;
  let refreshInFlight = false;
  let saving = false;
  let dirty = false;
  let presentationEpoch = 0;
  let published = normalizePresentation(null);
  let draft = { ...published };
  let demoClockSyncStarted = false;

  document.title = `${booth.title} — Booth Leader`;
  document.getElementById("staff-booth-name").textContent = booth.title;
  document.getElementById("staff-booth-description").textContent = booth.blurb;
  document.getElementById("staff-booth-mode").textContent = "Booth leader portal";

  const roomLaunch = document.getElementById("staff-room-launch");
  roomLaunch.innerHTML = `<a class="btn btn-primary" href="../phase2-booths/hub.html" target="_blank" rel="noopener">Open attendee experience in a new tab →</a>`;

  const kioskLaunch = document.getElementById("staff-kiosk-launch");
  if (booth.kioskPage) {
    kioskLaunch.innerHTML = `<div style="margin-top:10px;"><a class="btn btn-ghost" href="${escapeHtml(booth.kioskPage)}" target="_blank" rel="noopener">Open optional booth kiosk →</a></div>`;
  } else {
    kioskLaunch.innerHTML = "";
  }

  renderControlShell();

  function normalizePresentation(value) {
    const raw = value && typeof value === "object" ? value : {};
    const parsedStep = Number(raw.stepIndex);
    const stepIndex = Number.isFinite(parsedStep)
      ? Math.max(0, Math.min(steps.length - 1, Math.trunc(parsedStep)))
      : 0;
    return {
      boothId: booth.id,
      status: statusValues.includes(raw.status) ? raw.status : "waiting",
      stepIndex,
      message: String(raw.message || "").slice(0, 140),
      updatedAt: raw.updatedAt || "",
      version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 0,
    };
  }

  function renderControlShell() {
    const controls = document.getElementById("staff-settings");
    controls.innerHTML = `
      <div class="dash-card" aria-live="polite" style="margin-bottom:14px;">
        <div class="lbl">Current rotation</div>
        <div id="staff-session-label" style="font-family:'Fraunces',serif;font-size:20px;font-weight:600;color:var(--ink);margin-top:5px;">Checking schedule…</div>
        <div id="staff-current-group" style="font-size:13px;color:var(--ink-soft);margin-top:5px;"></div>
        <div id="staff-session-timer" style="font-family:'JetBrains Mono',monospace;font-size:24px;font-weight:700;color:var(--coral);margin-top:9px;"></div>
      </div>

      <div class="dash-card">
        <div class="lbl">Attendee screen status</div>
        <div id="staff-status-options" role="radiogroup" aria-label="Attendee screen status" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
          ${statusOptions.map((option) => `
            <button type="button" class="btn btn-small btn-ghost" role="radio" aria-checked="false" data-status="${option.value}" title="${escapeHtml(option.help)}">${escapeHtml(option.label)}</button>
          `).join("")}
        </div>
        <p id="staff-status-help" style="font-size:12px;line-height:1.45;color:var(--ink-soft);margin:10px 0 0;"></p>

        <div class="section-title" style="margin-top:22px;">Step shown to attendees</div>
        <div class="booth-list" id="staff-step-list" role="radiogroup" aria-label="Booth activity step" style="margin-top:10px;">
          ${steps.map((step, index) => `
            <button type="button" class="booth-card" role="radio" aria-checked="false" data-step-index="${index}" style="width:100%;text-align:left;cursor:pointer;font-family:inherit;">
              <span class="booth-icon" aria-hidden="true">${index + 1}</span>
              <span class="booth-info">
                <span class="name" style="display:block;">${escapeHtml(step.title)}</span>
                ${step.text ? `<span class="hint" style="display:block;">${escapeHtml(step.text)}</span>` : ""}
              </span>
              <span class="stamp-btn disabled" data-step-marker>Choose</span>
            </button>
          `).join("")}
        </div>
        <div style="display:flex;gap:10px;margin-bottom:20px;">
          <button type="button" class="btn btn-small btn-ghost" id="btn-staff-previous" style="flex:1;">← Publish previous</button>
          <button type="button" class="btn btn-small btn-primary" id="btn-staff-next" style="flex:1;">Publish next →</button>
        </div>

        <div class="field">
          <label for="staff-message">Short announcement (optional)</label>
          <textarea id="staff-message" rows="3" maxlength="140" placeholder="Example: Please bring your worksheet to the front table."></textarea>
          <div class="hint"><span id="staff-message-count">0</span>/140 characters. This message appears on the attendee screen.</div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <button type="button" class="btn btn-small btn-ghost" id="btn-staff-reset">Reset controls</button>
          <button type="button" class="btn btn-small btn-primary" id="btn-staff-save" style="flex:1;min-width:160px;">Save to attendee screen</button>
        </div>
        <p id="staff-publish-state" role="status" style="font-size:12px;line-height:1.45;color:var(--ink-soft);margin:11px 0 0;">Loading published controls…</p>
      </div>
    `;

    controls.querySelectorAll("[data-status]").forEach((button) => {
      button.addEventListener("click", () => {
        draft.status = button.dataset.status;
        markDirty();
        syncControlUi();
      });
    });
    controls.querySelectorAll("[data-step-index]").forEach((button) => {
      button.addEventListener("click", () => {
        draft.stepIndex = Number(button.dataset.stepIndex);
        markDirty();
        syncControlUi();
      });
    });
    document.getElementById("btn-staff-previous").addEventListener("click", () => changeStep(-1, true));
    document.getElementById("btn-staff-next").addEventListener("click", () => changeStep(1, true));
    document.getElementById("btn-staff-reset").addEventListener("click", resetDraft);
    document.getElementById("btn-staff-save").addEventListener("click", savePresentation);
    document.getElementById("staff-message").addEventListener("input", (event) => {
      draft.message = event.target.value.slice(0, 140);
      document.getElementById("staff-message-count").textContent = String(draft.message.length);
      markDirty();
      syncControlUi();
    });
    syncControlUi(true);
  }

  function changeStep(delta, publishNow) {
    const nextIndex = Math.max(0, Math.min(steps.length - 1, draft.stepIndex + delta));
    if (nextIndex === draft.stepIndex) return;
    draft.stepIndex = nextIndex;
    if (publishNow) {
      draft.status = nextIndex >= steps.length - 1 ? "complete" : "live";
    }
    markDirty();
    syncControlUi();
    const selected = document.querySelector(`[data-step-index="${nextIndex}"]`);
    if (selected) selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (publishNow) savePresentation();
  }

  function resetDraft() {
    draft = normalizePresentation({ status: "waiting", stepIndex: 0, message: "", version: published.version });
    markDirty();
    syncControlUi(true);
    toast("Controls reset. Choose Save to publish.");
  }

  function markDirty() {
    dirty = true;
    const state = document.getElementById("staff-publish-state");
    if (state) state.textContent = "Unsaved changes — choose Save to update attendee screens.";
  }

  function syncControlUi(syncMessage) {
    document.querySelectorAll("[data-status]").forEach((button) => {
      const selected = button.dataset.status === draft.status;
      button.setAttribute("aria-checked", String(selected));
      button.className = selected ? "btn btn-small btn-primary" : "btn btn-small btn-ghost";
      button.disabled = saving;
      button.style.opacity = saving ? ".55" : "1";
    });
    const activeStatus = statusOptions.find((option) => option.value === draft.status);
    document.getElementById("staff-status-help").textContent = activeStatus ? activeStatus.help : "";

    document.querySelectorAll("[data-step-index]").forEach((button) => {
      const selected = Number(button.dataset.stepIndex) === draft.stepIndex;
      button.setAttribute("aria-checked", String(selected));
      button.classList.toggle("visited", selected);
      button.disabled = saving;
      button.style.opacity = saving ? ".55" : "1";
      const marker = button.querySelector("[data-step-marker]");
      marker.textContent = selected ? "Selected" : "Choose";
      marker.className = selected ? "stamp-btn done" : "stamp-btn disabled";
    });
    const previousButton = document.getElementById("btn-staff-previous");
    const nextButton = document.getElementById("btn-staff-next");
    previousButton.disabled = saving || draft.stepIndex <= 0;
    nextButton.disabled = saving || draft.stepIndex >= steps.length - 1;
    previousButton.style.opacity = previousButton.disabled ? ".45" : "1";
    nextButton.style.opacity = nextButton.disabled ? ".45" : "1";

    if (syncMessage) document.getElementById("staff-message").value = draft.message;
    document.getElementById("staff-message").disabled = saving;
    const resetButton = document.getElementById("btn-staff-reset");
    resetButton.disabled = saving;
    resetButton.style.opacity = saving ? ".55" : "1";
    document.getElementById("staff-message-count").textContent = String(draft.message.length);
    document.getElementById("btn-staff-save").disabled = saving || !dirty;
  }

  function formatPublishedAt(value) {
    if (!value) return "Published controls loaded.";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Published controls loaded.";
    return `Published ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  }

  async function savePresentation() {
    if (saving || !dirty) return;
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!organizerKey) return;

    saving = true;
    presentationEpoch += 1;
    syncControlUi();
    const saveButton = document.getElementById("btn-staff-save");
    saveButton.textContent = "Saving…";
    const state = document.getElementById("staff-publish-state");
    state.textContent = "Publishing changes…";
    try {
      const result = await EventAPI.updateBoothPresentation({
        boothId: booth.id,
        organizerKey,
        status: draft.status,
        stepIndex: draft.stepIndex,
        message: draft.message.trim(),
        version: published.version,
      });
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      published = normalizePresentation(result.presentation || result);
      draft = { ...published };
      dirty = false;
      syncControlUi(true);
      state.textContent = `${formatPublishedAt(published.updatedAt)} Attendee screens will refresh automatically.`;
      toast("Attendee screen updated.");
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      state.textContent = error && error.code === "PRESENTATION_CONFLICT"
        ? "Another booth leader updated this screen. Refresh before saving again."
        : "Couldn't publish the controls. Your changes are still here; try again.";
      toast("Couldn't update the attendee screen.");
    } finally {
      if (OrganizerAuth.isCurrent(authGeneration)) {
        saving = false;
        saveButton.textContent = "Save to attendee screen";
        syncControlUi();
      }
    }
  }

  function clearBoothData() {
    saving = false;
    refreshInFlight = false;
    presentationEpoch += 1;
    document.getElementById("staff-total").textContent = "0";
    document.getElementById("staff-last-updated").textContent = "";
    document.querySelector("#staff-roster tbody").innerHTML = "";
    const songVoteBody = document.querySelector("#staff-song-vote-table tbody");
    if (songVoteBody) songVoteBody.innerHTML = "";
    dirty = false;
    published = normalizePresentation(null);
    draft = { ...published };
    document.getElementById("btn-staff-save").textContent = "Save to attendee screen";
    syncControlUi(true);
    document.getElementById("staff-publish-state").textContent = "Unlock this booth to load published controls.";
  }

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function colorLabel(group) {
    if (!group) return "No wristband group is assigned right now.";
    const raw = group.label || group.name || group.color || group.id || group.key || group;
    const value = String(raw);
    return /wristband/i.test(value) ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)} wristbands`;
  }

  function refreshSchedule() {
    const label = document.getElementById("staff-session-label");
    const group = document.getElementById("staff-current-group");
    const timer = document.getElementById("staff-session-timer");
    if (!label || !group || !timer) return;
    if (typeof EventSchedule === "undefined" || typeof EventSchedule.current !== "function") {
      label.textContent = "Booth sessions: 3:10–3:50 PM";
      group.textContent = "The shared event timer is unavailable on this device.";
      timer.textContent = "";
      return;
    }

    const current = EventSchedule.current();
    if (current.phase === "active" && current.session) {
      label.textContent = `Session ${current.session.number} · ${current.session.label}`;
      const assigned = typeof EventSchedule.groupForBooth === "function"
        ? EventSchedule.groupForBooth(booth.id, current.sessionIndex)
        : null;
      group.textContent = `${colorLabel(assigned)} are scheduled at this booth.`;
      timer.textContent = `${EventSchedule.formatCountdown(current.remainingMs)} remaining`;
      return;
    }

    if (current.phase === "before") {
      const firstGroup = typeof EventSchedule.groupForBooth === "function"
        ? EventSchedule.groupForBooth(booth.id, 0)
        : null;
      label.textContent = "Sessions have not started";
      group.textContent = `${colorLabel(firstGroup)} begin at this booth in Session 1.`;
      timer.textContent = `${EventSchedule.formatCountdown(current.remainingMs)} until Session 1`;
      return;
    }

    label.textContent = current.phase === "waiting" ? "Booth rotations finished" : "Main message time";
    group.textContent = current.phase === "waiting"
      ? "Both 20-minute sessions are complete. The main message starts at 4:00 PM."
      : "The main message is starting now.";
    timer.textContent = "Closed";
  }

  async function startSharedDemoClock() {
    const demoBackend = window.EVENT_APP_CONFIG
      && String(window.EVENT_APP_CONFIG.API_BASE_URL || "").replace(/\/$/, "") === "/api";
    if (!demoBackend || demoClockSyncStarted || typeof EventSchedule === "undefined"
      || typeof EventSchedule.startDemoClockSync !== "function") return;
    demoClockSyncStarted = true;
    try {
      await EventSchedule.startDemoClockSync(5000);
    } catch (error) {
      console.warn("Demo clock sync unavailable", error);
    }
  }

  async function refresh(options) {
    if (refreshInFlight || saving) return false;
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!organizerKey) return false;
    refreshInFlight = true;
    const expectedPresentationEpoch = presentationEpoch;
    const requestStart = Date.now();
    try {
      const data = await EventAPI.boothDashboardData(booth.id, organizerKey);
      const received = Date.now();
      if (!OrganizerAuth.isCurrent(authGeneration)) return false;
      if (data.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(data.serverNow, requestStart, received);
      }
      document.getElementById("staff-total").textContent = String(data.totalCheckins || 0);
      document.getElementById("staff-last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      const body = document.querySelector("#staff-roster tbody");
      const checkins = Array.isArray(data.recentCheckins) ? data.recentCheckins : [];
      body.innerHTML = checkins.length
        ? checkins.map((checkin) => `
            <tr>
              <td>${escapeHtml(checkin.name)}</td>
              <td>${escapeHtml(formatTime(checkin.checkedInAt))}</td>
              <td>${escapeHtml(checkin.checkedInBy || "self")}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="3" style="color:var(--ink-soft);">No check-ins at this booth yet.</td></tr>`;

      const songVoteBody = document.querySelector("#staff-song-vote-table tbody");
      if (songVoteBody) {
        const songVotes = Array.isArray(data.songVotes) ? data.songVotes : [];
        songVoteBody.innerHTML = songVotes.length
          ? songVotes.map((entry) => `
              <tr>
                <td>${escapeHtml(entry.title)}</td>
                <td>${Number(entry.votes) || 0}</td>
              </tr>
            `).join("")
          : `<tr><td colspan="2" style="color:var(--ink-soft);">No votes yet.</td></tr>`;
      }

      if (!dirty && expectedPresentationEpoch === presentationEpoch) {
        published = normalizePresentation(data.presentation);
        const schedule = typeof EventSchedule !== "undefined" && EventSchedule.current
          ? EventSchedule.current()
          : null;
        const isLocalPreview = typeof EventSchedule !== "undefined" && typeof EventSchedule.isPreviewing === "function"
          ? EventSchedule.isPreviewing()
          : ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
            && new URLSearchParams(window.location.search).has("preview");
        const publishedMs = published.updatedAt ? new Date(published.updatedAt).getTime() : NaN;
        const belongsToPriorSession = !isLocalPreview
          && schedule
          && schedule.phase === "active"
          && Number.isFinite(publishedMs)
          && publishedMs < schedule.session.startMs;
        if (belongsToPriorSession) {
          draft = normalizePresentation({
            status: "waiting",
            stepIndex: 0,
            message: "",
            version: published.version,
          });
          dirty = true;
          syncControlUi(true);
          document.getElementById("staff-publish-state").textContent = "New session detected. Controls were reset locally—choose Save when this group is ready.";
        } else {
          draft = { ...published };
          syncControlUi(true);
          document.getElementById("staff-publish-state").textContent = `${formatPublishedAt(published.updatedAt)} Attendee screens refresh automatically.`;
        }
      }
      refreshSchedule();
      return true;
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return false;
      if (!(options && options.silent)) toast("Couldn't load this booth — check the connection and try again.");
      return false;
    } finally {
      refreshInFlight = false;
    }
  }

  document.getElementById("btn-staff-refresh").addEventListener("click", () => refresh());

  OrganizerAuth.init({
    onUnlocked: async () => {
      await startSharedDemoClock();
      await refresh();
      if (OrganizerAuth.key()) {
        if (!refreshTimer) refreshTimer = setInterval(() => refresh({ silent: true }), 5000);
        if (!scheduleTimer) scheduleTimer = setInterval(refreshSchedule, 1000);
      }
    },
    onLocked: () => {
      if (refreshTimer) clearInterval(refreshTimer);
      if (scheduleTimer) clearInterval(scheduleTimer);
      refreshTimer = null;
      scheduleTimer = null;
      clearBoothData();
    },
  });

  refreshSchedule();
}
