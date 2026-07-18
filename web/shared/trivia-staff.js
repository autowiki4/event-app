/* Bible Bowl's booth-leader portal is intentionally separate from the
 * generic booth presentation controls. Its versioned sessions keep the
 * speaker in charge of question, reveal, and result timing. Each session can
 * also contain multiple archived runs, so restart never combines or erases
 * an earlier run's leaderboard. */
function initTriviaStaff() {
  document.body.classList.add("has-booth-leader-dock");
  const SESSION_COUNT = typeof ALL_BOOTH_SESSIONS !== "undefined" && Array.isArray(ALL_BOOTH_SESSIONS)
    ? ALL_BOOTH_SESSIONS.length
    : 3;
  const QUESTION_COUNT = 15;
  const POLL_INTERVAL_MS = Math.round(2000 * (0.85 + Math.random() * 0.3));
  const PHASES = new Set(["welcome", "question", "reveal", "complete"]);
  const FALLBACK_BANDS = [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue" },
    { id: "", label: "Selected attendees" },
  ];

  let dashboard = null;
  let selectedSessionNumber = 1;
  let selectionPinned = false;
  let lastActiveSessionNumber = 0;
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

  function applySessionSummary(value) {
    const sessionNumber = integer(value && value.sessionNumber, 0);
    if (!dashboard || sessionNumber < 1 || sessionNumber > SESSION_COUNT) return false;
    const next = normalizedSession(value, sessionNumber);
    dashboard = {
      ...dashboard,
      sessions: dashboard.sessions.map((session) => (
        session.sessionNumber === sessionNumber ? next : session
      )),
    };
    return true;
  }

  function sessionSchedule(sessionNumber = selectedSessionNumber) {
    return typeof ALL_BOOTH_SESSIONS !== "undefined" && Array.isArray(ALL_BOOTH_SESSIONS)
      ? ALL_BOOTH_SESSIONS[sessionNumber - 1] || null
      : null;
  }

  function fallbackBand(sessionNumber = selectedSessionNumber) {
    if (sessionNumber === 3) return FALLBACK_BANDS[2];
    if (typeof EventSchedule !== "undefined" && typeof EventSchedule.groupForBooth === "function") {
      const group = EventSchedule.groupForBooth("trivia", sessionNumber - 1);
      if (group) return group;
    }
    return FALLBACK_BANDS[sessionNumber - 1] || { id: "", label: "Selected attendees" };
  }

  function sessionTitle(sessionNumber) {
    return sessionNumber === 3 ? "Extra booth" : `Session ${sessionNumber}`;
  }

  function audienceLabel(session) {
    if (session.sessionNumber === 3) return "Selected attendees · Extra booth";
    const label = session.assignedColor.label || "Assigned";
    return `${label} wristbands · Session ${session.sessionNumber}`;
  }

  function normalizedArchivedRun(raw, fallbackRunNumber) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      runId: String(source.runId || ""),
      runNumber: Math.max(1, integer(source.runNumber, fallbackRunNumber)),
      phase: safePhase(source.phase),
      questionIndex: integer(source.questionIndex, -1),
      participantCount: Math.max(0, integer(source.participantCount)),
      responseCount: Math.max(0, integer(source.responseCount)),
      startedAt: source.startedAt || null,
      completedAt: source.completedAt || null,
      archivedAt: source.archivedAt || null,
      leaderboard: Array.isArray(source.leaderboard) ? source.leaderboard : [],
    };
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
        runId: String(rawState.runId || source.runId || ""),
        runNumber: Math.max(1, integer(rawState.runNumber, integer(source.runNumber, 1))),
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
      archivedRuns: (Array.isArray(source.archivedRuns) ? source.archivedRuns : [])
        .map((run, index) => normalizedArchivedRun(run, index + 1))
        .sort((a, b) => b.runNumber - a.runNumber),
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
      tab.querySelector("b").textContent = sessionNumber === 3
        ? "Extra booth · Selected attendees"
        : `Session ${sessionNumber} · ${label}`;
      const run = session ? `Run ${session.state.runNumber}` : "";
      tab.querySelector("small").textContent = [time, run, phase].filter(Boolean).join(" · ");
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
      const topThree = session.leaderboard.slice(0, 3);
      stage.innerHTML = `
        <div class="trivia-stage-icon" aria-hidden="true">🎉</div>
        <h3>Run ${session.state.runNumber} results are on attendee screens.</h3>
        <p>This run is finished. Guests can see how many they answered correctly, finish the booth, and return to their timed route. Archive it only after the group is done.</p>
        ${topThree.length ? `<div class="trivia-staff-podium" aria-label="Bible Bowl top three">
          ${topThree.map((entry, index) => `<article><span aria-hidden="true">${index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉"}</span><div><strong>${escapeHtml(entry.name || "Guest")}</strong><small>Raffle #${escapeHtml(entry.raffleNumber || "----")} · ${Math.max(0, integer(entry.correctCount))}/${Math.max(0, integer(entry.totalQuestions, session.questionsRevealed))}</small></div></article>`).join("")}
        </div>` : `<div class="trivia-empty">No ranked scores were recorded in this run.</div>`}
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

  function nextActionButton(id, description, action) {
    return `
      <div class="booth-leader-dock">
        <div class="booth-leader-dock-copy">
          <span>Next on attendee phones</span>
          <strong>${escapeHtml(description)}</strong>
          <small>One tap updates everyone in this session.</small>
        </div>
        <div class="booth-leader-dock-actions">
          <button type="button" class="btn btn-primary" id="${id}" data-trivia-action="${action}" aria-label="Next: ${escapeHtml(description)}">Next →</button>
        </div>
      </div>
    `;
  }

  function liveSessionSwitchTarget() {
    const activeSessionNumber = integer(dashboard && dashboard.eventState && dashboard.eventState.sessionNumber, 0);
    return activeSessionNumber >= 1
      && activeSessionNumber <= SESSION_COUNT
      && activeSessionNumber !== selectedSessionNumber
      ? activeSessionNumber
      : 0;
  }

  function liveSessionSwitchButton(sessionNumber) {
    return `
      <div class="booth-leader-dock">
        <div class="booth-leader-dock-copy">
          <span>Live rotation changed</span>
          <strong>Session ${sessionNumber} is active now</strong>
          <small>Switch sessions and review the next step before publishing anything to attendee phones.</small>
        </div>
        <div class="booth-leader-dock-actions">
          <button type="button" class="btn btn-primary" data-trivia-switch-session="${sessionNumber}" aria-label="Switch to live Session ${sessionNumber}">Switch to Session ${sessionNumber} →</button>
        </div>
      </div>
    `;
  }

  function renderActions(session) {
    const switchTarget = liveSessionSwitchTarget();
    if (switchTarget) {
      actions.innerHTML = liveSessionSwitchButton(switchTarget);
      actions.querySelector("[data-trivia-switch-session]").addEventListener("click", (event) => {
        const sessionNumber = integer(event.currentTarget.dataset.triviaSwitchSession);
        selectSession(sessionNumber, false);
        toast(`Now showing live Session ${sessionNumber}. Review the next step, then tap Next to publish it.`);
      });
      return;
    }
    const phase = session.state.phase;
    if (phase === "welcome") {
      actions.innerHTML = nextActionButton("btn-trivia-start", "Show Question 1", "start");
    } else if (phase === "question") {
      actions.innerHTML = nextActionButton("btn-trivia-reveal", "Reveal the correct answer", "reveal");
    } else if (phase === "reveal") {
      const atLastQuestion = !session.question || session.question.number >= QUESTION_COUNT;
      actions.innerHTML = atLastQuestion
        ? nextActionButton("btn-trivia-finish", "Show the final results", "finish")
        : [
            nextActionButton("btn-trivia-next", "Show the next question", "next"),
            `<div class="booth-leader-secondary-action">${actionButton("btn-trivia-finish", "End game early and show results", "finish", "btn btn-ghost trivia-secondary")}</div>`,
          ].join("");
    } else {
      actions.innerHTML = "";
    }

    actions.querySelectorAll("[data-trivia-action]").forEach((button) => {
      button.addEventListener("click", () => advance(button.dataset.triviaAction));
    });
  }

  function renderLeaderboard(session) {
    document.getElementById("trivia-leaderboard-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber} leaderboard`;
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

  function formatArchiveTime(value) {
    if (!value) return "Saved";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Saved";
    return `Saved ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function archivedLeaderboard(run) {
    if (!run.leaderboard.length) {
      return `<div class="trivia-empty">No answers were recorded in this run.</div>`;
    }
    const rows = run.leaderboard.map((entry, index) => {
      const correctCount = Math.max(0, integer(entry && entry.correctCount));
      const totalQuestions = Math.max(0, integer(entry && entry.totalQuestions));
      return `
        <tr>
          <td class="rank">${Math.max(1, integer(entry && entry.rank, index + 1))}</td>
          <td>${escapeHtml((entry && entry.name) || "Guest")}</td>
          <td class="raffle">#${escapeHtml((entry && entry.raffleNumber) || "----")}</td>
          <td class="score">${totalQuestions > 0 ? `${correctCount}/${totalQuestions}` : "—"}</td>
        </tr>
      `;
    }).join("");
    return `
      <div class="trivia-leaderboard-wrap">
        <table class="dash-table trivia-leaderboard">
          <thead><tr><th>#</th><th>Attendee</th><th>Raffle</th><th>Correct</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderArchivedRuns(session) {
    const target = document.getElementById("trivia-archive-list");
    if (!target) return;
    if (!session.archivedRuns.length) {
      target.innerHTML = `<div class="trivia-empty">No previous runs have been archived for Session ${session.sessionNumber}.</div>`;
      return;
    }
    target.innerHTML = session.archivedRuns.map((run) => `
      <details class="trivia-archive-run">
        <summary>
          <span>Run ${run.runNumber} · ${escapeHtml(phaseLabel(run.phase))}</span>
          <span class="trivia-archive-meta">${run.participantCount} ${run.participantCount === 1 ? "player" : "players"} · ${escapeHtml(formatArchiveTime(run.archivedAt))}</span>
        </summary>
        <div class="trivia-archive-body">${archivedLeaderboard(run)}</div>
      </details>
    `).join("");
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
    document.getElementById("trivia-control-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber}`;
    const phasePill = document.getElementById("trivia-phase-pill");
    phasePill.textContent = phaseLabel(phase);
    phasePill.className = `trivia-phase-pill ${phase}`;
    const bandTarget = document.getElementById("trivia-assigned-band");
    bandTarget.innerHTML = `<span class="trivia-band-dot" aria-hidden="true"></span>${escapeHtml(audienceLabel(session))}`;
    bandTarget.style.setProperty("--band-color", bandHex(session.assignedColor.id));
    document.getElementById("trivia-session-time").textContent = session.sessionLabel;
    document.getElementById("staff-total").textContent = String(session.responseCount);
    document.getElementById("trivia-assigned-count").textContent = String(session.assignedCount);
    document.getElementById("trivia-revealed-count").textContent = String(session.questionsRevealed);
    renderQuestion(session);
    renderActions(session);
    renderLeaderboard(session);
    renderArchivedRuns(session);
    resetButton.textContent = session.state.phase === "complete"
      ? "Save this run & start another"
      : "Archive run & start another";
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
    let timerValue = session.sessionLabel;
    let timerLabel = "Scheduled time";
    let noteText = "";
    const boothSessionActive = current.phase === "active" || current.phase === "extra";
    const currentSessionNumber = current.session ? integer(current.session.number) : 0;
    if (boothSessionActive && currentSessionNumber === selectedSessionNumber) {
      timerValue = EventSchedule.formatCountdown(current.remainingMs);
      timerLabel = "Remaining now";
    } else if (current.phase === "before") {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Starts at";
      noteText = `The event is in the waiting lobby. Session ${selectedSessionNumber} controls are saved, but only its assigned group can enter during that timed rotation.`;
    } else if (boothSessionActive && selectedSessionNumber < currentSessionNumber) {
      timerValue = "Closed";
      timerLabel = "Rotation passed";
      noteText = `You are reviewing an earlier session. Its current and archived run leaderboards remain separate and saved.`;
    } else if (boothSessionActive && selectedSessionNumber > currentSessionNumber) {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Upcoming";
      noteText = `${sessionTitle(currentSessionNumber)} is active now. You are preparing ${sessionTitle(selectedSessionNumber)}; attendees will not enter this room until its timed window.`;
    } else if (current.phase === "message") {
      timerValue = selectedSessionNumber === 3
        ? EventSchedule.formattedTime(schedule.startsAt)
        : "Closed";
      timerLabel = selectedSessionNumber === 3 ? "Upcoming" : "Rotation passed";
      noteText = selectedSessionNumber === 3
        ? "The main message is in progress. Attendees may enter this extra booth after selecting it at 4:50 PM."
        : "The main message is in progress. This session's leaderboard remains saved for review.";
    } else if (current.phase === "connections" || current.phase === "ended") {
      timerValue = "Closed";
      timerLabel = "Booth time ended";
      noteText = "All booth sessions have ended. The session leaderboard remains available until an organizer resets event data.";
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
    return `Phones updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
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
    if (!(options && options.silent)) setStatus("Refreshing all booth sessions…");
    try {
      const data = await EventAPI.triviaDashboardData(organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration) || epoch !== requestEpoch) return false;
      if (data && data.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(data.serverNow, requestStarted, Date.now());
      }
      dashboard = normalizeDashboard(data);
      const activeSessionNumber = integer(dashboard.eventState && dashboard.eventState.sessionNumber, 0);
      if (
        activeSessionNumber >= 1
          && activeSessionNumber <= SESSION_COUNT
          && (!selectionPinned || activeSessionNumber !== lastActiveSessionNumber)
      ) {
        selectedSessionNumber = activeSessionNumber;
        selectionPinned = false;
      }
      lastActiveSessionNumber = activeSessionNumber;
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
    const activeSessionNumber = integer(dashboard && dashboard.eventState && dashboard.eventState.sessionNumber, 0);
    if (activeSessionNumber >= 1 && activeSessionNumber <= SESSION_COUNT && activeSessionNumber !== selectedSessionNumber) {
      selectedSessionNumber = activeSessionNumber;
      selectionPinned = false;
      renderSelectedSession();
      toast(`No attendee screen changed. Session ${activeSessionNumber} became live, so controls switched there; review the next step, then tap Next.`);
      return;
    }
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
      const result = await EventAPI.advanceTriviaSession(session.sessionNumber, action, session.state.version, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      applySessionSummary(result);
      renderSelectedSession();
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
      `Archive Bible Bowl ${sessionTitle(session.sessionNumber)}, Run ${session.state.runNumber}, and start Run ${session.state.runNumber + 1}?\n\nThe current answers and leaderboard will stay saved under the previous run. The other sessions will not change.${session.state.phase === "complete" ? "" : "\n\nThis run is not finished yet, so only continue if you intentionally want to close it early."}`
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
    setStatus(`Saving Run ${session.state.runNumber} and preparing the next run…`);
    try {
      await EventAPI.resetTriviaSession(
        session.sessionNumber,
        session.state.version,
        organizerKey
      );
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      toast(`Run ${session.state.runNumber} saved. Run ${session.state.runNumber + 1} is ready.`);
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      toast("Couldn't start another Bible Bowl run.");
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
    lastActiveSessionNumber = 0;
    selectedSessionNumber = 1;
    if (refreshTimer) clearInterval(refreshTimer);
    if (scheduleTimer) clearInterval(scheduleTimer);
    refreshTimer = null;
    scheduleTimer = null;
    stage.innerHTML = `<div class="trivia-empty">Unlock Bible Bowl to load the session controls.</div>`;
    actions.innerHTML = "";
    document.querySelector("#trivia-leaderboard tbody").innerHTML = `<tr><td colspan="4" class="trivia-empty">Unlock Bible Bowl to load the leaderboards.</td></tr>`;
    const archiveList = document.getElementById("trivia-archive-list");
    if (archiveList) archiveList.innerHTML = `<div class="trivia-empty">Unlock Bible Bowl to load saved runs.</div>`;
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
      await refresh();
      if (OrganizerAuth.key()) {
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
