/* Dedicated Art Therapy booth-leader controller.
 *
 * Each timed rotation has an independent, versioned run. The leader is the
 * only person who can reveal the next slide; attendee phones simply poll the
 * published phase and receive Done only after the leader closes the run.
 */
function initArtStaff() {
  const SESSION_COUNT = 3;
  const POLL_INTERVAL_MS = Math.round(2100 * (0.85 + Math.random() * 0.3));
  const PHASES = new Set([
    "welcome", "definition", "importance", "purpose_image", "heart_question",
    "proverbs", "philippians", "create", "finished", "complete",
  ]);
  const FALLBACK_BANDS = [
    { id: "orange", label: "Orange" },
    { id: "green", label: "Green" },
    { id: "red", label: "Red" },
  ];
  const PHASE_MODELS = {
    welcome: {
      label: "Welcome lobby", icon: "🎨", title: "Attendees see the waiting canvas.",
      copy: "Introduce the activity. When the room is ready, publish Slide 1 to every phone.",
      action: "start", actionLabel: "Show Slide 1: What is art therapy? →",
    },
    definition: {
      label: "Slide 1", icon: "🖌️", title: "“What is art therapy?” is live.",
      copy: "Attendees see the definition, the non-clinical activity note, and a reminder that expression matters more than perfection.",
      action: "show_importance", actionLabel: "Show Slide 2: Why is it important? →",
    },
    importance: {
      label: "Slide 2", icon: "💛", title: "“Why is art therapy important?” is live.",
      copy: "The room sees three ideas: express beyond words, slow down and notice, and make room for reflection.",
      action: "show_purpose_image", actionLabel: "Show Slide 2 visual: Heart & mind →",
    },
    purpose_image: {
      label: "Slide 2 · Visual", icon: "🧠", title: "The heart-and-mind visual is live.",
      copy: "Give everyone time to study the illustration. The image can be enlarged on each phone.",
      action: "ask_heart", actionLabel: "Show Slide 3: What does the Bible say? →",
    },
    heart_question: {
      label: "Slide 3", icon: "♥", title: "The Bible heart question is live.",
      copy: "Attendees can see the question, but neither passage is visible yet. Reveal Proverbs when the speaker reaches it.",
      action: "show_proverbs", actionLabel: "Reveal Proverbs 4:23 →",
    },
    proverbs: {
      label: "Slide 3 · Verse 1", icon: "📖", title: "Proverbs 4:23 is live.",
      copy: "The first verse remains on screen. Publish Philippians next so both passages can be considered together.",
      action: "show_philippians", actionLabel: "Reveal Philippians 4:7 →",
    },
    philippians: {
      label: "Slide 3 · Both verses", icon: "🕊️", title: "Both Bible passages are live.",
      copy: "Connect guarding the heart with the peace of God, then begin the hands-on activity.",
      action: "start_art", actionLabel: "Show Slide 5: Let’s create →",
    },
    create: {
      label: "Slide 5", icon: "🖍️", title: "The creative activity is live.",
      copy: "Lead the physical art prompt in the room. Phones collect no artwork, text, rating, or comment.",
      action: "show_finished", actionLabel: "Show Slide 6: I’m finished—now what? →",
    },
    finished: {
      label: "Slide 6", icon: "🖼️", title: "The closing reflection is live.",
      copy: "Ask attendees to notice one detail in their art and listen for the closing thought. Release Done only when the shared moment is complete.",
      action: "finish", actionLabel: "Release Done for everyone →",
    },
    complete: {
      label: "Complete", icon: "✅", title: "Done is released for this run.",
      copy: "Attendees can save the booth visit and return to their timed route. Restart only when you intentionally want another run in this session.",
      action: null, actionLabel: "",
    },
  };

  let dashboard = null;
  let selectedSessionNumber = 1;
  let selectionPinned = false;
  let refreshTimer = null;
  let scheduleTimer = null;
  let refreshInFlight = false;
  let refreshQueued = false;
  let controlBusy = false;
  let requestEpoch = 0;

  const tabs = Array.from(document.querySelectorAll("[data-art-session]"));
  const settings = document.getElementById("staff-settings");
  const stage = document.getElementById("art-stage");
  const actions = document.getElementById("art-actions");
  const refreshButton = document.getElementById("btn-art-refresh");
  const restartButton = document.getElementById("btn-art-restart");

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function integer(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function safePhase(value) {
    const phase = String(value || "").trim().toLowerCase();
    return PHASES.has(phase) ? phase : "welcome";
  }

  function normalizeParticipant(value) {
    const source = object(value);
    return {
      attendeeId: String(source.attendeeId || ""),
      name: String(source.name || "Guest"),
      raffleNumber: String(source.raffleNumber || ""),
      completedAt: source.completedAt || null,
    };
  }

  function normalizeRun(value, fallbackRunNumber = 1) {
    const source = object(value);
    const participants = (Array.isArray(source.participants) ? source.participants : []).map(normalizeParticipant);
    return {
      runId: String(source.runId || ""),
      runNumber: Math.max(1, integer(source.runNumber, fallbackRunNumber)),
      phase: safePhase(source.phase),
      version: Math.max(0, integer(source.version)),
      startedAt: source.startedAt || null,
      completedAt: source.completedAt || null,
      updatedAt: source.updatedAt || null,
      archivedAt: source.archivedAt || null,
      archiveReason: String(source.archiveReason || ""),
      completedCount: Math.max(0, integer(source.completedCount, participants.filter((participant) => participant.completedAt).length)),
      participants,
    };
  }

  function sessionSchedule(sessionNumber = selectedSessionNumber) {
    return typeof BOOTH_SESSIONS !== "undefined" && Array.isArray(BOOTH_SESSIONS)
      ? BOOTH_SESSIONS[sessionNumber - 1] || null
      : null;
  }

  function fallbackBand(sessionNumber = selectedSessionNumber) {
    if (typeof EventSchedule !== "undefined" && typeof EventSchedule.groupForBooth === "function") {
      const group = EventSchedule.groupForBooth("art", sessionNumber - 1);
      if (group) return group;
    }
    return FALLBACK_BANDS[sessionNumber - 1] || { id: "", label: "Assigned" };
  }

  function normalizeSession(value, sessionNumber) {
    const source = object(value);
    const rawState = object(source.state && Object.keys(source.state).length ? source.state : source.activeRun);
    const assignedColor = Object.keys(object(source.assignedColor)).length
      ? object(source.assignedColor)
      : fallbackBand(sessionNumber);
    const state = normalizeRun({
      ...rawState,
      completedCount: source.completedCount ?? rawState.completedCount,
      participants: source.participants || rawState.participants,
    });
    return {
      sessionNumber,
      sessionLabel: String(source.sessionLabel || (sessionSchedule(sessionNumber) || {}).label || `Session ${sessionNumber}`),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || "Assigned"),
      },
      assignedCount: Math.max(0, integer(source.assignedCount)),
      completedCount: Math.max(0, integer(source.completedCount, state.completedCount)),
      state,
      participants: (Array.isArray(source.participants) ? source.participants : state.participants).map(normalizeParticipant),
      archivedRuns: (Array.isArray(source.archivedRuns) ? source.archivedRuns : [])
        .map((run, index) => normalizeRun(run, index + 1))
        .sort((a, b) => b.runNumber - a.runNumber),
    };
  }

  function normalizeDashboard(value) {
    const source = object(value);
    const incoming = Array.isArray(source.sessions) ? source.sessions : [];
    return {
      serverNow: source.serverNow || null,
      eventState: object(source.eventState),
      sessions: Array.from({ length: SESSION_COUNT }, (_, index) => {
        const sessionNumber = index + 1;
        const match = incoming.find((session) => integer(object(session).sessionNumber) === sessionNumber);
        return normalizeSession(match, sessionNumber);
      }),
    };
  }

  function currentSession() {
    return dashboard && dashboard.sessions.find((session) => session.sessionNumber === selectedSessionNumber);
  }

  function applyControlResult(value) {
    const source = object(value);
    if (Array.isArray(source.sessions)) {
      dashboard = normalizeDashboard(source);
      return true;
    }
    const sessionNumber = integer(source.sessionNumber);
    if (!dashboard || sessionNumber < 1 || sessionNumber > SESSION_COUNT) return false;
    const nextSession = normalizeSession(source, sessionNumber);
    dashboard = {
      ...dashboard,
      serverNow: source.serverNow || dashboard.serverNow,
      sessions: dashboard.sessions.map((session) => (
        session.sessionNumber === sessionNumber ? nextSession : session
      )),
    };
    return true;
  }

  function phaseModel(phase) {
    return PHASE_MODELS[safePhase(phase)] || PHASE_MODELS.welcome;
  }

  function formatSavedTime(value) {
    if (!value) return "Not saved";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Saved";
    return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function selectedTimerModel() {
    const schedule = sessionSchedule();
    if (!schedule || typeof EventSchedule === "undefined") return { value: "--:--", label: "Clock unavailable", tone: "waiting" };
    const now = EventSchedule.nowMs();
    const start = new Date(schedule.startsAt).getTime();
    const end = new Date(schedule.endsAt).getTime();
    if (now < start) return { value: EventSchedule.formatCountdown(start - now), label: "Until this session", tone: "waiting" };
    if (now < end) return { value: EventSchedule.formatCountdown(end - now), label: "Remaining", tone: "live" };
    return { value: "00:00", label: "Session ended", tone: "ended" };
  }

  function renderTimer() {
    const target = document.getElementById("art-session-timer");
    if (!target) return;
    const model = selectedTimerModel();
    target.className = `art-session-timer ${model.tone}`;
    target.innerHTML = `${escapeHtml(model.value)}<small>${escapeHtml(model.label)}</small>`;
  }

  function renderTabs() {
    tabs.forEach((tab) => {
      const sessionNumber = integer(tab.dataset.artSession);
      const selected = sessionNumber === selectedSessionNumber;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    const panel = document.getElementById("art-session-panel");
    if (panel) panel.setAttribute("aria-labelledby", `art-tab-${selectedSessionNumber}`);
  }

  function renderStage(session) {
    const model = phaseModel(session.state.phase);
    stage.innerHTML = `
      <div class="art-stage-icon" aria-hidden="true">${model.icon}</div>
      <div class="art-stage-copy">
        <h3>${escapeHtml(model.title)}</h3>
        <p>${escapeHtml(model.copy)}</p>
      </div>
    `;
  }

  function renderActions(session) {
    const model = phaseModel(session.state.phase);
    if (!model.action) {
      actions.innerHTML = `<p class="art-finished-note">This run is complete. Attendees now have their Done button. Use “Archive run &amp; start another” only for an intentional fresh run in this same timed session.</p>`;
      return;
    }
    actions.innerHTML = `<button type="button" class="btn btn-primary" id="btn-art-advance" data-art-action="${model.action}" ${controlBusy ? "disabled" : ""}>${controlBusy ? "Publishing…" : escapeHtml(model.actionLabel)}</button>`;
  }

  function participantRows(session) {
    if (!session.participants.length) {
      return `<tr><td colspan="3" class="art-empty">No attendees are assigned to Session ${session.sessionNumber} yet.</td></tr>`;
    }
    return session.participants.map((participant) => `
      <tr>
        <td><strong>${escapeHtml(participant.name)}</strong></td>
        <td class="art-raffle">#${escapeHtml(participant.raffleNumber || "----")}</td>
        <td><span class="art-done-state ${participant.completedAt ? "yes" : "no"}">${participant.completedAt ? `✓ ${escapeHtml(formatSavedTime(participant.completedAt))}` : "Waiting"}</span></td>
      </tr>
    `).join("");
  }

  function renderParticipants(session) {
    document.getElementById("art-roster-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber} assigned attendees`;
    document.querySelector("#art-progress-table tbody").innerHTML = participantRows(session);
  }

  function archivedParticipants(run) {
    if (!run.participants.length) return `<div class="art-empty">No attendee completions were saved in this run.</div>`;
    return `<div class="art-archive-people">${run.participants.map((participant) => `
      <span><b>${escapeHtml(participant.name)}</b><small>#${escapeHtml(participant.raffleNumber || "----")} · ${participant.completedAt ? `Done ${escapeHtml(formatSavedTime(participant.completedAt))}` : "Not completed"}</small></span>
    `).join("")}</div>`;
  }

  function renderArchivedRuns(session) {
    const target = document.getElementById("art-run-history");
    if (!session.archivedRuns.length) {
      target.innerHTML = `<div class="art-empty">No previous Art Therapy runs have been archived for Session ${session.sessionNumber}.</div>`;
      return;
    }
    target.innerHTML = session.archivedRuns.map((run) => `
      <details class="art-archive-run">
        <summary>
          <span><b>Run ${run.runNumber}</b> · ${escapeHtml(phaseModel(run.phase).label)}</span>
          <small>${run.completedCount} completed · archived ${escapeHtml(formatSavedTime(run.archivedAt))}</small>
        </summary>
        <div class="art-archive-body">
          <p>Started: ${escapeHtml(formatSavedTime(run.startedAt))} · Completed: ${escapeHtml(formatSavedTime(run.completedAt))}</p>
          ${archivedParticipants(run)}
        </div>
      </details>
    `).join("");
  }

  function renderSession() {
    const session = currentSession();
    if (!session) return;
    renderTabs();
    const model = phaseModel(session.state.phase);
    document.getElementById("art-control-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber}`;
    const pill = document.getElementById("art-phase-pill");
    pill.className = `art-phase-pill ${session.state.phase}`;
    pill.textContent = model.label;
    const dot = `<span class="art-band-dot ${escapeHtml(session.assignedColor.id)}" aria-hidden="true"></span>`;
    document.getElementById("art-assigned-band").innerHTML = `${dot}${escapeHtml(session.assignedColor.label)} wristbands · Session ${session.sessionNumber}`;
    document.getElementById("art-session-time").textContent = session.sessionLabel;
    document.getElementById("art-assigned-count").textContent = session.assignedCount;
    document.getElementById("art-completed-count").textContent = session.completedCount;
    renderTimer();
    renderStage(session);
    renderActions(session);
    renderParticipants(session);
    renderArchivedRuns(session);
    document.getElementById("art-publish-state").textContent = session.state.updatedAt
      ? `Published ${model.label} · version ${session.state.version} · updated ${formatSavedTime(session.state.updatedAt)}`
      : `Run ${session.state.runNumber} is ready in the welcome lobby.`;
    restartButton.disabled = controlBusy;
    refreshButton.disabled = refreshInFlight || controlBusy;
  }

  function setSyncNote(message, tone = "info") {
    const target = document.getElementById("art-sync-note");
    if (!message) {
      target.style.display = "none";
      target.textContent = "";
      return;
    }
    target.className = `art-sync-note ${tone}`;
    target.textContent = message;
    target.style.display = "block";
  }

  async function refreshDashboard(options = {}) {
    if (!OrganizerAuth.key()) return false;
    if (refreshInFlight) {
      if (options.queue) refreshQueued = true;
      return false;
    }
    refreshInFlight = true;
    const epoch = requestEpoch;
    const authGeneration = OrganizerAuth.generation();
    if (options.showLoading && settings) settings.classList.add("art-loading-panel");
    try {
      const requestStarted = Date.now();
      const result = await EventAPI.artDashboardData(OrganizerAuth.key());
      if (epoch !== requestEpoch || !OrganizerAuth.isCurrent(authGeneration)) return false;
      if (result && result.serverNow && typeof EventSchedule !== "undefined") {
        EventSchedule.sync(result.serverNow, requestStarted, Date.now());
      }
      dashboard = normalizeDashboard(result);
      const activeSessionNumber = integer(dashboard.eventState.sessionNumber);
      if (!selectionPinned && activeSessionNumber >= 1 && activeSessionNumber <= SESSION_COUNT) {
        selectedSessionNumber = activeSessionNumber;
      }
      renderSession();
      setSyncNote("");
      document.getElementById("staff-last-updated").textContent = `Last refreshed ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
      return true;
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return false;
      setSyncNote("Live Art Therapy controls could not refresh. The last published view remains on attendees’ phones while this page reconnects.", "error");
      return false;
    } finally {
      refreshInFlight = false;
      if (settings) settings.classList.remove("art-loading-panel");
      if (dashboard) renderSession();
      if (refreshQueued && OrganizerAuth.key()) {
        refreshQueued = false;
        window.setTimeout(() => refreshDashboard(), 0);
      }
    }
  }

  async function advance(action) {
    const session = currentSession();
    if (!session || controlBusy || !action) return;
    controlBusy = true;
    requestEpoch += 1;
    const authGeneration = OrganizerAuth.generation();
    renderSession();
    try {
      const result = await EventAPI.advanceArtSession(
        session.sessionNumber,
        action,
        session.state.version,
        OrganizerAuth.key()
      );
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      applyControlResult(result.dashboard || result);
      renderSession();
      await refreshDashboard({ queue: true });
      toast("Every attendee screen was updated.");
    } catch (error) {
      console.error(error);
      if (!OrganizerAuth.handleError(error, authGeneration)) {
        toast(error && error.message ? error.message : "Couldn’t publish the next Art Therapy slide.");
      }
      await refreshDashboard({ queue: true });
    } finally {
      controlBusy = false;
      if (dashboard) renderSession();
    }
  }

  async function restartRun() {
    const session = currentSession();
    if (!session || controlBusy) return;
    const waitingCount = Math.max(0, session.assignedCount - session.completedCount);
    const unfinishedRunWarning = session.state.phase === "complete"
      ? ""
      : "\n\nThis run has not reached Done yet. Restart only if you intentionally want to end it early.";
    const unsavedWarning = waitingCount > 0
      ? `\n\nWARNING: ${waitingCount} assigned ${waitingCount === 1 ? "attendee has" : "attendees have"} not saved Done for this run. Restarting will move any open attendee screens to the new welcome and they will no longer be able to save this archived run.`
      : "";
    const confirmed = window.confirm(
      `Archive Session ${session.sessionNumber} · Run ${session.state.runNumber} and start a fresh Art Therapy welcome screen?\n\nSaved completions will remain in read-only history. The other two sessions will not change.${unfinishedRunWarning}${unsavedWarning}`
    );
    if (!confirmed) return;
    controlBusy = true;
    requestEpoch += 1;
    const authGeneration = OrganizerAuth.generation();
    renderSession();
    try {
      const result = await EventAPI.resetArtSession(
        session.sessionNumber,
        session.state.version,
        OrganizerAuth.key()
      );
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      applyControlResult(result.dashboard || result);
      renderSession();
      await refreshDashboard({ queue: true });
      toast(`Session ${session.sessionNumber} is ready with a fresh Art Therapy run.`);
    } catch (error) {
      console.error(error);
      if (!OrganizerAuth.handleError(error, authGeneration)) {
        toast(error && error.message ? error.message : "Couldn’t restart this Art Therapy run.");
      }
      await refreshDashboard({ queue: true });
    } finally {
      controlBusy = false;
      if (dashboard) renderSession();
    }
  }

  function startTimers() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    if (scheduleTimer) window.clearInterval(scheduleTimer);
    refreshTimer = window.setInterval(() => {
      if (!document.hidden && !controlBusy) refreshDashboard();
    }, POLL_INTERVAL_MS);
    scheduleTimer = window.setInterval(() => {
      renderTimer();
      if (!selectionPinned && dashboard) {
        const snapshot = EventSchedule.current();
        if (snapshot.phase === "active" && snapshot.sessionNumber !== selectedSessionNumber) {
          selectedSessionNumber = snapshot.sessionNumber;
          renderSession();
        }
      }
    }, 1000);
  }

  function stopTimers() {
    requestEpoch += 1;
    if (refreshTimer) window.clearInterval(refreshTimer);
    if (scheduleTimer) window.clearInterval(scheduleTimer);
    refreshTimer = null;
    scheduleTimer = null;
    refreshQueued = false;
    dashboard = null;
    setSyncNote("");
  }

  function selectSession(sessionNumber, focusTab) {
    if (sessionNumber < 1 || sessionNumber > SESSION_COUNT) return;
    selectedSessionNumber = sessionNumber;
    selectionPinned = true;
    renderSession();
    if (focusTab) {
      const target = tabs.find((tab) => integer(tab.dataset.artSession) === sessionNumber);
      if (target) target.focus();
    }
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => {
    const sessionNumber = integer(tab.dataset.artSession);
    selectSession(sessionNumber, false);
  }));
  tabs.forEach((tab) => tab.addEventListener("keydown", (event) => {
    const currentIndex = tabs.indexOf(tab);
    let targetIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") targetIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = tabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    selectSession(integer(tabs[targetIndex].dataset.artSession), true);
  }));
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-art-action]");
    if (button) advance(String(button.dataset.artAction || ""));
  });
  refreshButton.addEventListener("click", () => refreshDashboard({ showLoading: true }));
  restartButton.addEventListener("click", restartRun);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && OrganizerAuth.key()) refreshDashboard();
  });

  OrganizerAuth.init({
    onUnlocked: async () => {
      selectionPinned = false;
      await EventSchedule.startDemoClockSync(5000).catch(() => {});
      await refreshDashboard({ showLoading: true });
      startTimers();
    },
    onLocked: stopTimers,
  });
}
