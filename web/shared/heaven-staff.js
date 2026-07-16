/* Draw Heaven booth-leader controller.
 *
 * Each timed rotation has an independent, versioned run. Advancing changes
 * every attendee in that run at once; restarting archives the current run so
 * earlier participation stays visible instead of being mixed or erased.
 */
function initHeavenStaff() {
  const SESSION_COUNT = 3;
  const POLL_INTERVAL_MS = Math.round(2000 * (0.85 + Math.random() * 0.3));
  const PHASES = new Set(["welcome", "drawing", "verse", "comparison", "reflection", "programs", "complete"]);
  const CONFIRMATIONS = ["drawing_complete", "description_yes", "size_yes", "impact_yes", "programs_done"];
  const FALLBACK_BANDS = [
    { id: "blue", label: "Blue" },
    { id: "red", label: "Red" },
    { id: "green", label: "Green" },
  ];

  let dashboard = null;
  let selectedSessionNumber = 1;
  let selectionPinned = false;
  let refreshTimer = null;
  let scheduleTimer = null;
  let refreshInFlight = false;
  let activeRefreshId = 0;
  let controlBusy = false;
  let requestEpoch = 0;
  let demoClockSyncStarted = false;

  const tabs = Array.from(document.querySelectorAll("[data-heaven-session]"));
  const settings = document.getElementById("staff-settings");
  const stage = document.getElementById("heaven-stage");
  const actions = document.getElementById("heaven-actions");
  const refreshButton = document.getElementById("btn-heaven-refresh");
  const restartButton = document.getElementById("btn-heaven-restart");

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

  function emptyConfirmations() {
    return CONFIRMATIONS.reduce((result, action) => {
      result[action] = false;
      return result;
    }, {});
  }

  function normalizeConfirmations(value) {
    const source = object(value);
    return CONFIRMATIONS.reduce((result, action) => {
      result[action] = Boolean(source[action]);
      return result;
    }, {});
  }

  function normalizeCounts(value) {
    const source = object(value);
    return CONFIRMATIONS.reduce((result, action) => {
      result[action] = Math.max(0, integer(source[action]));
      return result;
    }, {});
  }

  function normalizeParticipant(value) {
    const source = object(value);
    const confirmations = normalizeConfirmations(source.confirmations);
    return {
      attendeeId: String(source.attendeeId || ""),
      name: String(source.name || "Guest"),
      raffleNumber: String(source.raffleNumber || ""),
      confirmations,
      confirmedAt: object(source.confirmedAt),
      completedActionCount: Math.max(0, integer(
        source.completedActionCount,
        CONFIRMATIONS.filter((action) => confirmations[action]).length
      )),
      done: Boolean(source.done || confirmations.programs_done),
    };
  }

  function sessionSchedule(sessionNumber = selectedSessionNumber) {
    return typeof BOOTH_SESSIONS !== "undefined" && Array.isArray(BOOTH_SESSIONS)
      ? BOOTH_SESSIONS[sessionNumber - 1] || null
      : null;
  }

  function fallbackBand(sessionNumber = selectedSessionNumber) {
    if (typeof EventSchedule !== "undefined" && typeof EventSchedule.groupForBooth === "function") {
      const group = EventSchedule.groupForBooth("heaven", sessionNumber - 1);
      if (group) return group;
    }
    return FALLBACK_BANDS[sessionNumber - 1] || { id: "", label: "Assigned" };
  }

  function normalizeRun(value, fallbackRunNumber = 1) {
    const source = object(value);
    return {
      runId: String(source.runId || ""),
      runNumber: Math.max(1, integer(source.runNumber, fallbackRunNumber)),
      phase: safePhase(source.phase),
      version: Math.max(0, integer(source.version)),
      startedAt: source.startedAt || null,
      completedAt: source.completedAt || null,
      archivedAt: source.archivedAt || null,
      archiveReason: String(source.archiveReason || ""),
      participantCount: Math.max(0, integer(source.participantCount)),
      confirmationCounts: normalizeCounts(source.confirmationCounts),
      participants: (Array.isArray(source.participants) ? source.participants : []).map(normalizeParticipant),
    };
  }

  function normalizeSession(value, sessionNumber) {
    const source = object(value);
    const rawState = object(source.state && Object.keys(source.state).length ? source.state : source.activeRun);
    const assignedColor = Object.keys(object(source.assignedColor)).length
      ? object(source.assignedColor)
      : fallbackBand(sessionNumber);
    const state = {
      ...normalizeRun(rawState),
      updatedAt: rawState.updatedAt || null,
    };
    return {
      sessionNumber,
      sessionLabel: String(source.sessionLabel || (sessionSchedule(sessionNumber) || {}).label || `Session ${sessionNumber}`),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || "Assigned"),
      },
      assignedCount: Math.max(0, integer(source.assignedCount)),
      state,
      participantCount: Math.max(0, integer(source.participantCount)),
      completedCount: Math.max(0, integer(source.completedCount)),
      confirmationCounts: normalizeCounts(source.confirmationCounts),
      participants: (Array.isArray(source.participants) ? source.participants : []).map(normalizeParticipant),
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
        const match = incoming.find((session) => integer(session && session.sessionNumber, -1) === sessionNumber);
        return normalizeSession(match, sessionNumber);
      }),
    };
  }

  function sessionByNumber(sessionNumber = selectedSessionNumber) {
    const sessions = dashboard && Array.isArray(dashboard.sessions) ? dashboard.sessions : [];
    return sessions.find((session) => session.sessionNumber === sessionNumber) || null;
  }

  function phaseLabel(phase) {
    return ({
      welcome: "Welcome",
      drawing: "Drawing & invitation",
      verse: "Verse revealed",
      comparison: "Size comparison",
      reflection: "Meaning revealed",
      programs: "Program preview",
      complete: "Finished",
    })[phase] || "Welcome";
  }

  function bandHex(colorId) {
    if (typeof wristbandColorById === "function") {
      const color = wristbandColorById(colorId);
      if (color && color.hex) return color.hex;
    }
    return ({ blue: "#2F6FED", red: "#D94A43", green: "#2F8A57" })[colorId] || "#8b97b8";
  }

  function currentReadyAction(phase) {
    return ({ drawing: "description_yes", verse: "size_yes", comparison: "impact_yes", programs: "programs_done" })[phase] || "";
  }

  function readyCount(session) {
    const action = currentReadyAction(session.state.phase);
    if (action) return session.confirmationCounts[action] || 0;
    if (session.state.phase === "complete") return session.completedCount;
    return 0;
  }

  function setStatus(message, kind = "") {
    const target = document.getElementById("heaven-publish-state");
    target.textContent = message || "";
    target.style.color = kind === "error" ? "var(--coral-deep)" : "var(--ink-soft)";
  }

  function showSyncNote(message) {
    const note = document.getElementById("heaven-sync-note");
    note.textContent = message || "";
    note.style.display = message ? "block" : "none";
  }

  function renderTabs() {
    tabs.forEach((tab) => {
      const sessionNumber = integer(tab.dataset.heavenSession);
      const selected = sessionNumber === selectedSessionNumber;
      const session = sessionByNumber(sessionNumber);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const band = session ? session.assignedColor.label : fallbackBand(sessionNumber).label;
      const time = session ? session.sessionLabel : (sessionSchedule(sessionNumber) || {}).label || "";
      const run = session ? `Run ${session.state.runNumber}` : "Loading";
      const phase = session ? phaseLabel(session.state.phase) : "";
      tab.querySelector("b").textContent = `Session ${sessionNumber} · ${band}`;
      tab.querySelector("small").textContent = [time, run, phase].filter(Boolean).join(" · ");
    });
    document.getElementById("heaven-session-panel").setAttribute("aria-labelledby", `heaven-tab-${selectedSessionNumber}`);
  }

  function countLine(label, count, total, icon) {
    const maximum = Math.max(1, total);
    const percentage = Math.min(100, Math.round((count / maximum) * 100));
    return `
      <div class="heaven-readiness-row">
        <span aria-hidden="true">${icon}</span>
        <div><strong>${escapeHtml(label)}</strong><div class="heaven-meter"><i style="width:${percentage}%"></i></div></div>
        <b>${count}/${total}</b>
      </div>
    `;
  }

  function renderStage(session) {
    const phase = session.state.phase;
    const counts = session.confirmationCounts;
    const assigned = session.assignedCount;
    const models = {
      welcome: {
        icon: "🎨", title: "Attendees see the Draw Heaven welcome.",
        copy: "Their screens are waiting. Introduce the activity, hand out art supplies, and start when the room is ready.",
      },
      drawing: {
        icon: "🖍️", title: "Drawing and invitation are open.",
        copy: "Guests first confirm that their drawing is ready, then ask to see Revelation's description. You decide when to reveal it.",
      },
      verse: {
        icon: "✨", title: "Revelation 21:10–11 is live.",
        copy: "The verse appeared together with confetti. Guests can now confirm they are ready to see the city's size comparison.",
      },
      comparison: {
        icon: "🏙️", title: "The New Jerusalem comparison is live.",
        copy: "Guests can open the full-size graphic and answer the final readiness question. Let the room study it before the meaning reveal.",
      },
      reflection: {
        icon: "💥", title: "The meaning reveal is live.",
        copy: "Attendees see the one-time burst transition and an explanation of welcome, belonging, restoration, and life with God.",
      },
      programs: {
        icon: "🌟", title: "The five-program preview is live.",
        copy: "This is informational only. Guests cannot enter Phase 3 here; they confirm only that they have seen the preview.",
      },
      complete: {
        icon: "🌈", title: `Run ${session.state.runNumber} is finished.`,
        copy: "Attendees may tap Done to save this booth visit and return to their timed route. Their next booth remains locked until its session.",
      },
    };
    const model = models[phase] || models.welcome;
    let progress = "";
    if (phase === "drawing") {
      progress = [
        countLine("Drawing ready", counts.drawing_complete, assigned, "🖼️"),
        countLine("Asked for the description", counts.description_yes, assigned, "👀"),
      ].join("");
    } else if (phase === "verse") {
      progress = countLine("Ready for the size comparison", counts.size_yes, assigned, "📏");
    } else if (phase === "comparison") {
      progress = countLine("Ready for the meaning", counts.impact_yes, assigned, "💭");
    } else if (phase === "programs") {
      progress = countLine("Finished viewing the preview", counts.programs_done, assigned, "✅");
    } else if (phase === "complete") {
      progress = countLine("Preview confirmed", session.completedCount, assigned, "✅");
    }
    stage.innerHTML = `
      <div class="heaven-stage-icon" aria-hidden="true">${model.icon}</div>
      <div class="heaven-stage-copy"><h3>${escapeHtml(model.title)}</h3><p>${escapeHtml(model.copy)}</p></div>
      ${progress ? `<div class="heaven-readiness">${progress}</div>` : ""}
    `;
  }

  function actionButton(id, label, action, secondary = false) {
    return `<button type="button" class="btn ${secondary ? "btn-ghost" : "btn-primary"}" id="${id}" data-heaven-action="${action}">${escapeHtml(label)}</button>`;
  }

  function renderActions(session) {
    const phase = session.state.phase;
    if (phase === "welcome") actions.innerHTML = actionButton("btn-heaven-start", "Start drawing for everyone →", "start");
    else if (phase === "drawing") actions.innerHTML = actionButton("btn-heaven-show-verse", "Reveal Revelation 21:10–11 ✨", "show_verse");
    else if (phase === "verse") actions.innerHTML = actionButton("btn-heaven-show-comparison", "Show the New Jerusalem size →", "show_comparison");
    else if (phase === "comparison") actions.innerHTML = actionButton("btn-heaven-show-impact", "Reveal what the size means 💥", "show_impact");
    else if (phase === "reflection") actions.innerHTML = actionButton("btn-heaven-show-programs", "Show the five-program preview →", "show_programs");
    else if (phase === "programs") actions.innerHTML = actionButton("btn-heaven-finish", "Finish this shared run →", "finish");
    else actions.innerHTML = `<p class="heaven-finished-note">This run is complete. Use “Save run & start another” only when you intentionally want a fresh welcome screen for this same session.</p>`;
  }

  function confirmationCell(complete, label) {
    return `<td class="heaven-progress-cell ${complete ? "yes" : "no"}" aria-label="${escapeHtml(label)}: ${complete ? "complete" : "not yet"}">${complete ? "✓" : "·"}</td>`;
  }

  function participantRows(participants, emptyMessage) {
    if (!participants.length) return `<tr><td colspan="7" class="heaven-empty">${escapeHtml(emptyMessage)}</td></tr>`;
    return participants.map((participant) => `
      <tr>
        <td><strong>${escapeHtml(participant.name)}</strong></td>
        <td class="heaven-raffle">#${escapeHtml(participant.raffleNumber || "----")}</td>
        ${confirmationCell(participant.confirmations.drawing_complete, "Drawing")}
        ${confirmationCell(participant.confirmations.description_yes, "Description")}
        ${confirmationCell(participant.confirmations.size_yes, "Size")}
        ${confirmationCell(participant.confirmations.impact_yes, "Meaning")}
        ${confirmationCell(participant.confirmations.programs_done, "Programs")}
      </tr>
    `).join("");
  }

  function renderParticipants(session) {
    document.getElementById("heaven-roster-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber} progress`;
    document.querySelector("#heaven-progress-table tbody").innerHTML = participantRows(
      session.participants,
      `No attendees are assigned to Session ${session.sessionNumber} yet.`
    );
  }

  function formatSavedTime(value) {
    if (!value) return "Saved";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Saved";
    return `Saved ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function archiveCounts(run) {
    const counts = run.confirmationCounts || normalizeCounts({});
    return `
      <div class="heaven-archive-counts">
        <span>Drawings <b>${counts.drawing_complete}</b></span>
        <span>Description <b>${counts.description_yes}</b></span>
        <span>Size <b>${counts.size_yes}</b></span>
        <span>Meaning <b>${counts.impact_yes}</b></span>
        <span>Programs <b>${counts.programs_done}</b></span>
      </div>
    `;
  }

  function renderArchivedRuns(session) {
    const target = document.getElementById("heaven-run-history");
    if (!session.archivedRuns.length) {
      target.innerHTML = `<div class="heaven-empty">No previous Draw Heaven runs have been archived for Session ${session.sessionNumber}.</div>`;
      return;
    }
    target.innerHTML = session.archivedRuns.map((run) => `
      <details class="heaven-archive-run">
        <summary>
          <span><b>Run ${run.runNumber}</b> · ${escapeHtml(phaseLabel(run.phase))}</span>
          <small>${run.participantCount} ${run.participantCount === 1 ? "participant" : "participants"} · ${escapeHtml(formatSavedTime(run.archivedAt))}</small>
        </summary>
        <div class="heaven-archive-body">
          <p>This is a read-only snapshot. Restarting never combines it with the active run.</p>
          ${archiveCounts(run)}
          <div class="heaven-table-wrap">
            <table class="dash-table heaven-progress-table">
              <thead><tr><th>Attendee</th><th>Raffle</th><th>Draw</th><th>See</th><th>Size</th><th>Meaning</th><th>Programs</th></tr></thead>
              <tbody>${participantRows(run.participants, "No attendee confirmations were recorded in this run.")}</tbody>
            </table>
          </div>
        </div>
      </details>
    `).join("");
  }

  function renderSchedule() {
    const session = sessionByNumber();
    const schedule = sessionSchedule();
    const timer = document.getElementById("heaven-session-timer");
    const note = document.getElementById("heaven-session-note");
    if (!session || !schedule || typeof EventSchedule === "undefined" || typeof EventSchedule.current !== "function") {
      timer.innerHTML = `--:--<small>Event clock unavailable</small>`;
      note.style.display = "none";
      return;
    }
    const current = EventSchedule.current();
    const selectedIndex = selectedSessionNumber - 1;
    let timerValue = session.sessionLabel;
    let timerLabel = "Scheduled time";
    let noteText = "";
    if (current.phase === "active" && current.sessionIndex === selectedIndex) {
      timerValue = EventSchedule.formatCountdown(current.remainingMs);
      timerLabel = "Remaining now";
    } else if (current.phase === "before") {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Starts at";
      noteText = "The attendee experience is still in the waiting lobby. You may prepare this run, but only this session's assigned group can enter during its timed rotation.";
    } else if (current.phase === "active" && selectedIndex < current.sessionIndex) {
      timerValue = "Closed";
      timerLabel = "Rotation passed";
      noteText = "You are reviewing an earlier session. Its active and archived run records remain saved and separate.";
    } else if (current.phase === "active" && selectedIndex > current.sessionIndex) {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Upcoming";
      noteText = `Session ${current.session.number} is active now. Session ${selectedSessionNumber} attendees cannot enter until their rotation.`;
    } else if (current.phase === "ended") {
      timerValue = "Closed";
      timerLabel = "Booth time ended";
      noteText = "All booth rotations have ended. Draw Heaven run history remains available until the overall organizer clears event data.";
    }
    timer.innerHTML = `${escapeHtml(timerValue)}<small>${escapeHtml(timerLabel)}</small>`;
    note.textContent = noteText;
    note.style.display = noteText ? "block" : "none";
  }

  function renderSelectedSession() {
    renderTabs();
    const session = sessionByNumber();
    if (!session) {
      stage.innerHTML = `<div class="heaven-empty">This session has not loaded yet.</div>`;
      actions.innerHTML = "";
      return;
    }
    const phase = session.state.phase;
    document.getElementById("heaven-control-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber}`;
    document.getElementById("heaven-run-label").textContent = `Active run ${session.state.runNumber}`;
    const phasePill = document.getElementById("heaven-phase-pill");
    phasePill.textContent = phaseLabel(phase);
    phasePill.className = `heaven-phase-pill ${phase}`;
    const band = document.getElementById("heaven-assigned-band");
    band.innerHTML = `<span class="heaven-band-dot" aria-hidden="true"></span>${escapeHtml(session.assignedColor.label)} wristbands · Session ${session.sessionNumber}`;
    band.style.setProperty("--band-color", bandHex(session.assignedColor.id));
    document.getElementById("heaven-session-time").textContent = session.sessionLabel;
    document.getElementById("heaven-assigned-count").textContent = String(session.assignedCount);
    document.getElementById("heaven-participant-count").textContent = String(session.participantCount);
    document.getElementById("heaven-ready-count").textContent = String(readyCount(session));
    document.getElementById("heaven-completed-count").textContent = String(session.completedCount);
    renderStage(session);
    renderActions(session);
    renderParticipants(session);
    renderArchivedRuns(session);
    restartButton.textContent = phase === "complete" ? "Save run & start another" : "Archive run & start another";
    renderSchedule();
    syncBusyState();
  }

  function syncBusyState() {
    settings.classList.toggle("heaven-loading-state", controlBusy);
    tabs.forEach((tab) => { tab.disabled = controlBusy; });
    actions.querySelectorAll("button").forEach((button) => { button.disabled = controlBusy; });
    refreshButton.disabled = controlBusy;
    restartButton.disabled = controlBusy || !sessionByNumber();
  }

  function formatUpdatedAt(value) {
    if (!value) return "Session controls loaded.";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Session controls loaded.";
    return `Published ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  }

  async function startSharedDemoClock() {
    if (demoClockSyncStarted || typeof EventSchedule === "undefined" || typeof EventSchedule.startDemoClockSync !== "function") return;
    demoClockSyncStarted = true;
    try {
      await EventSchedule.startDemoClockSync(5000);
    } catch (error) {
      console.warn("Demo clock sync unavailable", error);
    }
  }

  async function refresh(options = {}) {
    if (refreshInFlight || controlBusy) return false;
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!organizerKey) return false;
    if (typeof EventAPI === "undefined" || typeof EventAPI.heavenDashboardData !== "function") {
      showSyncNote("The Draw Heaven API is not available on this deployment yet.");
      return false;
    }
    refreshInFlight = true;
    const refreshId = ++activeRefreshId;
    const epoch = requestEpoch;
    const requestStarted = Date.now();
    if (!options.silent) setStatus("Refreshing all three Draw Heaven sessions…");
    try {
      const data = await EventAPI.heavenDashboardData(organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration) || epoch !== requestEpoch) return false;
      if (data && data.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(data.serverNow, requestStarted, Date.now());
      }
      dashboard = normalizeDashboard(data);
      const activeSessionNumber = integer(dashboard.eventState && dashboard.eventState.sessionNumber, 0);
      if (!selectionPinned && activeSessionNumber >= 1 && activeSessionNumber <= SESSION_COUNT) selectedSessionNumber = activeSessionNumber;
      showSyncNote("");
      renderSelectedSession();
      const session = sessionByNumber();
      setStatus(`${formatUpdatedAt(session && session.state.updatedAt)} Attendee screens refresh automatically.`);
      document.getElementById("staff-last-updated").textContent = `All sessions refreshed ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      return true;
    } catch (error) {
      if (!OrganizerAuth.isCurrent(authGeneration) || epoch !== requestEpoch || activeRefreshId !== refreshId) return false;
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return false;
      showSyncNote("Live Draw Heaven updates are temporarily unavailable. Keep this page open and refresh when the connection returns.");
      if (!options.silent) toast("Couldn't refresh Draw Heaven.");
      setStatus("Couldn't refresh. No controls were changed.", "error");
      return false;
    } finally {
      if (activeRefreshId === refreshId) refreshInFlight = false;
    }
  }

  async function advance(action) {
    if (controlBusy) return;
    const session = sessionByNumber();
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!session || !organizerKey) return;
    controlBusy = true;
    requestEpoch += 1;
    activeRefreshId += 1;
    refreshInFlight = false;
    syncBusyState();
    const pendingLabels = {
      start: "Opening the drawing prompt…",
      show_verse: "Revealing Revelation 21:10–11…",
      show_comparison: "Publishing the New Jerusalem comparison…",
      show_impact: "Publishing the meaning reveal…",
      show_programs: "Publishing the five-program preview…",
      finish: "Finishing this shared run…",
    };
    setStatus(pendingLabels[action] || "Updating attendee screens…");
    try {
      await EventAPI.advanceHeavenSession(session.sessionNumber, action, session.state.version, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      const messages = {
        start: "The drawing prompt is live.",
        show_verse: "The verse and confetti reveal are live.",
        show_comparison: "The size comparison is live.",
        show_impact: "The meaning reveal is live.",
        show_programs: "The five-program preview is live.",
        finish: "This Draw Heaven run is complete.",
      };
      toast(messages[action] || "Attendee screens updated.");
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      if (error && (error.status === 409 || /CONFLICT|STALE/.test(String(error.code || "")))) {
        toast("Another leader updated this session. Reloading the latest state.");
        setStatus("Another leader moved the run first. Latest controls are loading…", "error");
      } else {
        toast("Couldn't update attendee screens.");
        setStatus("The control was not published. Check the connection and try again.", "error");
      }
    } finally {
      if (OrganizerAuth.isCurrent(authGeneration)) {
        controlBusy = false;
        syncBusyState();
        await refresh({ silent: true });
      }
    }
  }

  async function restartSelectedRun() {
    if (controlBusy) return;
    const session = sessionByNumber();
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!session || !organizerKey) return;
    const incompleteWarning = session.state.phase === "complete"
      ? ""
      : "\n\nThis run is not finished, so continue only if you intentionally want to close it early.";
    const approved = window.confirm(
      `Archive Draw Heaven Session ${session.sessionNumber}, Run ${session.state.runNumber}, and start Run ${session.state.runNumber + 1}?\n\nAll confirmations and attendee progress stay visible in the previous run. The other two sessions will not change.${incompleteWarning}`
    );
    if (!approved) return;
    controlBusy = true;
    requestEpoch += 1;
    activeRefreshId += 1;
    refreshInFlight = false;
    syncBusyState();
    setStatus(`Archiving Run ${session.state.runNumber} and preparing a fresh welcome screen…`);
    try {
      await EventAPI.resetHeavenSession(
        session.sessionNumber,
        session.state.version,
        organizerKey
      );
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      toast(`Run ${session.state.runNumber} archived. Run ${session.state.runNumber + 1} is ready.`);
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      toast("Couldn't start another Draw Heaven run.");
      setStatus("Nothing changed. Check the connection and try again.", "error");
    } finally {
      if (OrganizerAuth.isCurrent(authGeneration)) {
        controlBusy = false;
        syncBusyState();
        await refresh({ silent: true });
      }
    }
  }

  function selectSession(sessionNumber, pin = true) {
    const next = integer(sessionNumber);
    if (next < 1 || next > SESSION_COUNT || controlBusy) return;
    selectedSessionNumber = next;
    if (pin) selectionPinned = true;
    renderSelectedSession();
  }

  function clearStaffState() {
    requestEpoch += 1;
    dashboard = null;
    controlBusy = false;
    refreshInFlight = false;
    activeRefreshId += 1;
    selectionPinned = false;
    selectedSessionNumber = 1;
    if (refreshTimer) clearInterval(refreshTimer);
    if (scheduleTimer) clearInterval(scheduleTimer);
    refreshTimer = null;
    scheduleTimer = null;
    stage.innerHTML = `<div class="heaven-empty">Unlock Draw Heaven to load the run controls.</div>`;
    actions.innerHTML = "";
    document.querySelector("#heaven-progress-table tbody").innerHTML = `<tr><td colspan="7" class="heaven-empty">Unlock Draw Heaven to load attendee progress.</td></tr>`;
    document.getElementById("heaven-run-history").innerHTML = `<div class="heaven-empty">Unlock Draw Heaven to load prior runs.</div>`;
    document.getElementById("staff-last-updated").textContent = "";
    showSyncNote("");
    setStatus("Unlock Draw Heaven to load the session controls.");
    renderTabs();
    syncBusyState();
  }

  tabs.forEach((tab, tabIndex) => {
    tab.addEventListener("click", () => selectSession(tab.dataset.heavenSession));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = tabIndex;
      if (event.key === "ArrowLeft") nextIndex = (tabIndex + tabs.length - 1) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (tabIndex + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      tabs[nextIndex].focus();
      selectSession(tabs[nextIndex].dataset.heavenSession);
    });
  });
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-heaven-action]");
    if (button) advance(button.dataset.heavenAction);
  });
  refreshButton.addEventListener("click", () => refresh());
  restartButton.addEventListener("click", restartSelectedRun);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && OrganizerAuth.key()) {
      refresh({ silent: true });
      renderSchedule();
    }
  });
  window.addEventListener("focus", () => {
    if (OrganizerAuth.key()) refresh({ silent: true });
  });

  OrganizerAuth.init({
    onUnlocked: async () => {
      await startSharedDemoClock();
      const refreshed = await refresh();
      if (refreshed && OrganizerAuth.key()) {
        if (!refreshTimer) refreshTimer = setInterval(() => {
          if (!document.hidden) refresh({ silent: true });
        }, POLL_INTERVAL_MS);
        if (!scheduleTimer) scheduleTimer = setInterval(renderSchedule, 1000);
      }
    },
    onLocked: clearStaffState,
  });

  clearStaffState();
}
