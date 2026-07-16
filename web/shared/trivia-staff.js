/* Bible Bowl's booth-leader portal is intentionally separate from the
 * generic booth presentation controls. Its three versioned sessions keep the
 * speaker in charge of question, reveal, and result timing while preserving a
 * separate leaderboard for each wristband rotation. */
function initTriviaStaff() {
  const SESSION_COUNT = 3;
  const QUESTION_COUNT = 15;
  const POLL_INTERVAL_MS = Math.round(2000 * (0.85 + Math.random() * 0.3));
  const PHASES = new Set(["welcome", "question", "reveal", "complete"]);
  const FALLBACK_BANDS = [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue" },
    { id: "yellow", label: "Yellow" },
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

  const tabs = Array.from(document.querySelectorAll("[data-session-number]"));
  const settings = document.getElementById("staff-settings");
  const stage = document.getElementById("trivia-stage");
  const actions = document.getElementById("trivia-actions");
  const refreshButton = document.getElementById("btn-trivia-refresh");
  const resetButton = document.getElementById("btn-trivia-reset");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function integer(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
  }

  function safePhase(value) {
    const phase = String(value || "").trim().toLowerCase();
    return PHASES.has(phase) ? phase : "welcome";
  }

  function sessionByNumber(sessionNumber = selectedSessionNumber) {
    const sessions = dashboard && Array.isArray(dashboard.sessions) ? dashboard.sessions : [];
    return sessions.find((session) => integer(session && session.sessionNumber, -1) === sessionNumber) || null;
  }

  function sessionSchedule(sessionNumber = selectedSessionNumber) {
    return typeof BOOTH_SESSIONS !== "undefined" && Array.isArray(BOOTH_SESSIONS)
      ? BOOTH_SESSIONS[sessionNumber - 1] || null
      : null;
  }

  function fallbackBand(sessionNumber = selectedSessionNumber) {
    if (typeof EventSchedule !== "undefined" && typeof EventSchedule.groupForBooth === "function") {
      const group = EventSchedule.groupForBooth("trivia", sessionNumber - 1);
      if (group) return group;
    }
    return FALLBACK_BANDS[sessionNumber - 1] || { id: "", label: "Assigned" };
  }

  function normalizedSession(raw, sessionNumber) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawState = source.state && typeof source.state === "object" ? source.state : {};
    const question = source.question && typeof source.question === "object" ? source.question : null;
    const assignedColor = source.assignedColor && typeof source.assignedColor === "object"
      ? source.assignedColor
      : fallbackBand(sessionNumber);
    return {
      sessionNumber,
      sessionLabel: String(source.sessionLabel || (sessionSchedule(sessionNumber) || {}).label || `Session ${sessionNumber}`),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || "Assigned"),
      },
      assignedCount: Math.max(0, integer(source.assignedCount)),
      state: {
        phase: safePhase(rawState.phase),
        questionIndex: integer(rawState.questionIndex, -1),
        version: Math.max(0, integer(rawState.version)),
        startedAt: rawState.startedAt || null,
        updatedAt: rawState.updatedAt || null,
        completedAt: rawState.completedAt || null,
      },
      question: question ? {
        id: String(question.id || ""),
        number: Math.max(1, integer(question.number, integer(rawState.questionIndex, 0) + 1)),
        category: String(question.category || "Bible Bowl"),
        text: String(question.text || question.q || ""),
        choices: Array.isArray(question.choices) ? question.choices.map(String) : [],
        correctIndex: integer(question.correctIndex, -1),
        correctText: String(question.correctText || ""),
      } : null,
      responseCount: Math.max(0, integer(source.responseCount)),
      questionsRevealed: Math.max(0, integer(source.questionsRevealed)),
      leaderboard: Array.isArray(source.leaderboard) ? source.leaderboard : [],
    };
  }

  function normalizeDashboard(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const incoming = Array.isArray(source.sessions) ? source.sessions : [];
    const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => {
      const sessionNumber = index + 1;
      const match = incoming.find((session) => integer(session && session.sessionNumber, -1) === sessionNumber);
      return normalizedSession(match, sessionNumber);
    });
    return {
      serverNow: source.serverNow || null,
      eventState: source.eventState && typeof source.eventState === "object" ? source.eventState : null,
      sessions,
    };
  }

  function phaseLabel(phase) {
    return ({ welcome: "Welcome", question: "Question open", reveal: "Answer revealed", complete: "Results shown" })[phase] || "Welcome";
  }

  function bandHex(colorId) {
    if (typeof wristbandColorById === "function") {
      const color = wristbandColorById(colorId);
      if (color && color.hex) return color.hex;
    }
    return ({ red: "#D94A43", blue: "#2F6FED", yellow: "#E5B72F" })[colorId] || "#8b97b8";
  }

  function setStatus(message, kind = "") {
    const target = document.getElementById("trivia-publish-state");
    target.textContent = message || "";
    target.style.color = kind === "error" ? "var(--coral-deep)" : "var(--ink-soft)";
  }

  function showSyncNote(message) {
    const note = document.getElementById("trivia-sync-note");
    note.textContent = message || "";
    note.style.display = message ? "block" : "none";
  }

  function renderTabs() {
    tabs.forEach((tab) => {
      const sessionNumber = integer(tab.dataset.sessionNumber);
      const selected = sessionNumber === selectedSessionNumber;
      const session = sessionByNumber(sessionNumber);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const label = session ? session.assignedColor.label : fallbackBand(sessionNumber).label;
      const phase = session ? phaseLabel(session.state.phase) : "Loading";
      const time = session ? session.sessionLabel : (sessionSchedule(sessionNumber) || {}).label || "";
      tab.querySelector("b").textContent = `Session ${sessionNumber} · ${label}`;
      tab.querySelector("small").textContent = `${time} · ${phase}`;
    });
    const panel = document.getElementById("trivia-session-panel");
    panel.setAttribute("aria-labelledby", `trivia-tab-${selectedSessionNumber}`);
  }

  function renderQuestion(session) {
    const phase = session.state.phase;
    const question = session.question;
    if (phase === "welcome") {
      stage.innerHTML = `
        <div class="trivia-stage-icon" aria-hidden="true">👋</div>
        <h3>Welcome to Bible Bowl!</h3>
        <p>Attendee screens are holding on the welcome message. When the speaker and the room are ready, start Question 1 below.</p>
      `;
      return;
    }
    if (phase === "complete") {
      stage.innerHTML = `
        <div class="trivia-stage-icon" aria-hidden="true">🎉</div>
        <h3>Results are on attendee screens.</h3>
        <p>This session is finished. Guests can see how many they answered correctly, finish the booth, and return to their timed route.</p>
      `;
      return;
    }
    if (!question) {
      stage.innerHTML = `
        <div class="trivia-stage-icon" aria-hidden="true">⏳</div>
        <h3>Loading the current question…</h3>
        <p>Refresh this screen before advancing if the question does not appear.</p>
      `;
      return;
    }

    const showAnswer = phase === "reveal";
    const correctIndex = question.correctIndex;
    const choices = question.choices.map((choice, index) => `
      <div class="trivia-choice${showAnswer && index === correctIndex ? " correct" : ""}">
        <span class="trivia-choice-key">${String.fromCharCode(65 + index)}</span>
        <span>${escapeHtml(choice)}</span>
      </div>
    `).join("");
    const correctText = question.correctText || question.choices[correctIndex] || "";
    stage.innerHTML = `
      <div class="trivia-question-meta">Question ${question.number} of ${QUESTION_COUNT} · ${escapeHtml(question.category)}</div>
      <h3>${escapeHtml(question.text)}</h3>
      <p>${showAnswer
        ? "The correct answer is now visible on every attendee screen."
        : "Attendees may choose one answer. Their choice locks while they wait for your reveal."}</p>
      <div class="trivia-choice-list">${choices}</div>
      ${showAnswer && correctText ? `<div class="trivia-answer-note">Correct answer: ${escapeHtml(correctText)}</div>` : ""}
    `;
  }

  function actionButton(id, label, action, className = "btn btn-primary") {
    return `<button type="button" class="${className}" id="${id}" data-trivia-action="${action}">${escapeHtml(label)}</button>`;
  }

  function renderActions(session) {
    const phase = session.state.phase;
    if (phase === "welcome") {
      actions.innerHTML = actionButton("btn-trivia-start", "Start Question 1 →", "start");
    } else if (phase === "question") {
      actions.innerHTML = actionButton("btn-trivia-reveal", "Next: reveal the correct answer →", "reveal");
    } else if (phase === "reveal") {
      const atLastQuestion = !session.question || session.question.number >= QUESTION_COUNT;
      actions.innerHTML = atLastQuestion
        ? actionButton("btn-trivia-finish", "Show final results →", "finish")
        : [
            actionButton("btn-trivia-next", "Open the next question →", "next"),
            actionButton("btn-trivia-finish", "End here and show results", "finish", "btn btn-ghost trivia-secondary"),
          ].join("");
    } else {
      actions.innerHTML = "";
    }

    actions.querySelectorAll("[data-trivia-action]").forEach((button) => {
      button.addEventListener("click", () => advance(button.dataset.triviaAction));
    });
  }

  function renderLeaderboard(session) {
    document.getElementById("trivia-leaderboard-title").textContent = `Session ${session.sessionNumber} leaderboard`;
    const body = document.querySelector("#trivia-leaderboard tbody");
    if (!session.leaderboard.length) {
      body.innerHTML = `<tr><td colspan="4" class="trivia-empty">No answers in Session ${session.sessionNumber} yet. This leaderboard stays separate from the other rotations.</td></tr>`;
      return;
    }
    body.innerHTML = session.leaderboard.map((entry, index) => {
      const correctCount = Math.max(0, integer(entry && entry.correctCount));
      const totalQuestions = Math.max(0, integer(entry && entry.totalQuestions, session.questionsRevealed));
      const score = totalQuestions > 0 ? `${correctCount}/${totalQuestions}` : "—";
      return `
        <tr>
          <td class="rank">${Math.max(1, integer(entry && entry.rank, index + 1))}</td>
          <td>${escapeHtml((entry && entry.name) || "Guest")}</td>
          <td class="raffle">#${escapeHtml((entry && entry.raffleNumber) || "----")}</td>
          <td class="score">${score}</td>
        </tr>
      `;
    }).join("");
  }

  function renderSelectedSession() {
    renderTabs();
    const session = sessionByNumber();
    if (!session) {
      stage.innerHTML = `<div class="trivia-empty">This session has not loaded yet.</div>`;
      actions.innerHTML = "";
      return;
    }

    const phase = session.state.phase;
    document.getElementById("trivia-control-title").textContent = `Session ${session.sessionNumber}`;
    const phasePill = document.getElementById("trivia-phase-pill");
    phasePill.textContent = phaseLabel(phase);
    phasePill.className = `trivia-phase-pill ${phase}`;
    const bandLabel = session.assignedColor.label || "Assigned";
    const bandTarget = document.getElementById("trivia-assigned-band");
    bandTarget.innerHTML = `<span class="trivia-band-dot" aria-hidden="true"></span>${escapeHtml(bandLabel)} wristbands · Session ${session.sessionNumber}`;
    bandTarget.style.setProperty("--band-color", bandHex(session.assignedColor.id));
    document.getElementById("trivia-session-time").textContent = session.sessionLabel;
    document.getElementById("staff-total").textContent = String(session.responseCount);
    document.getElementById("trivia-assigned-count").textContent = String(session.assignedCount);
    document.getElementById("trivia-revealed-count").textContent = String(session.questionsRevealed);
    renderQuestion(session);
    renderActions(session);
    renderLeaderboard(session);
    renderSchedule();
    syncBusyState();
  }

  function renderSchedule() {
    const session = sessionByNumber();
    const schedule = sessionSchedule();
    const timer = document.getElementById("trivia-session-timer");
    const note = document.getElementById("trivia-session-note");
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
      noteText = `The event is in the waiting lobby. Session ${selectedSessionNumber} controls are saved, but only its assigned group can enter during that timed rotation.`;
    } else if (current.phase === "active" && selectedIndex < current.sessionIndex) {
      timerValue = "Closed";
      timerLabel = "Rotation passed";
      noteText = `You are reviewing an earlier session. Its leaderboard remains separate; reset it only if you intentionally want to erase that session's game and answers.`;
    } else if (current.phase === "active" && selectedIndex > current.sessionIndex) {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Upcoming";
      noteText = `Session ${current.session.number} is active now. You are preparing Session ${selectedSessionNumber}; attendees will not enter this room until their timed rotation.`;
    } else if (current.phase === "ended") {
      timerValue = "Closed";
      timerLabel = "Booth time ended";
      noteText = "All booth rotations have ended. The session leaderboard remains available until an organizer resets event data.";
    }
    timer.innerHTML = `${escapeHtml(timerValue)}<small>${escapeHtml(timerLabel)}</small>`;
    note.textContent = noteText;
    note.style.display = noteText ? "block" : "none";
  }

  function syncBusyState() {
    const busy = controlBusy;
    settings.classList.toggle("trivia-loading", busy);
    tabs.forEach((tab) => { tab.disabled = busy; });
    actions.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
    refreshButton.disabled = busy;
    resetButton.disabled = busy || !sessionByNumber();
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
    if (typeof EventAPI === "undefined" || typeof EventAPI.triviaDashboardData !== "function") {
      showSyncNote("The Bible Bowl API is not available on this deployment yet.");
      return false;
    }

    refreshInFlight = true;
    const refreshId = ++activeRefreshId;
    const epoch = requestEpoch;
    const requestStarted = Date.now();
    if (!(options && options.silent)) setStatus("Refreshing all three sessions…");
    try {
      const data = await EventAPI.triviaDashboardData(organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration) || epoch !== requestEpoch) return false;
      if (data && data.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(data.serverNow, requestStarted, Date.now());
      }
      dashboard = normalizeDashboard(data);
      const activeSessionNumber = integer(dashboard.eventState && dashboard.eventState.sessionNumber, 0);
      if (!selectionPinned && activeSessionNumber >= 1 && activeSessionNumber <= SESSION_COUNT) {
        selectedSessionNumber = activeSessionNumber;
      }
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
      showSyncNote("Live Bible Bowl updates are temporarily unavailable. Keep this page open and refresh when the connection returns.");
      if (!(options && options.silent)) toast("Couldn't refresh Bible Bowl.");
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
    if (typeof EventAPI === "undefined" || typeof EventAPI.advanceTriviaSession !== "function") {
      showSyncNote("The Bible Bowl control API is not available on this deployment yet.");
      return;
    }

    controlBusy = true;
    requestEpoch += 1;
    activeRefreshId += 1;
    refreshInFlight = false;
    syncBusyState();
    const labels = { start: "Starting Question 1…", reveal: "Revealing the answer…", next: "Opening the next question…", finish: "Showing final results…" };
    setStatus(labels[action] || "Updating attendee screens…");
    try {
      await EventAPI.advanceTriviaSession(session.sessionNumber, action, session.state.version, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      toast(({ start: "Question 1 is live.", reveal: "Answer revealed.", next: "Next question is live.", finish: "Final results are live." })[action] || "Attendee screens updated.");
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      if (error && (error.status === 409 || /CONFLICT|STALE/.test(String(error.code || "")))) {
        toast("Another leader updated this session. Reloading the latest state.");
        setStatus("Another leader moved the session first. Latest controls are loading…", "error");
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

  async function resetSelectedSession() {
    if (controlBusy) return;
    const session = sessionByNumber();
    const authGeneration = OrganizerAuth.generation();
    const organizerKey = OrganizerAuth.key();
    if (!session || !organizerKey) return;
    const approved = window.confirm(
      `Reset Bible Bowl Session ${session.sessionNumber}?\n\nThis permanently returns that session to its welcome screen and erases only Session ${session.sessionNumber}'s answers and leaderboard. The other two sessions will not change.`
    );
    if (!approved) return;
    if (typeof EventAPI === "undefined" || typeof EventAPI.resetTriviaSession !== "function") {
      showSyncNote("The Bible Bowl reset API is not available on this deployment yet.");
      return;
    }

    controlBusy = true;
    requestEpoch += 1;
    activeRefreshId += 1;
    refreshInFlight = false;
    syncBusyState();
    setStatus(`Resetting Session ${session.sessionNumber}…`);
    try {
      await EventAPI.resetTriviaSession(session.sessionNumber, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      toast(`Session ${session.sessionNumber} reset.`);
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      toast("Couldn't reset this Bible Bowl session.");
      setStatus("Nothing was erased. Check the connection and try again.", "error");
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
    stage.innerHTML = `<div class="trivia-empty">Unlock Bible Bowl to load the session controls.</div>`;
    actions.innerHTML = "";
    document.querySelector("#trivia-leaderboard tbody").innerHTML = `<tr><td colspan="4" class="trivia-empty">Unlock Bible Bowl to load the leaderboards.</td></tr>`;
    document.getElementById("staff-last-updated").textContent = "";
    showSyncNote("");
    setStatus("Unlock Bible Bowl to load the session controls.");
    renderTabs();
    syncBusyState();
  }

  tabs.forEach((tab, tabIndex) => {
    tab.addEventListener("click", () => selectSession(tab.dataset.sessionNumber));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = tabIndex;
      if (event.key === "ArrowLeft") nextIndex = (tabIndex + tabs.length - 1) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (tabIndex + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      tabs[nextIndex].focus();
      selectSession(tabs[nextIndex].dataset.sessionNumber);
    });
  });
  refreshButton.addEventListener("click", () => refresh());
  resetButton.addEventListener("click", resetSelectedSession);
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

// Preserve the existing staff-page initializer contract while giving Bible
// Bowl its specialized controller. This page does not load booth-staff-common.
function initBoothStaff(boothId) {
  if (boothId !== "trivia") throw new Error("The Bible Bowl controller only supports the trivia booth.");
  initTriviaStaff();
}
