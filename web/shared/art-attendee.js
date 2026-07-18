/* Leader-paced Art Therapy attendee controller.
 *
 * The Node backend owns the selected session, run, and published phase. An
 * attendee can never reveal the next slide locally: every phone polls the
 * same versioned state and only receives a Done action after the leader has
 * released the final phase.
 */
const ArtAttendee = (() => {
  const PHASES = new Set([
    "welcome", "definition", "importance", "purpose_image", "heart_question",
    "proverbs", "philippians", "create", "finished", "complete",
  ]);

  let initialized = false;
  let container = null;
  let identity = null;
  let state = null;
  let stateSignature = "";
  let refreshBusy = false;
  let refreshQueued = false;
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

  function normalizeState(value) {
    const raw = object(value);
    const phase = String(raw.phase || "welcome").trim().toLowerCase();
    const assignedColor = object(raw.assignedColor);
    return {
      sessionNumber: Math.max(0, integer(raw.sessionNumber)),
      sessionLabel: String(raw.sessionLabel || ""),
      assignedColor: {
        id: String(assignedColor.id || "").toLowerCase(),
        label: String(assignedColor.label || assignedColor.id || ""),
      },
      phase: PHASES.has(phase) ? phase : "welcome",
      version: Math.max(0, integer(raw.version)),
      runId: String(raw.runId || ""),
      runNumber: Math.max(1, integer(raw.runNumber, 1)),
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
      completedAt: value.completedAt,
      updatedAt: value.updatedAt,
    });
  }

  function sessionMeta(value) {
    const pieces = [];
    if (value.sessionNumber) pieces.push(`Session ${value.sessionNumber}`);
    if (value.runNumber > 1) pieces.push(`Run ${value.runNumber}`);
    if (value.sessionLabel) pieces.push(value.sessionLabel);
    if (value.assignedColor.label) pieces.push(`${value.assignedColor.label} wristbands`);
    return pieces.length ? `<p class="art-session-meta">${escapeHtml(pieces.join(" · "))}</p>` : "";
  }

  function leaderNote(copy, icon = "🎨") {
    return `
      <div class="art-leader-note" role="status">
        <span aria-hidden="true">${icon}</span>
        <div><strong>Stay with your art guide</strong><small>${escapeHtml(copy)}</small></div>
      </div>
    `;
  }

  function card(value, classes, content) {
    return `<article class="art-card ${classes}">${content}${sessionMeta(value)}</article>`;
  }

  function renderLoading() {
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <article class="art-card art-loading">
        <div class="art-palette-loader" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <p class="eyebrow">Joining Art Therapy…</p>
        <h2>Preparing your shared canvas.</h2>
        <p>Keep this screen open while we connect to your group's leader.</p>
      </article>
    `;
  }

  function renderWelcome(value) {
    container.innerHTML = card(value, "art-welcome", `
      <div class="art-doodle" aria-hidden="true"><span>✦</span><b>🖌️</b><span>♡</span></div>
      <span class="status-pill waiting">Waiting for your art guide</span>
      <p class="art-slide-label">Art Therapy Table</p>
      <h2>A shared creative experience is about to begin.</h2>
      <p class="art-copy">Your booth leader will move every phone through the experience together. There is nothing to tap yet—settle in and listen for the welcome.</p>
      ${leaderNote("Slide 1 will appear for everyone when the room is ready.", "🕰️")}
    `);
  }

  function renderDefinition(value) {
    container.innerHTML = card(value, "art-definition", `
      <p class="art-slide-label">Slide 1</p>
      <div class="art-title-row"><span aria-hidden="true">🎨</span><h2>What is art therapy?</h2></div>
      <p class="art-copy">Art therapy is a mental health profession that uses art-making and the creative process within a therapeutic relationship led by a trained art therapist.</p>
      <div class="art-safety-note"><strong>About today's booth</strong><span>This is a guided art-and-reflection activity—not clinical art therapy. You do not need to be “good at art.” The process matters more than making something perfect.</span></div>
      ${leaderNote("Listen as your guide introduces the experience. The next slide will arrive on every phone together.")}
    `);
  }

  function renderImportance(value) {
    container.innerHTML = card(value, "art-importance", `
      <p class="art-slide-label">Slide 2</p>
      <h2>Why is art therapy important?</h2>
      <p class="art-copy">Creative expression can give people another way to notice and communicate their inner experience.</p>
      <div class="art-benefits">
        <div><span aria-hidden="true">💬</span><strong>Express what words cannot</strong><small>Color, shape, and images can help represent experiences that are hard to say aloud.</small></div>
        <div><span aria-hidden="true">👀</span><strong>Slow down and notice</strong><small>Making art can create space to observe thoughts, feelings, and patterns.</small></div>
        <div><span aria-hidden="true">💛</span><strong>Make room for reflection</strong><small>The goal is honest exploration—not a perfect picture or a perfect answer.</small></div>
      </div>
      ${leaderNote("Your guide has a heart-and-mind visual to share next.", "🧠")}
    `);
  }

  function renderPurposeImage(value) {
    container.innerHTML = card(value, "art-purpose", `
      <p class="art-slide-label">Slide 2 · Visual</p>
      <h2>Understanding the purpose within the heart and mind</h2>
      <button type="button" class="art-purpose-image" id="btn-art-image" aria-label="Open the heart and mind illustration">
        <img src="../assets/art-therapy-heart-and-mind.jpeg" alt="Illustration titled Understanding the purpose within the heart and mind, showing a person holding a heart and a brain">
        <span>Tap to view larger ↗</span>
      </button>
      <p class="art-copy">Take a moment to study the relationship between what we feel in our hearts and what we carry in our minds.</p>
      ${leaderNote("Keep listening. Your guide will open the Bible reflection next.", "✨")}
    `);
  }

  function heartIntro() {
    return `
      <p class="art-slide-label">Slide 3 · Bible reflection</p>
      <div class="art-heart-icon" aria-hidden="true">♥</div>
      <h2>Do you know what the Bible says about the heart?</h2>
      <p class="art-copy">The Bible connects the heart with the direction of our lives and with the peace God gives.</p>
    `;
  }

  function verse(reference, text) {
    return `
      <blockquote class="art-verse is-revealed">
        <p>“${escapeHtml(text)}”</p><cite>${escapeHtml(reference)}</cite>
      </blockquote>
    `;
  }

  function renderHeart(value) {
    container.innerHTML = card(value, "art-heart", `
      ${heartIntro()}
      ${leaderNote("Stay with your guide. The next part will appear when the room is ready.", "✨")}
    `);
  }

  function renderProverbs(value) {
    container.innerHTML = card(value, "art-heart", `
      ${heartIntro()}
      <div class="art-verse-stack">
        ${verse("Proverbs 4:23", "Above all else, guard your heart, for everything you do flows from it.")}
      </div>
      ${leaderNote("Take a moment with this thought. More will appear when the room is ready.", "💭")}
    `);
  }

  function renderPhilippians(value) {
    container.innerHTML = card(value, "art-heart art-heart-complete", `
      ${heartIntro()}
      <div class="art-verse-stack">
        ${verse("Proverbs 4:23", "Above all else, guard your heart, for everything you do flows from it.")}
        ${verse("Philippians 4:7", "And the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus.")}
      </div>
      ${leaderNote("Listen for the connection between guarding the heart and receiving God's peace.", "🕊️")}
    `);
  }

  function renderCreate(value) {
    container.innerHTML = card(value, "art-create", `
      <p class="art-slide-label">Slide 5 · Create</p>
      <div class="art-supply-row" aria-hidden="true"><span>🖍️</span><span>✂️</span><span>🖌️</span><span>📝</span></div>
      <h2>Now it’s your turn! Let’s use art therapy</h2>
      <p class="art-copy">Follow your booth leader’s creative prompt. Use the materials in front of you to express what is happening in your heart and mind.</p>
      <div class="art-create-reminder"><strong>Focus on expression, not perfection.</strong><span>Your artwork stays with you. Nothing is photographed, typed, rated, or submitted in this app.</span></div>
      ${leaderNote("Create at the room's pace. Your guide will move every phone to the closing reflection.", "🌈")}
    `);
  }

  function renderFinished(value) {
    container.innerHTML = card(value, "art-finished", `
      <p class="art-slide-label">Slide 6 · Reflect</p>
      <div class="art-frame" aria-hidden="true"><span>✦</span><b>♡</b><span>✦</span></div>
      <h2>I’m finished, now what?</h2>
      <p class="art-copy">Pause and look at what you created. Notice one color, shape, or detail that stands out.</p>
      <div class="art-create-reminder"><strong>No explanation is required.</strong><span>Keep your artwork with you and listen for your booth leader’s closing thought.</span></div>
      ${leaderNote("The Finish booth button will appear when your guide closes the shared experience.", "🕰️")}
    `);
  }

  function renderComplete(value) {
    container.innerHTML = card(value, "art-complete", `
      <div class="art-complete-mark" aria-hidden="true">✓</div>
      <p class="art-slide-label">Art Therapy complete</p>
      <h2>Great job creating from the heart.</h2>
      <p class="art-copy">Take your artwork with you and carry one thing you noticed into the rest of your day.</p>
      <button type="button" class="btn btn-primary art-done" id="btn-art-done" ${completionBusy ? "disabled" : ""}>${completionBusy ? "Saving your visit…" : "Finish booth →"}</button>
    `);
  }

  function renderState() {
    if (!state) {
      renderLoading();
      return;
    }
    container.setAttribute("aria-busy", "false");
    if (state.phase === "welcome") renderWelcome(state);
    else if (state.phase === "definition") renderDefinition(state);
    else if (state.phase === "importance") renderImportance(state);
    else if (state.phase === "purpose_image") renderPurposeImage(state);
    else if (state.phase === "heart_question") renderHeart(state);
    else if (state.phase === "proverbs") renderProverbs(state);
    else if (state.phase === "philippians") renderPhilippians(state);
    else if (state.phase === "create") renderCreate(state);
    else if (state.phase === "finished") renderFinished(state);
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
        <article class="art-card art-error">
          <div class="art-doodle" aria-hidden="true"><b>📶</b></div>
          <h2>We’re reconnecting your canvas.</h2>
          <p class="art-copy">${escapeHtml(message)}</p>
          <button type="button" class="btn btn-primary" id="btn-art-retry">Try again</button>
        </article>
      `;
      return;
    }
    let note = container.querySelector("[data-art-sync-issue]");
    if (!note) {
      note = document.createElement("p");
      note.className = "art-sync-issue";
      note.dataset.artSyncIssue = "true";
      container.firstElementChild.appendChild(note);
    }
    note.textContent = message;
  }

  function clearSyncIssue() {
    const note = container && container.querySelector("[data-art-sync-issue]");
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
      const result = await EventAPI.artState(identity.attendeeId);
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
      showSyncIssue("Live Art Therapy updates are temporarily offline. Keep this page open and we’ll reconnect automatically.");
      return false;
    } finally {
      refreshBusy = false;
      if (refreshQueued) {
        refreshQueued = false;
        window.setTimeout(() => refreshState(true), 0);
      }
    }
  }

  function openImage() {
    if (document.getElementById("art-image-dialog")) return;
    const dialog = document.createElement("div");
    dialog.id = "art-image-dialog";
    dialog.className = "art-image-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Heart and mind illustration");
    dialog.innerHTML = `
      <button type="button" class="art-image-close" aria-label="Close image">×</button>
      <img src="../assets/art-therapy-heart-and-mind.jpeg" alt="Illustration titled Understanding the purpose within the heart and mind, showing a person holding a heart and a brain">
    `;
    document.body.appendChild(dialog);
    dialog.querySelector("button").focus();
  }

  function closeImage() {
    const dialog = document.getElementById("art-image-dialog");
    if (dialog) dialog.remove();
    const trigger = document.getElementById("btn-art-image");
    if (trigger) trigger.focus();
  }

  async function completeVisit() {
    if (completionBusy || !state || state.phase !== "complete") return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Art Therapy session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    completionBusy = true;
    interactionEpoch += 1;
    renderState();
    try {
      await EventAPI.completeArt(identity.attendeeId);
      completionBusy = false;
      renderState();
      if (typeof onCompleted === "function") onCompleted();
    } catch (error) {
      console.error(error);
      completionBusy = false;
      renderState();
      toast(error && error.message ? error.message : "Couldn’t save your Art Therapy visit — please try again.");
    }
  }

  function handleClick(event) {
    if (event.target.closest("#btn-art-retry")) {
      renderLoading();
      refreshState(true);
      return;
    }
    if (event.target.closest("#btn-art-image")) {
      openImage();
      return;
    }
    if (event.target.closest("#btn-art-done")) completeVisit();
  }

  function init(options) {
    const settings = object(options);
    const target = document.getElementById(settings.containerId || "booth-content");
    if (!target) throw new Error("Art Therapy attendee container is missing.");
    container = target;
    identity = typeof window.getCurrentBoothIdentity === "function"
      ? window.getCurrentBoothIdentity()
      : Identity.peek();
    onCompleted = settings.onCompleted;
    if (!identity || !identity.attendeeId) {
      showSyncIssue("We couldn’t restore your attendee sign-in. Return to your schedule and try again.");
      return;
    }
    if (!initialized) {
      initialized = true;
      container.addEventListener("click", handleClick);
      document.addEventListener("click", (event) => {
        if (event.target.closest(".art-image-close") || event.target.id === "art-image-dialog") closeImage();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeImage();
      });
      const interval = Math.round(2500 * (0.85 + Math.random() * 0.3));
      pollTimer = window.setInterval(() => {
        if (!document.hidden) refreshState(false);
      }, interval);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshState(true);
      });
      window.addEventListener("focus", () => refreshState(true));
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
      reachedBeat: state.phase,
    };
  }

  return { init, refresh: () => refreshState(true), extraData };
})();
