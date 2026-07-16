/* Dedicated New Song booth-leader controller.
 *
 * Every timed rotation has its own versioned run, vote graph, frozen result,
 * participant list, and archive. The leader moves all attendee screens through
 * welcome -> voting -> winner -> verse -> complete.
 */
function initNewSongStaff() {
  const SESSION_COUNT = 3;
  const POLL_INTERVAL_MS = Math.round(2000 * (0.85 + Math.random() * 0.3));
  const PHASES = new Set(["welcome", "voting", "winner", "verse", "complete"]);
  const SONGS = [
    "God in Me",
    "He Turned It",
    "Victory",
    "Brighter Day",
    "Praise — Elevation Worship",
    "Jireh",
    "I Thank God — Maverick City",
    "Amen — Madison Ryann Ward",
    "Quick — Caleb Gordon",
    "Goodbye Yesterday — Elevation Rhythm",
  ];
  const FALLBACK_BANDS = [
    { id: "green", label: "Green" },
    { id: "yellow", label: "Yellow" },
    { id: "orange", label: "Orange" },
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

  const tabs = Array.from(document.querySelectorAll("[data-newsong-session]"));
  const settings = document.getElementById("staff-settings");
  const stage = document.getElementById("newsong-stage");
  const actions = document.getElementById("newsong-actions");
  const refreshButton = document.getElementById("btn-newsong-refresh");
  const restartButton = document.getElementById("btn-newsong-restart");

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

  function canonicalTitle(value) {
    const title = String(value || "");
    return SONGS.includes(title) ? title : "";
  }

  function normalizeVote(value) {
    if (typeof value === "string") {
      const songTitle = canonicalTitle(value);
      return songTitle ? { songTitle, votedAt: null } : null;
    }
    const source = object(value);
    const songTitle = canonicalTitle(source.songTitle || source.title);
    return songTitle ? { songTitle, votedAt: source.votedAt || null } : null;
  }

  function normalizeParticipant(value) {
    const source = object(value);
    const vote = normalizeVote(source.vote || source.songTitle || source.title);
    return {
      attendeeId: String(source.attendeeId || ""),
      name: String(source.name || "Guest"),
      raffleNumber: String(source.raffleNumber || ""),
      vote,
      completedAt: source.completedAt || null,
    };
  }

  function normalizeVoteCounts(value) {
    const counts = Object.fromEntries(SONGS.map((title) => [title, 0]));
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        const source = object(entry);
        const title = canonicalTitle(source.title || source.songTitle);
        if (title) counts[title] = Math.max(0, integer(source.votes, integer(source.count)));
      });
    } else {
      const source = object(value);
      SONGS.forEach((title) => { counts[title] = Math.max(0, integer(source[title])); });
    }
    return SONGS.map((title) => ({ title, votes: counts[title] }));
  }

  function normalizeResult(value, winnerValue) {
    const source = object(value);
    const winner = object(winnerValue);
    const tiedTitles = (Array.isArray(source.tiedTitles) ? source.tiedTitles : winner.tiedSongs || [])
      .map(canonicalTitle)
      .filter(Boolean);
    const featuredWinner = canonicalTitle(source.featuredWinner || winner.songTitle);
    if (!featuredWinner && !tiedTitles.length) return null;
    return {
      totalVotes: Math.max(0, integer(source.totalVotes)),
      maxVotes: Math.max(0, integer(source.maxVotes, integer(winner.voteCount))),
      isTie: Boolean(source.isTie || winner.tied || tiedTitles.length > 1),
      tiedTitles: tiedTitles.length ? tiedTitles : featuredWinner ? [featuredWinner] : [],
      featuredWinner,
      tieBreakRule: String(source.tieBreakRule || ""),
    };
  }

  function normalizeRun(value, fallbackRunNumber = 1) {
    const source = object(value);
    const participants = (Array.isArray(source.participants)
      ? source.participants
      : Array.isArray(source.voters) ? source.voters : []).map(normalizeParticipant);
    const voteCounts = normalizeVoteCounts(source.voteCounts || source.songCounts);
    const totalVotes = Math.max(
      0,
      integer(source.totalVotes, voteCounts.reduce((sum, entry) => sum + entry.votes, 0))
    );
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
      participantCount: Math.max(0, integer(source.participantCount, participants.length)),
      totalVotes,
      voteCounts,
      result: normalizeResult(source.result, source.winner),
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
      const group = EventSchedule.groupForBooth("newsong", sessionNumber - 1);
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
      participantCount: source.participantCount ?? rawState.participantCount,
      totalVotes: source.totalVotes ?? rawState.totalVotes,
      voteCounts: source.voteCounts || source.songCounts || rawState.voteCounts || rawState.songCounts,
      result: source.result || rawState.result,
      winner: source.winner || rawState.winner,
      participants: source.participants || source.voters || rawState.participants || rawState.voters,
    });
    return {
      sessionNumber,
      sessionLabel: String(source.sessionLabel || (sessionSchedule(sessionNumber) || {}).label || `Session ${sessionNumber}`),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || "Assigned"),
      },
      assignedCount: Math.max(0, integer(source.assignedCount)),
      state,
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

  function phaseLabel(value) {
    return ({ welcome: "Welcome", voting: "Voting live", winner: "Winner revealed", verse: "Revelation 14:3", complete: "Complete" })[value] || "Welcome";
  }

  function bandHex(colorId) {
    const fallback = { green: "#2f8a57", yellow: "#e5b72f", orange: "#e88724" };
    if (typeof wristbandColorById === "function") {
      const color = wristbandColorById(colorId);
      if (color && color.hex) return color.hex;
    }
    return fallback[colorId] || "#4f9ed7";
  }

  function renderTabs() {
    tabs.forEach((tab) => {
      const selected = integer(tab.dataset.newsongSession) === selectedSessionNumber;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
    });
    const panel = document.getElementById("newsong-session-panel");
    if (panel) panel.setAttribute("aria-labelledby", `newsong-tab-${selectedSessionNumber}`);
  }

  function resultMarkup(result, compact = false) {
    if (!result) return `<div class="newsong-result-empty">No result has been frozen yet.</div>`;
    if (result.isTie) {
      return `
        <div class="newsong-result-card tie${compact ? " compact" : ""}">
          <span class="newsong-result-icon" aria-hidden="true">⚖️</span>
          <div><small>Tie · ${result.maxVotes} ${result.maxVotes === 1 ? "vote" : "votes"} each</small><strong>${result.tiedTitles.map(escapeHtml).join(" · ")}</strong>
          <p>Featured first: <b>${escapeHtml(result.featuredWinner)}</b>${result.tieBreakRule ? ` · ${escapeHtml(result.tieBreakRule)}` : " · canonical song-order tiebreak"}</p></div>
        </div>
      `;
    }
    return `
      <div class="newsong-result-card${compact ? " compact" : ""}">
        <span class="newsong-result-icon" aria-hidden="true">🏆</span>
        <div><small>Winning song · ${result.maxVotes} ${result.maxVotes === 1 ? "vote" : "votes"}</small><strong>${escapeHtml(result.featuredWinner)}</strong><p>${result.totalVotes} total ${result.totalVotes === 1 ? "vote" : "votes"} in this run</p></div>
      </div>
    `;
  }

  function renderStage(session) {
    const phase = session.state.phase;
    if (phase === "welcome") {
      stage.innerHTML = `
        <div class="newsong-stage-icon" aria-hidden="true">☁️</div>
        <h3>Attendees see the New Song welcome lobby.</h3>
        <p>When the room is settled, open the ten-song ballot for this session only.</p>
      `;
    } else if (phase === "voting") {
      stage.innerHTML = `
        <div class="newsong-stage-icon live" aria-hidden="true">🎧</div>
        <h3>Voting is live for Run ${session.state.runNumber}.</h3>
        <p>Each attendee's first successful choice is locked. Watch the graph and wait until the speaker is ready before freezing the result.</p>
      `;
    } else if (phase === "winner") {
      stage.innerHTML = `
        <div class="newsong-stage-icon gold" aria-hidden="true">♛</div>
        <h3>The room's result is frozen.</h3>
        <p>Every attendee now sees the same winner or full tie. Continue when the speaker is ready to connect it to Revelation 14:3.</p>
        ${resultMarkup(session.state.result)}
      `;
    } else if (phase === "verse") {
      stage.innerHTML = `
        <div class="newsong-stage-icon verse" aria-hidden="true">📖</div>
        <h3>Revelation 14:3 is on attendee screens.</h3>
        <p>Lead the shared reflection, then finish only when guests are ready to save the booth and return to their routes.</p>
        <blockquote>“And they sung as it were a new song before the throne, and before the four beasts, and the elders: and no man could learn that song but the hundred and forty and four thousand, which were redeemed from the earth.” — Revelation 14:3</blockquote>
      `;
    } else {
      stage.innerHTML = `
        <div class="newsong-stage-icon complete" aria-hidden="true">✓</div>
        <h3>Run ${session.state.runNumber} is complete.</h3>
        <p>The Done button is live. Attendees can save this visit and return to the timed route. Archive only after this group has cleared the booth.</p>
        ${resultMarkup(session.state.result)}
      `;
    }
  }

  function actionButton(id, label, action, secondary = false) {
    return `<button type="button" class="btn ${secondary ? "btn-ghost" : "btn-primary"}" id="${id}" data-newsong-action="${action}">${escapeHtml(label)}</button>`;
  }

  function renderActions(session) {
    const phase = session.state.phase;
    if (phase === "welcome") actions.innerHTML = actionButton("btn-newsong-start", "Open voting for everyone →", "start");
    else if (phase === "voting") actions.innerHTML = actionButton("btn-newsong-winner", "Close voting & reveal the result →", "show_winner");
    else if (phase === "winner") actions.innerHTML = actionButton("btn-newsong-verse", "Reveal Revelation 14:3 →", "show_verse");
    else if (phase === "verse") actions.innerHTML = actionButton("btn-newsong-finish", "Finish this shared run →", "finish");
    else actions.innerHTML = `<p class="newsong-finished-note">This run is complete. Start another run only when you intentionally want a fresh welcome screen for this same session.</p>`;
  }

  function liveLeaders(session) {
    const counts = session.state.voteCounts;
    const maxVotes = counts.reduce((maximum, entry) => Math.max(maximum, entry.votes), 0);
    return {
      maxVotes,
      titles: maxVotes > 0 ? counts.filter((entry) => entry.votes === maxVotes).map((entry) => entry.title) : [],
    };
  }

  function chartMarkup(counts, result = null, compact = false) {
    const maximum = Math.max(1, ...counts.map((entry) => entry.votes));
    const leaderTitles = result && result.tiedTitles.length
      ? result.tiedTitles
      : counts.filter((entry) => entry.votes > 0 && entry.votes === maximum).map((entry) => entry.title);
    return `<div class="newsong-chart${compact ? " compact" : ""}">${counts.map((entry, index) => {
      const width = entry.votes > 0 ? Math.max(4, (entry.votes / maximum) * 100) : 0;
      const leader = leaderTitles.includes(entry.title);
      return `
        <div class="newsong-chart-row${leader ? " leader" : ""}">
          <span class="newsong-chart-rank">${index + 1}</span>
          <span class="newsong-chart-title">${escapeHtml(entry.title)}</span>
          <span class="newsong-chart-track"><i style="width:${width}%"></i></span>
          <b>${entry.votes}</b>
        </div>
      `;
    }).join("")}</div>`;
  }

  function renderVoteGraph(session) {
    const note = document.getElementById("newsong-tie-note");
    const result = session.state.result;
    const leaders = liveLeaders(session);
    if (result && result.isTie) {
      note.textContent = `Frozen tie: ${result.tiedTitles.join(" · ")} (${result.maxVotes} each). Featured first: ${result.featuredWinner}.`;
      note.className = "newsong-tie-note tie";
    } else if (result) {
      note.textContent = `Frozen winner: ${result.featuredWinner} with ${result.maxVotes} ${result.maxVotes === 1 ? "vote" : "votes"}.`;
      note.className = "newsong-tie-note winner";
    } else if (leaders.titles.length > 1) {
      note.textContent = `Live tie: ${leaders.titles.join(" · ")} (${leaders.maxVotes} each). Voting is still open; this is not the frozen result.`;
      note.className = "newsong-tie-note tie";
    } else if (leaders.titles.length === 1) {
      note.textContent = `Live leader: ${leaders.titles[0]} with ${leaders.maxVotes} ${leaders.maxVotes === 1 ? "vote" : "votes"}. Voting is still open.`;
      note.className = "newsong-tie-note live";
    } else {
      note.textContent = "No votes in this run yet.";
      note.className = "newsong-tie-note";
    }
    document.getElementById("newsong-vote-chart").innerHTML = chartMarkup(session.state.voteCounts, result);
  }

  function participantRows(participants, sessionNumber) {
    if (!participants.length) return `<tr><td colspan="4" class="newsong-empty">No attendees have joined Session ${sessionNumber}, Run ${sessionByNumber(sessionNumber)?.state.runNumber || 1} yet.</td></tr>`;
    return participants.map((participant) => `
      <tr>
        <td><strong>${escapeHtml(participant.name)}</strong></td>
        <td class="newsong-raffle">#${escapeHtml(participant.raffleNumber || "----")}</td>
        <td>${participant.vote ? escapeHtml(participant.vote.songTitle) : `<span class="newsong-waiting-vote">Waiting</span>`}</td>
        <td>${participant.completedAt ? `<span class="newsong-done-mark">✓</span>` : "·"}</td>
      </tr>
    `).join("");
  }

  function renderParticipants(session) {
    document.getElementById("newsong-roster-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber} attendees`;
    document.querySelector("#newsong-participant-table tbody").innerHTML = participantRows(session.state.participants, session.sessionNumber);
  }

  function formatSavedTime(value) {
    if (!value) return "Saved";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Saved";
    return `Saved ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function renderArchivedRuns(session) {
    const target = document.getElementById("newsong-run-history");
    if (!session.archivedRuns.length) {
      target.innerHTML = `<div class="newsong-empty">No previous New Song runs have been archived for Session ${session.sessionNumber}.</div>`;
      return;
    }
    target.innerHTML = session.archivedRuns.map((run) => `
      <details class="newsong-archive-run">
        <summary>
          <span><b>Run ${run.runNumber}</b> · ${escapeHtml(phaseLabel(run.phase))}</span>
          <small>${run.totalVotes} ${run.totalVotes === 1 ? "vote" : "votes"} · ${escapeHtml(formatSavedTime(run.archivedAt))}</small>
        </summary>
        <div class="newsong-archive-body">
          ${resultMarkup(run.result, true)}
          ${chartMarkup(run.voteCounts, run.result, true)}
          <div class="newsong-table-wrap">
            <table class="dash-table newsong-participant-table">
              <thead><tr><th>Attendee</th><th>Raffle</th><th>Vote</th><th>Done</th></tr></thead>
              <tbody>${participantRows(run.participants, session.sessionNumber)}</tbody>
            </table>
          </div>
        </div>
      </details>
    `).join("");
  }

  function renderStats(session) {
    document.getElementById("newsong-assigned-count").textContent = String(session.assignedCount);
    document.getElementById("newsong-participant-count").textContent = String(session.state.participantCount);
    document.getElementById("newsong-vote-count").textContent = String(session.state.totalVotes);
    const leaders = liveLeaders(session);
    document.getElementById("newsong-leading-count").textContent = String(session.state.result ? session.state.result.maxVotes : leaders.maxVotes);
  }

  function renderSelectedSession() {
    renderTabs();
    const session = sessionByNumber();
    if (!session) {
      stage.innerHTML = `<div class="newsong-empty">This session has not loaded yet.</div>`;
      actions.innerHTML = "";
      return;
    }
    document.getElementById("newsong-control-title").textContent = `Session ${session.sessionNumber} · Run ${session.state.runNumber}`;
    document.getElementById("newsong-run-label").textContent = `Active run · ${phaseLabel(session.state.phase)}`;
    const phasePill = document.getElementById("newsong-phase-pill");
    phasePill.textContent = phaseLabel(session.state.phase);
    phasePill.className = `newsong-phase-pill ${session.state.phase}`;
    const band = document.getElementById("newsong-assigned-band");
    band.innerHTML = `<span class="newsong-band-dot" aria-hidden="true"></span>${escapeHtml(session.assignedColor.label)} wristbands · Session ${session.sessionNumber}`;
    band.style.setProperty("--band-color", bandHex(session.assignedColor.id));
    document.getElementById("newsong-session-time").textContent = session.sessionLabel;
    renderStats(session);
    renderStage(session);
    renderActions(session);
    renderVoteGraph(session);
    renderParticipants(session);
    renderArchivedRuns(session);
    restartButton.textContent = session.state.phase === "complete"
      ? "Save this run & start another"
      : "Archive run & start another";
    renderSchedule();
    syncBusyState();
  }

  function renderSchedule() {
    const session = sessionByNumber();
    const schedule = sessionSchedule();
    const timer = document.getElementById("newsong-session-timer");
    const note = document.getElementById("newsong-session-note");
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
      noteText = `The event is in the waiting lobby. Session ${selectedSessionNumber} controls are saved, but attendees cannot enter before their rotation.`;
    } else if (current.phase === "active" && selectedIndex < current.sessionIndex) {
      timerValue = "Closed";
      timerLabel = "Rotation passed";
      noteText = "You are reviewing an earlier rotation. Its active and archived New Song runs stay separate.";
    } else if (current.phase === "active" && selectedIndex > current.sessionIndex) {
      timerValue = EventSchedule.formattedTime(schedule.startsAt);
      timerLabel = "Upcoming";
      noteText = `Session ${current.session.number} is active now. You are preparing Session ${selectedSessionNumber}.`;
    } else if (current.phase === "ended") {
      timerValue = "Closed";
      timerLabel = "Booth time ended";
      noteText = "All booth rotations have ended. Results stay available until the overall organizer resets event data.";
    }
    timer.innerHTML = `${escapeHtml(timerValue)}<small>${escapeHtml(timerLabel)}</small>`;
    note.textContent = noteText;
    note.style.display = noteText ? "block" : "none";
  }

  function setStatus(message, tone = "") {
    const target = document.getElementById("newsong-publish-state");
    target.textContent = message;
    target.className = `newsong-publish-state${tone ? ` ${tone}` : ""}`;
  }

  function showSyncNote(message) {
    const note = document.getElementById("newsong-sync-note");
    note.textContent = message || "";
    note.style.display = message ? "block" : "none";
  }

  function syncBusyState() {
    settings.classList.toggle("newsong-loading", controlBusy);
    tabs.forEach((tab) => { tab.disabled = controlBusy; });
    actions.querySelectorAll("button").forEach((button) => { button.disabled = controlBusy; });
    refreshButton.disabled = controlBusy;
    restartButton.disabled = controlBusy || !sessionByNumber();
  }

  function formatUpdatedAt(value) {
    if (!value) return "Session controls loaded.";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Session controls loaded.";
    return `Published ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
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
    if (typeof EventAPI === "undefined" || typeof EventAPI.newSongDashboardData !== "function") {
      showSyncNote("The New Song API is not available on this deployment yet.");
      return false;
    }
    refreshInFlight = true;
    const refreshId = ++activeRefreshId;
    const epoch = requestEpoch;
    const requestStarted = Date.now();
    if (!options.silent) setStatus("Refreshing all three New Song sessions…");
    try {
      const data = await EventAPI.newSongDashboardData(organizerKey);
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
      showSyncNote("Live New Song updates are temporarily unavailable. Keep this page open and refresh when the connection returns.");
      if (!options.silent) toast("Couldn't refresh New Song.");
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
    const pending = {
      start: "Opening the ten-song vote…",
      show_winner: "Freezing and publishing the room result…",
      show_verse: "Publishing Revelation 14:3…",
      finish: "Releasing the final Done button…",
    };
    setStatus(pending[action] || "Updating attendee screens…");
    try {
      await EventAPI.advanceNewSongSession(session.sessionNumber, action, session.state.version, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      const messages = {
        start: "Voting is live.",
        show_winner: "The room result is frozen and visible.",
        show_verse: "Revelation 14:3 is live.",
        finish: "The final Done button is live.",
      };
      toast(messages[action] || "Attendee screens updated.");
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      if (error && error.code === "NEW_SONG_NO_VOTES") {
        toast("Wait for at least one attendee vote before revealing a result.");
        setStatus("The poll is still open. No votes have arrived yet.", "error");
      } else if (error && (error.status === 409 || /CONFLICT|STALE/.test(String(error.code || "")))) {
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
      `Archive New Song Session ${session.sessionNumber}, Run ${session.state.runNumber}, and start Run ${session.state.runNumber + 1}?\n\nIts votes, result, and attendee list will remain read-only in the archive. The other sessions will not change.${incompleteWarning}`
    );
    if (!approved) return;
    controlBusy = true;
    requestEpoch += 1;
    activeRefreshId += 1;
    refreshInFlight = false;
    syncBusyState();
    setStatus(`Archiving Run ${session.state.runNumber} and preparing a fresh welcome screen…`);
    try {
      await EventAPI.resetNewSongSession(session.sessionNumber, session.state.version, organizerKey);
      if (!OrganizerAuth.isCurrent(authGeneration)) return;
      toast(`Run ${session.state.runNumber} archived. Run ${session.state.runNumber + 1} is ready.`);
    } catch (error) {
      console.error(error);
      if (OrganizerAuth.handleError(error, authGeneration)) return;
      toast("Couldn't start another New Song run.");
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
    stage.innerHTML = `<div class="newsong-empty">Unlock New Song to load the run controls.</div>`;
    actions.innerHTML = "";
    document.getElementById("newsong-vote-chart").innerHTML = `<div class="newsong-empty">Unlock New Song to load the vote graph.</div>`;
    document.querySelector("#newsong-participant-table tbody").innerHTML = `<tr><td colspan="4" class="newsong-empty">Unlock New Song to load attendees.</td></tr>`;
    document.getElementById("newsong-run-history").innerHTML = `<div class="newsong-empty">Unlock New Song to load prior runs.</div>`;
    document.getElementById("newsong-tie-note").textContent = "";
    document.getElementById("staff-last-updated").textContent = "";
    showSyncNote("");
    setStatus("Unlock New Song to load the session controls.");
    renderTabs();
    syncBusyState();
  }

  tabs.forEach((tab, tabIndex) => {
    tab.addEventListener("click", () => selectSession(tab.dataset.newsongSession));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = tabIndex;
      if (event.key === "ArrowLeft") nextIndex = (tabIndex + tabs.length - 1) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (tabIndex + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      tabs[nextIndex].focus();
      selectSession(tabs[nextIndex].dataset.newsongSession);
    });
  });
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-newsong-action]");
    if (button) advance(String(button.dataset.newsongAction || ""));
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
