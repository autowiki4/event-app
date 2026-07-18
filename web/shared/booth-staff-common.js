/* Ordered-screen behavior used by The Heaven Booth leader portal. Leaders
 * move attendee phones with Back/Next and see only this booth's check-ins. */
function initBoothStaff(boothId) {
  const booth = CONNECTOR_BOOTHS.find((item) => item.id === boothId);
  if (!booth) {
    document.getElementById("staff-booth-name").textContent = "Unknown booth";
    document.getElementById("organizer-access").style.display = "none";
    return;
  }

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
  let conflictRecoveryPending = false;

  document.title = `${booth.title} — Booth Leader`;
  document.getElementById("staff-booth-name").textContent = booth.title;
  document.getElementById("staff-booth-description").textContent = booth.blurb;
  document.getElementById("staff-booth-mode").textContent = "Booth leader portal";
  document.body.classList.add("has-booth-leader-dock");

  const roomLaunch = document.getElementById("staff-room-launch");
  roomLaunch.innerHTML = `<a class="btn btn-primary" href="../phase2-booths/hub.html" target="_blank" rel="noopener">Open attendee schedule in a new tab →</a>`;

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
    const savedStatus = String(raw.status || "").toLowerCase();
    let stepIndex = Number.isFinite(parsedStep)
      ? Math.max(0, Math.min(steps.length - 1, Math.trunc(parsedStep)))
      : 0;
    const status = savedStatus === "complete"
      ? "complete"
      : ["live", "paused", "wrap"].includes(savedStatus)
        ? "live"
        : "waiting";
    if (status === "waiting") stepIndex = 0;
    else if (status === "complete") stepIndex = steps.length - 1;
    else if (stepIndex >= steps.length - 1) stepIndex = Math.max(0, steps.length - 2);
    return {
      boothId: booth.id,
      sessionNumber: Number.isInteger(Number(raw.sessionNumber))
        ? Number(raw.sessionNumber)
        : 1,
      status,
      stepIndex,
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
        <div class="lbl">Attendee phones</div>
        <p style="font-size:12px;line-height:1.45;color:var(--ink-soft);margin:7px 0 0;">Use Back or Next to change every attendee phone. If you do nothing, phones stay on the current screen.</p>

        <div class="section-title" style="margin-top:18px;">Choose the attendee screen</div>
        <div class="booth-leader-dock" role="group" aria-label="Move attendee phones backward or forward">
          <div class="booth-leader-dock-copy">
            <span>Attendee phones</span>
            <strong id="staff-step-position">Screen 1 of ${steps.length}</strong>
            <small>Back and Next update phones immediately.</small>
          </div>
          <div class="booth-leader-dock-actions">
            <button type="button" class="btn btn-small btn-ghost" id="btn-staff-previous">← Back</button>
            <button type="button" class="btn btn-small btn-primary" id="btn-staff-next">Next →</button>
          </div>
        </div>
        <div class="booth-list" id="staff-step-list" role="radiogroup" aria-label="Booth activity step" style="margin-top:10px;">
          ${steps.map((step, index) => `
            <button type="button" class="booth-card" role="radio" aria-checked="false" data-step-index="${index}" style="width:100%;text-align:left;cursor:pointer;font-family:inherit;">
              <span class="booth-icon" aria-hidden="true">${index + 1}</span>
              <span class="booth-info">
                <span class="name" style="display:block;">${escapeHtml(step.title)}</span>
                ${step.text ? `<span class="hint" style="display:block;">${escapeHtml(step.text)}</span>` : ""}
              </span>
              <span class="stamp-btn disabled" data-step-marker>Show</span>
            </button>
          `).join("")}
        </div>

        <button type="button" class="btn btn-small btn-ghost" id="btn-staff-reset">Restart at welcome</button>
        <p id="staff-publish-state" role="status" style="font-size:12px;line-height:1.45;color:var(--ink-soft);margin:11px 0 0;">Loading published controls…</p>
      </div>
    `;

    controls.querySelectorAll("[data-step-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextIndex = Number(button.dataset.stepIndex);
        if (saving || (draft.stepIndex === nextIndex && ["live", "complete"].includes(draft.status))) return;
        draft.stepIndex = nextIndex;
        draft.status = nextIndex >= steps.length - 1 ? "complete" : "live";
        markDirty();
        syncControlUi();
        savePresentation();
      });
    });
    document.getElementById("btn-staff-previous").addEventListener("click", () => changeStep(-1, true));
    document.getElementById("btn-staff-next").addEventListener("click", () => changeStep(1, true));
    document.getElementById("btn-staff-reset").addEventListener("click", resetDraft);
    syncControlUi();
  }

  function changeStep(delta, publishNow) {
    if (conflictRecoveryPending) {
      if (publishNow && delta > 0) savePresentation();
      return;
    }
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
    if (saving || !window.confirm("Return attendee phones to the welcome screen and start this booth over?")) return;
    draft = normalizePresentation({ status: "waiting", stepIndex: 0, version: published.version });
    draft.sessionNumber = published.sessionNumber;
    markDirty();
    syncControlUi();
    savePresentation();
  }

  function markDirty() {
    dirty = true;
    const state = document.getElementById("staff-publish-state");
    if (state) state.textContent = "Change ready to send to attendee phones.";
  }

  function publishWindowOpen() {
    if (booth.id !== "story") return true;
    if (typeof EventSchedule === "undefined" || typeof EventSchedule.current !== "function") return false;
    const snapshot = EventSchedule.current();
    return Boolean(
      snapshot
        && ["active", "extra"].includes(snapshot.phase)
        && snapshot.session
        && Number(snapshot.session.number) === Number(draft.sessionNumber)
    );
  }

  function syncControlUi() {
    const canPublish = publishWindowOpen();
    document.querySelectorAll("[data-step-index]").forEach((button) => {
      const selected = Number(button.dataset.stepIndex) === draft.stepIndex;
      button.setAttribute("aria-checked", String(selected));
      button.classList.toggle("visited", selected);
      button.disabled = saving || !canPublish;
      button.style.opacity = button.disabled ? ".55" : "1";
      const marker = button.querySelector("[data-step-marker]");
      marker.textContent = selected ? "Showing" : "Show";
      marker.className = selected ? "stamp-btn done" : "stamp-btn disabled";
    });
    const previousButton = document.getElementById("btn-staff-previous");
    const nextButton = document.getElementById("btn-staff-next");
    previousButton.disabled = saving || !canPublish || conflictRecoveryPending || draft.stepIndex <= 0;
    nextButton.disabled = saving || !canPublish || (!conflictRecoveryPending && draft.stepIndex >= steps.length - 1);
    nextButton.textContent = !canPublish
      ? "Wait for booth time"
      : conflictRecoveryPending ? "Apply my change" : "Next →";
    previousButton.style.opacity = previousButton.disabled ? ".45" : "1";
    nextButton.style.opacity = nextButton.disabled ? ".45" : "1";
    document.getElementById("staff-step-position").textContent = `Screen ${draft.stepIndex + 1} of ${steps.length}`;

    const resetButton = document.getElementById("btn-staff-reset");
    resetButton.disabled = saving || !canPublish;
    resetButton.style.opacity = resetButton.disabled ? ".55" : "1";
  }

  function formatPublishedAt(value) {
    if (!value) return "Attendee phones are ready.";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Attendee phones are ready.";
    return `Phones updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  }

  function samePublishedScreen(left, right) {
    return left.sessionNumber === right.sessionNumber
      && left.status === right.status
      && left.stepIndex === right.stepIndex;
  }

  async function recoverPresentationConflict(intended, authGeneration, organizerKey, state) {
    try {
      const data = await EventAPI.boothDashboardData(booth.id, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return false;
      const latest = normalizePresentation(data.presentation);
      published = latest;

      if (samePublishedScreen(latest, intended)) {
        draft = { ...latest };
        dirty = false;
        conflictRecoveryPending = false;
        syncControlUi();
        state.textContent = "Another booth leader already showed this same screen. Attendee phones are current.";
        toast("Attendee phones are already on this screen.");
        return true;
      }

      draft = {
        ...intended,
        version: latest.version,
        updatedAt: latest.updatedAt,
      };
      dirty = true;
      conflictRecoveryPending = true;
      syncControlUi();
      state.textContent = "Another booth leader updated first. Your change is still selected—tap the fixed Apply my change button to send it now.";
      toast("Latest update loaded. Your change is ready to apply.");
      return true;
    } catch (refreshError) {
      console.error(refreshError);
      if (OrganizerAuth.handleError(refreshError, authGeneration)) return false;
      conflictRecoveryPending = true;
      syncControlUi(true);
      state.textContent = "Another booth leader updated first. Your change is still selected—tap Apply my change to try again.";
      return false;
    }
  }

  async function savePresentation() {
    if (saving || !dirty || !publishWindowOpen()) return;
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!organizerKey) return;

    saving = true;
    presentationEpoch += 1;
    const intended = { ...draft };
    syncControlUi();
    const state = document.getElementById("staff-publish-state");
    state.textContent = "Updating attendee phones…";
    let refreshAfterRotationChange = false;
    try {
      const result = await EventAPI.updateBoothPresentation({
        boothId: booth.id,
        ...(booth.id === "story" ? { sessionNumber: draft.sessionNumber } : {}),
        organizerKey,
        status: draft.status,
        stepIndex: draft.stepIndex,
        version: published.version,
      });
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      published = normalizePresentation(result.presentation || result);
      draft = { ...published };
      dirty = false;
      conflictRecoveryPending = false;
      syncControlUi();
      state.textContent = `${formatPublishedAt(published.updatedAt)} Changes appear automatically.`;
      toast("Attendee phones updated.");
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      if (error && error.code === "PRESENTATION_CONFLICT") {
        await recoverPresentationConflict(intended, authGeneration, organizerKey, state);
      } else if (error && error.code === "BOOTH_SESSION_NOT_ACTIVE") {
        dirty = false;
        conflictRecoveryPending = false;
        refreshAfterRotationChange = true;
        state.textContent = "The rotation changed before that update was sent. Loading the current session; no attendee screen changed.";
        toast("The rotation changed. Current controls are loading.");
      } else {
        state.textContent = "Couldn't publish the controls. Your changes are still here; try again.";
        toast("Couldn't update the attendee screen.");
      }
    } finally {
      if (OrganizerAuth.isCurrent(authGeneration)) {
        saving = false;
        syncControlUi();
        if (refreshAfterRotationChange) window.setTimeout(() => refresh({ silent: true }), 0);
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
    conflictRecoveryPending = false;
    published = normalizePresentation(null);
    draft = { ...published };
    syncControlUi();
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
      label.textContent = "Scheduled booths: 3:35–4:15 PM · Extra booth: 4:50–5:10 PM";
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

    if (current.phase === "extra" && current.session) {
      label.textContent = `Extra booth · ${current.session.label}`;
      group.textContent = "Attendees who selected this booth are scheduled here.";
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

    if (current.phase === "message") {
      label.textContent = "Main message";
      group.textContent = "The message is being delivered. Booth controls stay saved for the 4:50 PM extra-booth option.";
      timer.textContent = `${EventSchedule.formatCountdown(current.remainingMs)} until extra booths`;
      return;
    }

    label.textContent = "Connections time";
    group.textContent = "The extra booth window has ended. Direct attendees to Connections.";
    timer.textContent = "Booths closed";
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
          && (schedule.phase === "active" || schedule.phase === "extra")
          && Number.isFinite(publishedMs)
          && publishedMs < schedule.session.startMs;
        if (belongsToPriorSession) {
          draft = normalizePresentation({
            status: "waiting",
            stepIndex: 0,
            version: published.version,
            sessionNumber: published.sessionNumber,
          });
          dirty = true;
          syncControlUi();
          document.getElementById("staff-publish-state").textContent = "A new session is ready. Attendee phones will wait on the welcome screen until you tap Next.";
        } else {
          draft = { ...published };
          syncControlUi();
          document.getElementById("staff-publish-state").textContent = `${formatPublishedAt(published.updatedAt)} Changes appear automatically.`;
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
    scope: booth.id,
    onUnlocked: async () => {
      await startSharedDemoClock();
      await refresh();
      if (OrganizerAuth.key()) {
        if (!refreshTimer) refreshTimer = setInterval(() => refresh({ silent: true }), 5000);
        if (!scheduleTimer) scheduleTimer = setInterval(() => {
          refreshSchedule();
          syncControlUi();
        }, 1000);
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
