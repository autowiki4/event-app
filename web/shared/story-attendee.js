/* Leader-paced attendee controller for The Heaven Booth.
 *
 * The protected booth-leader portal publishes one shared presentation step.
 * Attendees can only watch that step and may save their visit after the
 * leader reaches Thank you. A stale presentation from an earlier rotation is
 * treated as the opening screen until the leader publishes for the new group.
 */
const StoryAttendee = (() => {
  const BOOTH_ID = "story";
  const BOOTH_NAME = "The Heaven Booth";
  const FINAL_STEP_INDEX = 12;
  const NIV_NOTICE = "Scripture taken from the Holy Bible, NEW INTERNATIONAL VERSION®, NIV® Copyright © 1973, 1978, 1984, 2011 by Biblica, Inc.® Used by permission. All rights reserved worldwide.";
  const PICTURES = Object.freeze({
    mustard: {
      src: "../assets/heaven-booth-mustard-seed.png",
      alt: "A tiny mustard seed growing into a large tree with birds resting in its branches",
    },
    yeast: {
      src: "../assets/heaven-booth-yeast.png",
      alt: "A woman mixing yeast into a large bowl of flour and dough",
    },
    treasure: {
      src: "../assets/heaven-booth-treasure.png",
      alt: "A person discovering a hidden treasure chest in a field",
    },
    net: {
      src: "../assets/heaven-booth-net.png",
      alt: "Fishermen pulling a net filled with many kinds of fish onto the shore",
    },
  });
  const SLIDES = Object.freeze([
    { type: "welcome" },
    { type: "picture", picture: "mustard", number: 1 },
    { type: "picture", picture: "yeast", number: 2 },
    { type: "picture", picture: "treasure", number: 3 },
    { type: "picture", picture: "net", number: 4 },
    { type: "question" },
    { type: "connection" },
    { type: "kingdom" },
    {
      type: "verse",
      picture: "mustard",
      reference: "Matthew 13:31–32",
      text: "He told them another parable: “The kingdom of heaven is like a mustard seed, which a man took and planted in his field. Though it is the smallest of all seeds, yet when it grows, it is the largest of garden plants and becomes a tree, so that the birds come and perch in its branches.”",
    },
    {
      type: "verse",
      picture: "yeast",
      reference: "Matthew 13:33",
      text: "He told them still another parable: “The kingdom of heaven is like yeast that a woman took and mixed into about sixty pounds of flour until it worked all through the dough.”",
    },
    {
      type: "verse",
      picture: "treasure",
      reference: "Matthew 13:44",
      text: "The kingdom of heaven is like treasure hidden in a field. When a man found it, he hid it again, and then in his joy went and sold all he had and bought that field.",
    },
    {
      type: "verse",
      picture: "net",
      reference: "Matthew 13:47–48",
      text: "Once again, the kingdom of heaven is like a net that was let down into the lake and caught all kinds of fish. When it was full, the fishermen pulled it up on the shore. Then they sat down and collected the good fish in baskets, but threw the bad away.",
    },
    { type: "complete" },
  ]);

  let initialized = false;
  let container = null;
  let presentation = null;
  let renderedSignature = "";
  let refreshBusy = false;
  let refreshEpoch = 0;
  let completionBusy = false;
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

  function normalizePresentation(value) {
    const raw = object(value);
    const status = ["waiting", "live", "paused", "wrap", "complete"].includes(String(raw.status || "").toLowerCase())
      ? String(raw.status).toLowerCase()
      : "waiting";
    return {
      boothId: BOOTH_ID,
      stepIndex: Math.max(0, Math.min(FINAL_STEP_INDEX, integer(raw.stepIndex))),
      status,
      message: String(raw.message || "").trim().slice(0, 140),
      version: Math.max(0, integer(raw.version)),
      updatedAt: raw.updatedAt || null,
      serverNow: raw.serverNow || null,
    };
  }

  function currentSession() {
    if (typeof EventSchedule === "undefined" || typeof EventSchedule.current !== "function") return null;
    return EventSchedule.current();
  }

  function effectivePresentation(value) {
    const snapshot = currentSession();
    const isLocalPreview = typeof EventSchedule !== "undefined" && typeof EventSchedule.isPreviewing === "function"
      ? EventSchedule.isPreviewing()
      : ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
        && new URLSearchParams(window.location.search).has("preview");
    const updatedMs = value.updatedAt ? new Date(value.updatedAt).getTime() : NaN;
    const stale = !isLocalPreview
      && snapshot
      && snapshot.phase === "active"
      && snapshot.session
      && Number.isFinite(updatedMs)
      && updatedMs < snapshot.session.startMs;
    let stepIndex = value.stepIndex;
    let status = value.status;
    if (stale || status === "waiting") {
      stepIndex = 0;
      status = "waiting";
    } else if (status === "complete") {
      stepIndex = FINAL_STEP_INDEX;
    }
    return {
      ...value,
      stepIndex,
      status,
      stale,
      sessionNumber: snapshot && snapshot.session ? snapshot.session.number : 0,
    };
  }

  function signature(value) {
    return JSON.stringify({
      stepIndex: value.stepIndex,
      status: value.status,
      message: value.message,
      version: value.version,
      stale: value.stale,
      sessionNumber: value.sessionNumber,
      completionBusy,
    });
  }

  function pictureMarkup(pictureKey, eager = true) {
    const picture = PICTURES[pictureKey];
    return `
      <figure class="story-picture">
        <img src="${picture.src}" alt="${escapeHtml(picture.alt)}" loading="${eager ? "eager" : "lazy"}" decoding="async">
      </figure>
    `;
  }

  function announcement(value) {
    const leaderState = value.status === "paused"
      ? `<p class="story-leader-state paused" role="status"><strong>Hold here</strong><span>Keep this screen open. Your booth leader will continue soon.</span></p>`
      : value.status === "wrap"
        ? `<p class="story-leader-state wrap" role="status"><strong>Finishing soon</strong><span>Stay on this screen while your booth leader wraps up.</span></p>`
        : "";
    const message = value.message
      ? `<p class="story-announcement" role="status">${escapeHtml(value.message)}</p>`
      : "";
    return `${leaderState}${message}`;
  }

  function renderWelcome(value) {
    container.innerHTML = `
      <article class="story-card story-welcome">
        <h2>The Heaven Booth</h2>
        ${announcement(value)}
      </article>
    `;
  }

  function renderPicture(value, slide) {
    container.innerHTML = `
      <article class="story-card story-picture-card">
        <p class="story-slide-label">Picture ${slide.number} of 4</p>
        ${pictureMarkup(slide.picture)}
        <h2>What do you see in this picture?</h2>
        ${announcement(value)}
      </article>
    `;
  }

  function renderQuestion(value) {
    container.innerHTML = `
      <article class="story-card story-question">
        <h2>Are all these pictures related?</h2>
        ${announcement(value)}
      </article>
    `;
  }

  function renderConnection(value) {
    container.innerHTML = `
      <article class="story-card story-reveal">
        <p class="story-kicker">They actually are!</p>
        <h2>Do you know what they describe?</h2>
        ${announcement(value)}
      </article>
    `;
  }

  function renderKingdom(value) {
    container.innerHTML = `
      <article class="story-card story-kingdom">
        <p class="story-slide-label">The four pictures describe</p>
        <div class="story-gallery" aria-label="The four booth pictures">
          ${Object.values(PICTURES).map((picture) => `<img src="${picture.src}" alt="${escapeHtml(picture.alt)}" loading="eager" decoding="async">`).join("")}
        </div>
        <h2>The Kingdom of Heaven</h2>
        ${announcement(value)}
      </article>
    `;
  }

  function renderVerse(value, slide) {
    container.innerHTML = `
      <article class="story-card story-verse-card">
        <p class="story-slide-label">${escapeHtml(slide.reference)} · NIV</p>
        ${pictureMarkup(slide.picture)}
        <blockquote>
          <p>“${escapeHtml(slide.text)}”</p>
          <cite>${escapeHtml(slide.reference)} · NIV</cite>
        </blockquote>
        <p class="story-niv-notice">${escapeHtml(NIV_NOTICE)}</p>
        ${announcement(value)}
      </article>
    `;
  }

  function renderComplete(value) {
    container.innerHTML = `
      <article class="story-card story-complete">
        <div class="story-complete-mark" aria-hidden="true">✓</div>
        <h2>Thank you</h2>
        ${announcement(value)}
        <button type="button" class="btn btn-primary story-done" id="btn-booth-done" ${completionBusy ? "disabled" : ""}>${completionBusy ? "Saving your visit…" : "Finish booth →"}</button>
      </article>
    `;
  }

  function render() {
    if (!presentation) {
      container.setAttribute("aria-busy", "true");
      return;
    }
    const effective = effectivePresentation(presentation);
    const nextSignature = signature(effective);
    if (nextSignature === renderedSignature) return;
    renderedSignature = nextSignature;
    container.setAttribute("aria-busy", "false");
    const slide = SLIDES[effective.stepIndex] || SLIDES[0];
    if (slide.type === "welcome") renderWelcome(effective);
    else if (slide.type === "picture") renderPicture(effective, slide);
    else if (slide.type === "question") renderQuestion(effective);
    else if (slide.type === "connection") renderConnection(effective);
    else if (slide.type === "kingdom") renderKingdom(effective);
    else if (slide.type === "verse") renderVerse(effective, slide);
    else renderComplete(effective);
  }

  function showSyncIssue(message) {
    if (!presentation) {
      container.setAttribute("aria-busy", "false");
      container.innerHTML = `
        <article class="story-card story-error">
          <h2>Reconnecting to the booth leader…</h2>
          <p>${escapeHtml(message)}</p>
          <button type="button" class="btn btn-primary" id="btn-story-retry">Try again</button>
        </article>
      `;
      return;
    }
    let note = container.querySelector("[data-story-sync-issue]");
    if (!note) {
      note = document.createElement("p");
      note.className = "story-sync-issue";
      note.dataset.storySyncIssue = "true";
      container.firstElementChild.appendChild(note);
    }
    note.textContent = message;
  }

  async function refresh() {
    if (refreshBusy || document.hidden) return false;
    refreshBusy = true;
    const epoch = ++refreshEpoch;
    const requestStartedAt = Date.now();
    try {
      const next = normalizePresentation(await EventAPI.boothPresentation(BOOTH_ID));
      const responseReceivedAt = Date.now();
      if (epoch !== refreshEpoch) return false;
      if (next.serverNow && typeof EventSchedule !== "undefined" && typeof EventSchedule.sync === "function") {
        EventSchedule.sync(next.serverNow, requestStartedAt, responseReceivedAt);
      }
      presentation = next;
      render();
      return true;
    } catch (error) {
      console.error(error);
      showSyncIssue("Keep this page open while we reconnect.");
      return false;
    } finally {
      if (epoch === refreshEpoch) refreshBusy = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await refresh();
      schedulePoll();
    }, Math.round(2500 * (0.85 + Math.random() * 0.3)));
  }

  async function completeVisit() {
    if (completionBusy || !presentation) return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Heaven Booth session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    completionBusy = true;
    renderedSignature = "";
    render();
    try {
      const identity = typeof window.getCurrentBoothIdentity === "function"
        ? window.getCurrentBoothIdentity()
        : Identity.peek();
      await EventAPI.completeStory(identity.attendeeId);
      completionBusy = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (typeof onCompleted === "function") onCompleted();
    } catch (error) {
      console.error(error);
      completionBusy = false;
      renderedSignature = "";
      render();
      toast(error && error.message ? error.message : "Couldn't save your Heaven Booth visit — please try again.");
    }
  }

  function init(options) {
    if (initialized) {
      refresh();
      return;
    }
    initialized = true;
    onCompleted = options && options.onCompleted;
    container = document.getElementById(options && options.containerId ? options.containerId : "booth-content");
    if (!container) return;
    container.addEventListener("click", (event) => {
      if (event.target.closest("#btn-story-retry")) refresh();
      if (event.target.closest("#btn-booth-done")) completeVisit();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener("focus", refresh);
    refresh();
    schedulePoll();
  }

  return { init };
})();
