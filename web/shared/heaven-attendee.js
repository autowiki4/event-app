/* Draw Heaven attendee controller.
 *
 * The booth leader owns the shared run phase. Each attendee owns only the
 * small confirmations that let the leader see when the room is ready to move
 * on. Both live on the backend so a refresh returns the attendee to the exact
 * same point without letting one phone race ahead of the speaker.
 */
const HeavenAttendee = (() => {
  const PHASES = new Set([
    "welcome",
    "drawing",
    "verse",
    "comparison",
    "reflection",
    "programs",
    "complete",
  ]);
  const PHASE_ORDER = [
    "welcome",
    "drawing",
    "verse",
    "comparison",
    "reflection",
    "programs",
    "complete",
  ];
  const CONFIRMATIONS = [
    "drawing_complete",
    "description_yes",
    "size_yes",
    "impact_yes",
    "programs_done",
  ];
  const CONFIRMATION_GATES = [
    { action: "drawing_complete", minimumPhase: "drawing", stage: "drawing" },
    { action: "description_yes", minimumPhase: "drawing", stage: "drawing" },
    { action: "size_yes", minimumPhase: "verse", stage: "verse" },
    { action: "impact_yes", minimumPhase: "comparison", stage: "comparison" },
    { action: "programs_done", minimumPhase: "programs", stage: "reflection" },
  ];

  let initialized = false;
  let container = null;
  let identity = null;
  let state = null;
  let stateSignature = "";
  let refreshBusy = false;
  let refreshQueued = false;
  let confirmationBusy = "";
  let completionBusy = false;
  let interactionEpoch = 0;
  let pollTimer = null;
  let onCompleted = null;
  let transitionTimer = null;
  let transitionKind = "";

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

  function normalizeConfirmations(value) {
    const source = object(value);
    return CONFIRMATIONS.reduce((result, key) => {
      result[key] = Boolean(source[key]);
      return result;
    }, {});
  }

  function normalizeState(value) {
    const raw = object(value);
    const phaseValue = String(raw.phase || "welcome").trim().toLowerCase();
    const assignedColor = object(raw.assignedColor);
    const participant = object(raw.participant);
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
      participant: {
        confirmations: normalizeConfirmations(participant.confirmations),
        confirmedAt: object(participant.confirmedAt),
        completedAt: participant.completedAt || null,
      },
      updatedAt: raw.updatedAt || null,
      serverNow: raw.serverNow || null,
    };
  }

  function signature(value) {
    if (!value) return "";
    return JSON.stringify({
      sessionNumber: value.sessionNumber,
      phase: value.phase,
      version: value.version,
      runId: value.runId,
      runNumber: value.runNumber,
      confirmations: value.participant.confirmations,
      completedAt: value.participant.completedAt,
      updatedAt: value.updatedAt,
    });
  }

  function sessionLine(value) {
    const pieces = [];
    if (value.sessionNumber) pieces.push(`Session ${value.sessionNumber}`);
    if (value.sessionLabel) pieces.push(value.sessionLabel);
    if (value.assignedColor.label) pieces.push(`${value.assignedColor.label} wristbands`);
    return pieces.join(" · ");
  }

  function sessionMeta(value) {
    const label = sessionLine(value);
    return label ? `<p class="heaven-session-meta">${escapeHtml(label)}</p>` : "";
  }

  function phaseAtLeast(value, phase) {
    return PHASE_ORDER.indexOf(value.phase) >= PHASE_ORDER.indexOf(phase);
  }

  function runScope(value, suffix) {
    const runKey = String(value.runId || `session-${value.sessionNumber}-run-${value.runNumber}`);
    return `booth.heaven.${suffix}.${runKey}`;
  }

  function claimMotion(kind, value) {
    const scope = runScope(value, "motion");
    const played = typeof JourneyState !== "undefined"
      ? object(JourneyState.load(scope, {}))
      : {};
    if (played[kind]) return false;
    played[kind] = true;
    if (typeof JourneyState !== "undefined") JourneyState.save(scope, played);
    return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function waitingCard(title, copy, icon = "✨") {
    return `
      <div class="heaven-wait" role="status">
        <span class="heaven-wait-icon" aria-hidden="true">${icon}</span>
        <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div>
      </div>
    `;
  }

  function actionButton(action, label, secondary = false) {
    const busy = confirmationBusy === action;
    return `<button type="button" class="btn ${secondary ? "btn-ghost" : "btn-primary"} heaven-action"
      data-heaven-confirm="${action}" ${confirmationBusy ? "disabled" : ""}>${busy ? "Saving…" : escapeHtml(label)}</button>`;
  }

  function renderLoading() {
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <div class="heaven-card heaven-loading">
        <div class="heaven-palette" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <p class="eyebrow">Joining Draw Heaven…</p>
        <h2>Setting out your canvas.</h2>
        <p>Keep this screen open while we find your group's shared place.</p>
      </div>
    `;
  }

  function renderWelcome(value) {
    container.innerHTML = `
      <div class="heaven-card heaven-welcome">
        <div class="heaven-orbit" aria-hidden="true"><span>✦</span><b>🎨</b><span>✦</span></div>
        <span class="status-pill waiting">Waiting for your artist host</span>
        <p class="heaven-script">Welcome to</p>
        <h2>Draw Heaven</h2>
        <p class="heaven-copy">We all want to go to the Kingdom of Heaven but do you know what it looks like? Let’s take some time to draw what we think the Kingdom of Heaven looks like.</p>
        ${waitingCard("Keep your canvas close", "Your booth leader will open the drawing prompt when everyone is ready.", "🖍️")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderDrawing(value) {
    const confirmations = value.participant.confirmations;
    if (!confirmations.drawing_complete) {
      container.innerHTML = `
        <div class="heaven-card heaven-drawing">
          <div class="heaven-art-strip" aria-hidden="true"><span>☀️</span><span>🌈</span><span>🏙️</span><span>🌳</span><span>💎</span></div>
          <p class="eyebrow">Create first · No wrong answers</p>
          <h2>What does the Kingdom of Heaven look like?</h2>
          <p class="heaven-copy">We all want to go to the Kingdom of Heaven but do you know what it looks like? Let’s take some time to draw what we think the Kingdom of Heaven looks like.</p>
          <div class="heaven-prompt-grid">
            <span><b>Color</b>What would the sky or light look like?</span>
            <span><b>Place</b>What would you notice first?</span>
            <span><b>Feeling</b>How would it feel to be there?</span>
          </div>
          ${actionButton("drawing_complete", "I have completed my drawing")}
          ${sessionMeta(value)}
        </div>
      `;
      return;
    }

    if (!confirmations.description_yes) {
      container.innerHTML = `
        <div class="heaven-card heaven-invitation">
          <div class="heaven-stage-icon" aria-hidden="true">🖼️</div>
          <p class="eyebrow">Creation complete</p>
          <h2>Your drawing is complete.</h2>
          <p class="heaven-copy">Now that you have completed your drawing, are you interested in seeing how the Kingdom of Heaven is described?</p>
          ${actionButton("description_yes", "Yes")}
          ${sessionMeta(value)}
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="heaven-card heaven-invitation">
        <div class="heaven-stage-icon" aria-hidden="true">🖼️</div>
        <span class="status-pill waiting">Ready for the reveal</span>
        <h2>Your picture is only the beginning.</h2>
        <p class="heaven-copy">Look up when your speaker is ready. The description will appear here for everyone together.</p>
        ${waitingCard("Canvas down, eyes up", "Hmm… what details do you think Revelation will add?", "👀")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function confetti() {
    const colors = ["sun", "coral", "teal", "violet", "blue"];
    return Array.from({ length: 18 }, (_, index) => (
      `<i class="heaven-confetti heaven-confetti-${colors[index % colors.length]}" style="--i:${index};--x:${(index * 37 + 9) % 100}%;--drift:${(index - 9) * 2}px;--delay:${(index % 6) * -0.09}s" aria-hidden="true"></i>`
    )).join("");
  }

  function renderTransition(kind, value) {
    if (transitionTimer) window.clearTimeout(transitionTimer);
    transitionKind = kind;
    if (kind === "confetti") {
      container.innerHTML = `
        <div class="heaven-card heaven-transition heaven-verse-transition" role="status">
          <div class="heaven-confetti-field is-playing">${confetti()}</div>
          <div class="heaven-stage-icon" aria-hidden="true">✨</div>
          <p class="heaven-script">The description is here</p>
          <h2>Get ready for the reveal…</h2>
          ${sessionMeta(value)}
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="heaven-card heaven-transition heaven-impact-transition" role="status">
          <div class="heaven-burst is-playing" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><strong>✦</strong></div>
          <p class="heaven-script">One more reveal</p>
          <h2>Look what happens next…</h2>
          ${sessionMeta(value)}
        </div>
      `;
    }
    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      transitionKind = "";
      renderState();
    }, kind === "confetti" ? 1200 : 900);
  }

  function renderVerse(value) {
    const confirmations = value.participant.confirmations;
    const gate = confirmations.size_yes
      ? waitingCard("Hold that thought", "Your speaker will reveal just how vast the New Jerusalem is.", "🤯")
      : `
        <div class="heaven-question">
          <span aria-hidden="true">📏</span>
          <div><strong>Would you like to see its relative size?</strong><p>Are you interested in knowing the relative size of this Holy City New Jerusalem in comparison with the size of the United States of America?</p></div>
        </div>
        ${actionButton("size_yes", "Yes")}
      `;
    container.innerHTML = `
      <div class="heaven-card heaven-verse">
        <p class="heaven-script">The great reveal</p>
        <h2>John saw the holy Jerusalem.</h2>
        <blockquote>
          <p><b class="heaven-verse-number">10</b> “And he carried me away in the spirit to a great and high mountain, and shewed me that great city, the holy Jerusalem, descending out of heaven from God,”</p>
          <p><b class="heaven-verse-number">11</b> “Having the glory of God: and her light was like unto a stone most precious, even like a jasper stone, clear as crystal.”</p>
          <cite>Revelation 21:10–11 · KJV</cite>
        </blockquote>
        ${gate}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderComparison(value) {
    const confirmations = value.participant.confirmations;
    const gate = confirmations.impact_yes
      ? waitingCard("That is bigger than it looked on paper", "Keep looking at the comparison. Your speaker has one more part of the reveal.", "✨")
      : `
        <div class="heaven-question heaven-final-question">
          <span aria-hidden="true">💭</span>
          <div><strong>One more question</strong><p>The Bible promises that this Holy City New Jerusalem, the spiritual Kingdom of Heaven, will come down on the earth. Do you want to know what would happen if this Holy City New Jerusalem were to come down upon the United States?</p></div>
        </div>
        ${actionButton("impact_yes", "Yes I do")}
      `;
    container.innerHTML = `
      <div class="heaven-card heaven-comparison">
        <p class="eyebrow">Revelation 21:16 · Put it in perspective</p>
        <h2>The New Jerusalem is enormous.</h2>
        <p class="heaven-copy">Tap the image to explore the comparison, then return here for the final question.</p>
        <button type="button" class="heaven-image-button" id="btn-heaven-image" aria-label="Open the New Jerusalem size comparison image">
          <img src="../assets/new-jerusalem-comparison.jpeg" alt="Illustrated New Jerusalem dimensions: about 1,400 miles long, wide, and high, compared with the United States">
          <span>Tap to view larger ↗</span>
        </button>
        ${gate}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderReflection(value) {
    const canOpenPrograms = phaseAtLeast(value, "programs");
    container.innerHTML = `
      <div class="heaven-card heaven-reflection">
        <div class="heaven-burst" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><strong>✦</strong></div>
        <p class="heaven-script">A promise worth exploring</p>
        <h2>How can we understand this promise?</h2>
        <div class="heaven-meaning">
          <span>💭</span>
          <p>Since we know that God’s desire would not be to destroy the earth, how can we understand this promise given to us in Revelation? If you are interested in knowing click the button below to check out the programs offered by Nashville Christian Collective.</p>
        </div>
        ${canOpenPrograms
          ? `<button type="button" class="btn btn-primary heaven-action" id="btn-heaven-open-programs">View the five programs →</button>`
          : waitingCard("One last look ahead", "Your speaker will open the program information when the group is ready.", "🌟")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function programOptions() {
    const options = typeof FINAL_OPTIONS !== "undefined" && Array.isArray(FINAL_OPTIONS)
      ? FINAL_OPTIONS
      : [];
    const icons = { future: "📅", bible: "📖", course: "🧭", art: "🎨", friend: "💌" };
    return options.slice(0, 5).map((option) => `
      <article class="heaven-program-card">
        <span aria-hidden="true">${icons[option.id] || "✦"}</span>
        <div><h3>${escapeHtml(option.title)}</h3><p>${escapeHtml(option.desc)}</p></div>
      </article>
    `).join("");
  }

  function renderPrograms(value) {
    container.innerHTML = `
      <div class="heaven-card heaven-programs">
        <p class="eyebrow">A preview · No sign-up yet</p>
        <h2>Nashville Christian Collective programs</h2>
        <p class="heaven-copy">Here is information about each of the five opportunities. This is only a preview; nothing is selected or submitted here yet.</p>
        <div class="heaven-program-list">${programOptions()}</div>
        ${waitingCard("Program preview complete", "Stay with your group. Your booth leader will close the shared experience when everyone is ready.", "✅")}
        ${sessionMeta(value)}
      </div>
    `;
  }

  function renderComplete(value) {
    container.innerHTML = `
      <div class="heaven-card heaven-complete">
        <div class="heaven-stage-icon" aria-hidden="true">🌈</div>
        <p class="eyebrow">Draw Heaven complete</p>
        <h2>Your imagination made room for something bigger.</h2>
        <p class="heaven-copy">Great job creating, wondering, and learning more about the New Jerusalem with your group.</p>
        <button type="button" class="btn btn-primary heaven-action" id="btn-booth-done" ${completionBusy ? "disabled" : ""}>${completionBusy ? "Saving your visit…" : "Finish booth →"}</button>
        ${sessionMeta(value)}
      </div>
    `;
  }

  function nextCatchUpAction(value) {
    const confirmations = value.participant.confirmations;
    return CONFIRMATION_GATES.find((gate) => (
      phaseAtLeast(value, gate.minimumPhase) && !confirmations[gate.action]
    )) || null;
  }

  function visibleStage(value) {
    if (!phaseAtLeast(value, "drawing")) return "welcome";
    const catchUp = nextCatchUpAction(value);
    if (catchUp) return catchUp.stage;
    if (!phaseAtLeast(value, "verse")) return "drawing";
    if (!phaseAtLeast(value, "comparison")) return "verse";
    if (!phaseAtLeast(value, "reflection")) return "comparison";
    if (!phaseAtLeast(value, "programs")) return "reflection";
    if (!phaseAtLeast(value, "complete")) return "programs";
    return value.participant.confirmations.programs_done ? "complete" : "reflection";
  }

  function renderState() {
    if (!state) {
      renderLoading();
      return;
    }
    container.setAttribute("aria-busy", "false");
    if (transitionKind) return;
    const stage = visibleStage(state);
    if (stage === "verse" && claimMotion("confetti", state)) {
      renderTransition("confetti", state);
      return;
    }
    if (stage === "reflection" && claimMotion("explosion", state)) {
      renderTransition("explosion", state);
      return;
    }
    if (stage === "welcome") renderWelcome(state);
    else if (stage === "drawing") renderDrawing(state);
    else if (stage === "verse") renderVerse(state);
    else if (stage === "comparison") renderComparison(state);
    else if (stage === "reflection") renderReflection(state);
    else if (stage === "programs") renderPrograms(state);
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
        <div class="heaven-card heaven-error">
          <div class="heaven-stage-icon" aria-hidden="true">📶</div>
          <h2>We're reconnecting your canvas.</h2>
          <p class="heaven-copy">${escapeHtml(message)}</p>
          <button type="button" class="btn btn-primary" id="btn-heaven-retry">Try again</button>
        </div>
      `;
      return;
    }
    let note = container.querySelector("[data-heaven-sync-issue]");
    if (!note) {
      note = document.createElement("p");
      note.className = "heaven-sync-issue";
      note.dataset.heavenSyncIssue = "true";
      container.firstElementChild.appendChild(note);
    }
    note.textContent = message;
  }

  function clearSyncIssue() {
    const note = container && container.querySelector("[data-heaven-sync-issue]");
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
    const expectedEpoch = interactionEpoch;
    try {
      const result = await EventAPI.heavenState(identity.attendeeId);
      if (expectedEpoch !== interactionEpoch) return false;
      applyState(result);
      clearSyncIssue();
      return true;
    } catch (error) {
      console.error(error);
      showSyncIssue("Live booth updates are temporarily offline. Keep this page open and we'll reconnect automatically.");
      return false;
    } finally {
      refreshBusy = false;
      if (refreshQueued) {
        refreshQueued = false;
        window.setTimeout(() => refreshState(true), 0);
      }
    }
  }

  async function confirmStep(action) {
    if (confirmationBusy || completionBusy || !state || !CONFIRMATIONS.includes(action)) return;
    if (state.participant.confirmations[action]) return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Draw Heaven session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    const previousState = state;
    confirmationBusy = action;
    interactionEpoch += 1;
    renderState();
    try {
      const result = await EventAPI.confirmHeavenStep(identity.attendeeId, action);
      confirmationBusy = "";
      if (!result || !result.state || !applyState(result.state)) renderState();
    } catch (error) {
      console.error(error);
      confirmationBusy = "";
      state = previousState;
      stateSignature = signature(state);
      renderState();
      toast(error && error.message ? error.message : "Couldn't save that step — please try again.");
    } finally {
      if (confirmationBusy) {
        confirmationBusy = "";
        renderState();
      }
      refreshState(true);
    }
  }

  function openImage() {
    if (document.getElementById("heaven-image-dialog")) return;
    const dialog = document.createElement("div");
    dialog.id = "heaven-image-dialog";
    dialog.className = "heaven-image-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "New Jerusalem size comparison");
    dialog.innerHTML = `
      <button type="button" class="heaven-image-close" aria-label="Close image">×</button>
      <img src="../assets/new-jerusalem-comparison.jpeg" alt="Illustrated New Jerusalem dimensions: about 1,400 miles long, wide, and high, compared with the United States">
    `;
    document.body.appendChild(dialog);
    dialog.querySelector("button").focus();
  }

  function closeImage() {
    const dialog = document.getElementById("heaven-image-dialog");
    if (dialog) dialog.remove();
    const trigger = document.getElementById("btn-heaven-image");
    if (trigger) trigger.focus();
  }

  async function completeVisit() {
    if (completionBusy || !state || state.phase !== "complete") return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Draw Heaven session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    completionBusy = true;
    interactionEpoch += 1;
    renderState();
    try {
      await EventAPI.completeHeaven(identity.attendeeId);
      completionBusy = false;
      if (typeof onCompleted === "function") onCompleted(state);
    } catch (error) {
      console.error(error);
      completionBusy = false;
      renderState();
      toast(error && error.message ? error.message : "Couldn't save your Draw Heaven visit — please try again.");
    }
  }

  function handleClick(event) {
    const confirmation = event.target.closest("[data-heaven-confirm]");
    if (confirmation) {
      confirmStep(String(confirmation.dataset.heavenConfirm || ""));
      return;
    }
    if (event.target.closest("#btn-heaven-retry")) {
      renderLoading();
      refreshState(true);
      return;
    }
    if (event.target.closest("#btn-heaven-image")) {
      openImage();
      return;
    }
    if (event.target.closest("#btn-heaven-open-programs")) {
      confirmStep("programs_done");
      return;
    }
    if (event.target.closest("#btn-booth-done")) completeVisit();
  }

  function init(options) {
    const settings = object(options);
    const target = document.getElementById(settings.containerId || "booth-content");
    if (!target) throw new Error("Draw Heaven attendee container is missing.");
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
        if (event.target.closest(".heaven-image-close") || event.target.id === "heaven-image-dialog") closeImage();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeImage();
      });
      const pollInterval = Math.round(2500 * (0.85 + Math.random() * 0.3));
      pollTimer = window.setInterval(() => {
        if (!document.hidden && !confirmationBusy) refreshState(false);
      }, pollInterval);
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
      confirmations: { ...state.participant.confirmations },
    };
  }

  return { init, refresh: () => refreshState(true), extraData };
})();
