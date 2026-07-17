/* Leader-paced New Song attendee controller.
 *
 * The backend owns the session phase, run, vote, and frozen result. A phone
 * can cast one vote only while its leader has voting open; refreshes restore
 * that exact vote and follow the room through winner, verse, and completion.
 */
const NewSongAttendee = (() => {
  const PHASES = new Set(["welcome", "voting", "winner", "verse", "complete"]);
  const CANONICAL_SONGS = [
    "He Turned It",
    "Victory",
    "Brighter Day",
    "Praise - elevation worship",
    "I thank God - maverick city",
    "Amen- Madison Ryann Ward",
    "Quick - Caleb Gordon",
    "Goodbye Yesterday - elevation rhythm",
    "He called me",
    "247",
    "Elohim",
  ];

  let initialized = false;
  let container = null;
  let identity = null;
  let state = null;
  let stateSignature = "";
  let refreshBusy = false;
  let refreshQueued = false;
  let voteBusy = false;
  let completionBusy = false;
  let interactionEpoch = 0;
  let pollTimer = null;
  let onCompleted = null;

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

  function canonicalTitle(value) {
    const title = String(value || "");
    return CANONICAL_SONGS.includes(title) ? title : "";
  }

  function normalizeChoices(value) {
    const incoming = Array.isArray(value) ? value.map(canonicalTitle).filter(Boolean) : [];
    return incoming.length === CANONICAL_SONGS.length
      && new Set(incoming).size === CANONICAL_SONGS.length
      ? incoming
      : CANONICAL_SONGS.slice();
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

  function normalizeResult(value, winnerValue) {
    const source = object(value);
    const winner = object(winnerValue);
    const tiedTitles = (Array.isArray(source.tiedTitles) ? source.tiedTitles : winner.tiedSongs || [])
      .map(canonicalTitle)
      .filter(Boolean);
    const featuredWinner = canonicalTitle(source.featuredWinner || winner.songTitle);
    if (!featuredWinner && !tiedTitles.length) return null;
    const maxVotes = Math.max(0, integer(source.maxVotes, integer(winner.voteCount)));
    return {
      totalVotes: Math.max(0, integer(source.totalVotes)),
      maxVotes,
      isTie: Boolean(source.isTie || winner.tied || tiedTitles.length > 1),
      tiedTitles: tiedTitles.length ? tiedTitles : featuredWinner ? [featuredWinner] : [],
      featuredWinner,
      tieBreakRule: String(source.tieBreakRule || ""),
    };
  }

  function normalizeState(value) {
    const raw = object(value);
    const phaseValue = String(raw.phase || "welcome").trim().toLowerCase();
    const assignedColor = object(raw.assignedColor);
    return {
      sessionNumber: Math.max(0, integer(raw.sessionNumber)),
      sessionLabel: String(raw.sessionLabel || ""),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || ""),
      },
      phase: PHASES.has(phaseValue) ? phaseValue : "welcome",
      version: Math.max(0, integer(raw.version)),
      runId: String(raw.runId || ""),
      runNumber: Math.max(1, integer(raw.runNumber, 1)),
      choices: normalizeChoices(raw.choices),
      vote: normalizeVote(raw.vote),
      result: normalizeResult(raw.result, raw.winner),
      completedAt: raw.completedAt || null,
      updatedAt: raw.updatedAt || null,
      serverNow: raw.serverNow || null,
    };
  }

  function signature(value) {
    if (!value) return "";
    return JSON.stringify({
      sessionNumber: value.sessionNumber,
      runId: value.runId,
      runNumber: value.runNumber,
      phase: value.phase,
      version: value.version,
      choices: value.choices,
      vote: value.vote,
      result: value.result,
      completedAt: value.completedAt,
      updatedAt: value.updatedAt,
    });
  }

  function sessionLine(value) {
    const pieces = [];
    if (value.sessionNumber) pieces.push(`Session ${value.sessionNumber}`);
    if (value.runNumber > 1) pieces.push(`Run ${value.runNumber}`);
    if (value.sessionLabel) pieces.push(value.sessionLabel);
    if (value.assignedColor.label) pieces.push(`${value.assignedColor.label} wristbands`);
    return pieces.join(" · ");
  }

  function sessionMeta(value) {
    const line = sessionLine(value);
    return line ? `<p class="newsong-session-meta">${escapeHtml(line)}</p>` : "";
  }

  function cloudNote(title, copy, icon = "☁️") {
    return `
      <div class="newsong-cloud-note" role="status">
        <span aria-hidden="true">${icon}</span>
        <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(copy)}</small></div>
      </div>
    `;
  }

  function renderLoading() {
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <div class="newsong-card newsong-loading">
        <div class="newsong-equalizer" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <p class="eyebrow">Joining New Song…</p>
        <h2>Tuning in to your room.</h2>
        <p>Keep this screen open while we find your group's shared beat.</p>
      </div>
    `;
  }

  function renderWelcome(value) {
    container.innerHTML = `
      <div class="newsong-card newsong-welcome">
        <div class="newsong-cloud-stage" aria-hidden="true"><span>♫</span><b>🎵</b><span>♪</span></div>
        <span class="status-pill waiting">Waiting for your music host</span>
        <p class="newsong-script">Welcome to</p>
        <h2>The New Song in Nashville</h2>
        <p class="newsong-copy">Eleven songs are waiting in the wings. When your host opens the vote, choose the one you want this room to lift up together.</p>
        ${cloudNote("One room, one shared reveal", "Voting will appear for everyone when your booth leader starts the experience.", "🎙️")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function songButtons(value) {
    return value.choices.map((song, index) => `
      <button type="button" class="newsong-choice" data-newsong-vote="${escapeHtml(song)}"
        ${voteBusy || value.vote ? "disabled" : ""} aria-pressed="false">
        <span class="newsong-track-number">${String(index + 1).padStart(2, "0")}</span>
        <span>${escapeHtml(song)}</span>
        <i aria-hidden="true">→</i>
      </button>
    `).join("");
  }

  function renderVoting(value) {
    if (value.vote) {
      container.innerHTML = `
        <div class="newsong-card newsong-vote-wait">
          <div class="newsong-vinyl is-spinning" aria-hidden="true"><span>♪</span></div>
          <p class="eyebrow">Your vote is locked</p>
          <h2>${escapeHtml(value.vote.songTitle)}</h2>
          <p class="newsong-copy">Hmm… will your pick take the crown?</p>
          ${cloudNote("Listen for the winner", "Keep this screen open. Your host will freeze the room's vote and reveal the result for everyone together.", "🤔")}
          ${sessionMeta(value)}
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="newsong-card newsong-voting">
        <div class="newsong-vote-head"><span aria-hidden="true">🎧</span><div><p class="eyebrow">Voting is live</p><h2>Which song should lead the room?</h2></div></div>
        <p class="newsong-copy">Choose one. Your first tap is final, so make it count.</p>
        <div class="newsong-choice-list">${songButtons(value)}</div>
        <p class="newsong-fine-print">One attendee · one vote · one shared winner</p>
        ${sessionMeta(value)}
      </div>
    `;
  }

  function resultTitle(result) {
    if (!result) return "The room's result is ready.";
    return result.isTie ? "The room made it a tie!" : "The room has spoken!";
  }

  function renderWinner(value) {
    const result = value.result;
    const featured = result && result.featuredWinner ? result.featuredWinner : "The winning song";
    const tiedTitles = result && result.tiedTitles.length ? result.tiedTitles : [featured];
    const attendeePickWon = Boolean(value.vote && result && result.tiedTitles.includes(value.vote.songTitle));
    container.innerHTML = `
      <div class="newsong-card newsong-winner">
        <div class="newsong-crown" aria-hidden="true">♛</div>
        <p class="eyebrow">Vote closed · Winner reveal</p>
        <h2>${escapeHtml(resultTitle(result))}</h2>
        ${result && result.isTie ? `
          <p class="newsong-copy">These songs share the top spot with ${result.maxVotes} ${result.maxVotes === 1 ? "vote" : "votes"} each:</p>
          <div class="newsong-tie-list">${tiedTitles.map((title) => `<span>${escapeHtml(title)}</span>`).join("")}</div>
          <div class="newsong-featured"><small>Featured first by the event tiebreak</small><strong>${escapeHtml(featured)}</strong></div>
        ` : `
          <div class="newsong-winner-title"><small>New Song room winner</small><strong>${escapeHtml(featured)}</strong><span>${result ? `${result.maxVotes} ${result.maxVotes === 1 ? "vote" : "votes"}` : "Result revealed"}</span></div>
        `}
        ${value.vote ? `<p class="newsong-your-pick ${attendeePickWon ? "won" : ""}">${attendeePickWon ? "✨ Your pick reached the top!" : `Your vote: ${escapeHtml(value.vote.songTitle)}`}</p>` : `<p class="newsong-your-pick">Voting had already closed when you joined this run.</p>`}
        ${cloudNote("What could the new song be?", "Take a moment to guess with the room. Your speaker will reveal the next part when everyone is ready.", "🤔")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderVerse(value) {
    container.innerHTML = `
      <div class="newsong-card newsong-verse">
        <p class="newsong-script">The song beyond the playlist</p>
        <h2>Revelation describes a new song.</h2>
        <button type="button" class="newsong-verse-image" id="btn-newsong-image" aria-label="Open the Revelation 14:3 New Song artwork">
          <img src="../assets/revelation-14-3-new-song.webp" alt="Revelation 14:3 New Song artwork showing worship before God's throne">
          <span>Tap to view larger ↗</span>
        </button>
        <blockquote>
          <p>“And they sung as it were a new song before the throne, and before the four beasts, and the elders: and no man could learn that song but the hundred and forty and four thousand, which were redeemed from the earth.”</p>
          <cite>Revelation 14:3 · KJV</cite>
        </blockquote>
        <p class="newsong-copy">The room could choose a favorite from eleven songs. Revelation points to a song that belongs to the redeemed — learned through a life with God, not simply selected from a list.</p>
        ${cloudNote("Hold onto the thought", "Your host will release the final Done button when the shared reflection is complete.", "✨")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderComplete(value) {
    container.innerHTML = `
      <div class="newsong-card newsong-complete">
        <div class="newsong-finale" aria-hidden="true"><span>♪</span><b>✓</b><span>♫</span></div>
        <p class="eyebrow">New Song complete</p>
        <h2>Keep your heart tuned to the song.</h2>
        <p class="newsong-copy">Great job voting, listening, and discovering more about the new song in Revelation 14:3.</p>
        <button type="button" class="btn btn-primary newsong-done" id="btn-newsong-done" ${completionBusy ? "disabled" : ""}>${completionBusy ? "Saving your visit…" : "Done — return to my schedule →"}</button>
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderState() {
    if (!state) {
      renderLoading();
      return;
    }
    container.setAttribute("aria-busy", "false");
    if (state.phase === "welcome") renderWelcome(state);
    else if (state.phase === "voting") renderVoting(state);
    else if (state.phase === "winner") renderWinner(state);
    else if (state.phase === "verse") renderVerse(state);
    else renderComplete(state);
  }

  function applyState(nextValue) {
    const next = normalizeState(nextValue);
    if (
      state
      && state.sessionNumber === next.sessionNumber
      && (
        next.runNumber < state.runNumber
        || (state.runId === next.runId && next.version < state.version)
      )
    ) return false;
    const nextSignature = signature(next);
    state = next;
    if (nextSignature === stateSignature) return false;
    stateSignature = nextSignature;
    renderState();
    return true;
  }

  function showSyncIssue(message) {
    if (!state) {
      container.setAttribute("aria-busy", "false");
      container.innerHTML = `
        <div class="newsong-card newsong-error">
          <div class="newsong-cloud-stage" aria-hidden="true"><b>📶</b></div>
          <h2>We're finding the beat again.</h2>
          <p class="newsong-copy">${escapeHtml(message)}</p>
          <button type="button" class="btn btn-primary" id="btn-newsong-retry">Try again</button>
        </div>
      `;
      return;
    }
    let note = container.querySelector("[data-newsong-sync-issue]");
    if (!note) {
      note = document.createElement("p");
      note.className = "newsong-sync-issue";
      note.dataset.newsongSyncIssue = "true";
      container.firstElementChild.appendChild(note);
    }
    note.textContent = message;
  }

  function clearSyncIssue() {
    const note = container && container.querySelector("[data-newsong-sync-issue]");
    if (note) note.remove();
  }

  async function refreshState(force) {
    if (!identity || !identity.attendeeId || completionBusy) return false;
    if (!force && typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) return false;
    if (refreshBusy) {
      if (force) refreshQueued = true;
      return false;
    }
    refreshBusy = true;
    const epoch = interactionEpoch;
    const requestStarted = Date.now();
    try {
      const result = await EventAPI.newSongState(identity.attendeeId);
      if (epoch !== interactionEpoch) return false;
      if (result && result.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(result.serverNow, requestStarted, Date.now());
      }
      applyState(result);
      clearSyncIssue();
      return true;
    } catch (error) {
      console.error(error);
      if (typeof Identity !== "undefined" && Identity.restartIfMissing(error, currentBoothRoomUrl())) return false;
      showSyncIssue("Live New Song updates are temporarily offline. Keep this page open and we'll reconnect automatically.");
      return false;
    } finally {
      refreshBusy = false;
      if (refreshQueued) {
        refreshQueued = false;
        window.setTimeout(() => refreshState(true), 0);
      }
    }
  }

  async function submitVote(songTitle) {
    if (voteBusy || completionBusy || !state || state.phase !== "voting" || state.vote) return;
    if (!state.choices.includes(songTitle)) return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This New Song session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    const previousState = state;
    voteBusy = true;
    interactionEpoch += 1;
    state = { ...state, vote: { songTitle, votedAt: null } };
    stateSignature = signature(state);
    renderState();
    try {
      const result = await EventAPI.submitNewSongVote(identity.attendeeId, songTitle);
      const nextState = object(result).state;
      if (Object.keys(nextState).length) applyState(nextState);
      toast("Your vote is locked in.");
    } catch (error) {
      console.error(error);
      state = previousState;
      stateSignature = signature(state);
      renderState();
      toast(error && error.message ? error.message : "Couldn't save that vote — please try again.");
    } finally {
      voteBusy = false;
      renderState();
      refreshState(true);
    }
  }

  function openImage() {
    if (document.getElementById("newsong-image-dialog")) return;
    const dialog = document.createElement("div");
    dialog.id = "newsong-image-dialog";
    dialog.className = "newsong-image-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Revelation 14:3 New Song artwork");
    dialog.innerHTML = `
      <button type="button" class="newsong-image-close" aria-label="Close image">×</button>
      <img src="../assets/revelation-14-3-new-song.webp" alt="Revelation 14:3 New Song artwork showing worship before God's throne">
    `;
    document.body.appendChild(dialog);
    dialog.querySelector("button").focus();
  }

  function closeImage() {
    const dialog = document.getElementById("newsong-image-dialog");
    if (dialog) dialog.remove();
    const trigger = document.getElementById("btn-newsong-image");
    if (trigger) trigger.focus();
  }

  async function completeVisit() {
    if (completionBusy || !state || state.phase !== "complete") return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This New Song session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    completionBusy = true;
    interactionEpoch += 1;
    renderState();
    try {
      const result = await EventAPI.completeNewSong(identity.attendeeId);
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
      completionBusy = false;
      if (typeof onCompleted === "function") onCompleted(result);
    } catch (error) {
      console.error(error);
      completionBusy = false;
      renderState();
      toast(error && error.message ? error.message : "Couldn't save your New Song visit — please try again.");
    }
  }

  function handleClick(event) {
    const voteButton = event.target.closest("[data-newsong-vote]");
    if (voteButton) {
      submitVote(String(voteButton.dataset.newsongVote || ""));
      return;
    }
    if (event.target.closest("#btn-newsong-retry")) {
      renderLoading();
      refreshState(true);
      return;
    }
    if (event.target.closest("#btn-newsong-image")) {
      openImage();
      return;
    }
    if (event.target.closest("#btn-newsong-done")) completeVisit();
  }

  function init(options) {
    const settings = object(options);
    const target = document.getElementById(settings.containerId || "booth-content");
    if (!target) throw new Error("New Song attendee container is missing.");
    container = target;
    identity = typeof window.getCurrentBoothIdentity === "function"
      ? window.getCurrentBoothIdentity()
      : Identity.peek();
    onCompleted = settings.onCompleted;
    if (!identity || !identity.attendeeId) {
      showSyncIssue("We couldn't restore your attendee sign-in. Return to your schedule and try again.");
      return;
    }
    if (!initialized) {
      initialized = true;
      container.addEventListener("click", handleClick);
      document.addEventListener("click", (event) => {
        if (event.target.closest(".newsong-image-close") || event.target.id === "newsong-image-dialog") closeImage();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeImage();
      });
      const interval = Math.round(2500 * (0.85 + Math.random() * 0.3));
      pollTimer = window.setInterval(() => {
        if (!document.hidden && !voteBusy) refreshState(false);
      }, interval);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshState(true);
      });
    }
    renderLoading();
    refreshState(true);
  }

  function extraData() {
    if (!state) return null;
    return {
      sessionNumber: state.sessionNumber,
      runId: state.runId,
      runNumber: state.runNumber,
      phase: state.phase,
      votedFor: state.vote ? state.vote.songTitle : null,
      featuredWinner: state.result ? state.result.featuredWinner : null,
    };
  }

  return { init, refresh: () => refreshState(true), extraData };
})();
