/* Bible Bowl attendee controller.
 *
 * Questions, answer reveals, and scores come from the backend so every phone
 * follows the booth leader's pace. The public browser bundle intentionally
 * contains no answer key and never calculates its own score.
 */
const TriviaAttendee = (() => {
  const PHASES = new Set(["welcome", "question", "reveal", "complete"]);
  let initialized = false;
  let container = null;
  let identity = null;
  let state = null;
  let stateSignature = "";
  let refreshBusy = false;
  let refreshQueued = false;
  let answerBusy = false;
  let completionBusy = false;
  let interactionEpoch = 0;
  let pollTimer = null;
  let onCompleted = null;

  function integer(value, fallback = null) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function normalizeQuestion(value) {
    const question = object(value);
    if (!question.id || !Array.isArray(question.choices)) return null;
    return {
      id: String(question.id),
      number: Math.max(1, integer(question.number, 1)),
      category: String(question.category || "Bible Bowl"),
      text: String(question.text || ""),
      choices: question.choices.map((choice) => String(choice)),
    };
  }

  function normalizeAnswer(value) {
    const answer = object(value);
    const answerIndex = integer(answer.answerIndex);
    if (answerIndex === null || answerIndex < 0) return null;
    return {
      answerIndex,
      isCorrect: typeof answer.isCorrect === "boolean" ? answer.isCorrect : null,
    };
  }

  function normalizeCorrectAnswer(value) {
    const answer = object(value);
    const answerIndex = integer(answer.answerIndex);
    if (answerIndex === null || answerIndex < 0) return null;
    return { answerIndex, text: String(answer.text || "") };
  }

  function normalizeTopThree(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).map((entry, index) => {
      const row = object(entry);
      return {
        rank: Math.max(1, integer(row.rank, index + 1)),
        name: String(row.name || "Guest"),
        raffleNumber: String(row.raffleNumber || ""),
        correctCount: Math.max(0, integer(row.correctCount, 0)),
        totalQuestions: Math.max(0, integer(row.totalQuestions, 0)),
      };
    });
  }

  function normalizeState(value) {
    const raw = object(value);
    const phaseValue = String(raw.phase || "welcome").trim().toLowerCase();
    const phase = PHASES.has(phaseValue) ? phaseValue : "welcome";
    const assignedColor = object(raw.assignedColor);
    const score = object(raw.score);
    const questionCount = Math.max(0, integer(raw.questionCount, integer(score.totalQuestions, 0)));
    return {
      sessionNumber: Math.max(0, integer(raw.sessionNumber, 0)),
      sessionLabel: String(raw.sessionLabel || ""),
      runId: String(raw.runId || ""),
      runNumber: Math.max(1, integer(raw.runNumber, 1)),
      assignedColor: {
        id: String(assignedColor.id || ""),
        label: String(assignedColor.label || ""),
      },
      phase,
      version: Math.max(0, integer(raw.version, 0)),
      questionCount,
      question: normalizeQuestion(raw.question),
      answer: normalizeAnswer(raw.answer),
      correctAnswer: phase === "reveal" ? normalizeCorrectAnswer(raw.correctAnswer) : null,
      score: {
        correctCount: Math.max(0, integer(score.correctCount, 0)),
        answeredCount: Math.max(0, integer(score.answeredCount, 0)),
        totalQuestions: Math.max(0, integer(score.totalQuestions, questionCount)),
      },
      topThree: phase === "complete" ? normalizeTopThree(raw.topThree) : [],
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
      question: value.question,
      answer: value.answer,
      correctAnswer: value.correctAnswer,
      score: value.score,
      topThree: value.topThree,
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

  function renderLoading() {
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <div class="trivia-stage">
        <p class="eyebrow">Joining Bible Bowl…</p>
        <div class="trivia-loading-bars" aria-hidden="true"><span></span><span></span><span></span></div>
      </div>
    `;
  }

  function renderWelcome(value) {
    container.innerHTML = `
      <div class="trivia-stage trivia-welcome">
        <div class="trivia-stage-icon" aria-hidden="true">🏆</div>
        <span class="status-pill waiting">Waiting for your host</span>
        <h2>Welcome to Bible Bowl!</h2>
        <p class="trivia-stage-copy">Get ready to put your Bible knowledge to the test. Everyone will play one question at a time, together.</p>
        <div class="trivia-host-note"><span aria-hidden="true">✨</span><span>Keep this screen open. Question 1 will appear as soon as your host starts.</span></div>
        ${sessionLine(value) ? `<p class="trivia-sync-note">${escapeHtml(sessionLine(value))}</p>` : ""}
      </div>
    `;
  }

  function choiceState(value, index) {
    const selected = value.answer && value.answer.answerIndex === index;
    const correct = value.phase === "reveal"
      && value.correctAnswer
      && value.correctAnswer.answerIndex === index;
    if (correct) return { className: "is-correct", marker: "✓", label: "Correct answer" };
    if (value.phase === "reveal" && selected) return { className: "is-selected-wrong", marker: "×", label: "Your answer" };
    if (value.phase === "question" && selected) return { className: "is-selected-waiting", marker: "🔒", label: "Your locked answer" };
    return { className: "", marker: "", label: "" };
  }

  function revealMessage(value) {
    const correctText = value.correctAnswer && value.correctAnswer.text
      ? value.correctAnswer.text
      : value.question && value.correctAnswer
        ? value.question.choices[value.correctAnswer.answerIndex] || "the highlighted choice"
        : "the highlighted choice";
    if (!value.answer) {
      return {
        className: "incorrect",
        icon: "💡",
        title: "The answer is revealed",
        text: `The correct answer is ${correctText}. Get ready for the next question.`,
      };
    }
    const isCorrect = typeof value.answer.isCorrect === "boolean"
      ? value.answer.isCorrect
      : Boolean(value.correctAnswer && value.answer.answerIndex === value.correctAnswer.answerIndex);
    return isCorrect
      ? {
          className: "correct",
          icon: "🎉",
          title: "That's right!",
          text: "Nice work. Keep this screen open while your host gets the next question ready.",
        }
      : {
          className: "incorrect",
          icon: "💡",
          title: "Good try!",
          text: `The correct answer is ${correctText}. Every question is another chance to learn.`,
        };
  }

  function renderQuestion(value) {
    const question = value.question;
    if (!question) {
      container.innerHTML = `
        <div class="trivia-stage trivia-welcome">
          <div class="trivia-stage-icon" aria-hidden="true">⏳</div>
          <span class="status-pill waiting">Almost ready</span>
          <h2>Your next question is loading.</h2>
          <p class="trivia-stage-copy">Keep this screen open — it will appear automatically.</p>
        </div>
      `;
      return;
    }

    const answered = Boolean(value.answer);
    const choices = question.choices.map((choice, index) => {
      const visual = choiceState(value, index);
      const disabled = answerBusy || answered || value.phase === "reveal";
      return `
        <button type="button" class="poll-opt trivia-choice ${visual.className}" data-trivia-answer="${index}"
          ${disabled ? "disabled" : ""} aria-pressed="${answered && value.answer.answerIndex === index ? "true" : "false"}"
          ${visual.label ? `aria-label="${escapeHtml(choice)} — ${escapeHtml(visual.label)}"` : ""}>
          ${escapeHtml(choice)}
          ${visual.marker ? `<span class="trivia-choice-marker" aria-hidden="true">${visual.marker}</span>` : ""}
        </button>
      `;
    }).join("");

    let response = `<p class="trivia-prompt">Choose one answer. Once it is locked in, it cannot be changed.</p>`;
    if (value.phase === "question" && answered) {
      response = `
        <div class="trivia-answer-state waiting" role="status">
          <span class="trivia-answer-icon" aria-hidden="true">🤔</span>
          <div><strong>Answer locked in!</strong>Hmm… I wonder if it's correct. Keep this screen open and wait for the big reveal.</div>
        </div>
      `;
    }
    if (value.phase === "reveal") {
      const result = revealMessage(value);
      response = `
        <div class="trivia-answer-state ${result.className}" role="status">
          <span class="trivia-answer-icon" aria-hidden="true">${result.icon}</span>
          <div><strong>${escapeHtml(result.title)}</strong>${escapeHtml(result.text)}</div>
        </div>
      `;
    }

    const totalQuestions = value.score.totalQuestions || value.questionCount;
    container.innerHTML = `
      <div class="trivia-stage">
        <div class="trivia-question-meta">
          <span class="trivia-category">${escapeHtml(question.category)}</span>
          <span class="trivia-question-count">Question ${question.number}${totalQuestions ? ` of ${totalQuestions}` : ""}</span>
        </div>
        <h2 class="trivia-question">${escapeHtml(question.text)}</h2>
        <div>${choices}</div>
        ${response}
      </div>
    `;
  }

  function renderResults(value) {
    const correctCount = value.score.correctCount;
    const totalQuestions = value.score.totalQuestions || value.questionCount;
    const podium = value.topThree.length
      ? `<section class="trivia-podium" aria-label="Bible Bowl top three">
          <h3>Session top 3</h3>
          <div>${value.topThree.map((entry) => `
            <article class="place-${entry.rank}">
              <span aria-hidden="true">${entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : "🥉"}</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <small>Raffle #${escapeHtml(entry.raffleNumber || "----")} · ${entry.correctCount}/${entry.totalQuestions || totalQuestions}</small>
            </article>`).join("")}</div>
        </section>`
      : `<p class="trivia-podium-empty">No ranked scores were recorded in this run.</p>`;
    container.innerHTML = `
      <div class="trivia-stage trivia-results">
        <div class="trivia-stage-icon" aria-hidden="true">🎊</div>
        <p class="eyebrow">Bible Bowl complete</p>
        <h2>You did it!</h2>
        <div class="trivia-score" aria-label="${correctCount} of ${totalQuestions} correct">
          <strong>${correctCount}</strong><span>of ${totalQuestions} correct</span>
        </div>
        <p class="trivia-stage-copy">Great job learning more about the Bible. Every answer helped you grow!</p>
        ${podium}
        <button type="button" class="btn btn-primary" id="btn-trivia-done">Finish booth →</button>
        ${sessionLine(value) ? `<p class="trivia-sync-note">${escapeHtml(sessionLine(value))}</p>` : ""}
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
    else if (state.phase === "question" || state.phase === "reveal") renderQuestion(state);
    else renderResults(state);
  }

  function applyState(nextValue) {
    const next = normalizeState(nextValue);
    if (
      state
      && state.sessionNumber === next.sessionNumber
      && Number.isFinite(state.version)
      && next.version < state.version
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
        <div class="trivia-stage trivia-error">
          <div class="trivia-stage-icon" aria-hidden="true">📶</div>
          <h2>We're reconnecting.</h2>
          <p class="trivia-stage-copy">${escapeHtml(message)}</p>
          <button type="button" class="btn btn-primary" id="btn-trivia-retry">Try again</button>
        </div>
      `;
      return;
    }
    let note = container.querySelector("[data-trivia-sync-issue]");
    if (!note) {
      note = document.createElement("p");
      note.className = "trivia-sync-note";
      note.dataset.triviaSyncIssue = "true";
      container.firstElementChild.appendChild(note);
    }
    note.textContent = message;
  }

  function clearSyncIssue() {
    const note = container && container.querySelector("[data-trivia-sync-issue]");
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
      const result = await EventAPI.triviaState(identity.attendeeId);
      if (expectedEpoch !== interactionEpoch) return false;
      applyState(result);
      clearSyncIssue();
      return true;
    } catch (error) {
      console.error(error);
      showSyncIssue("Question updates are temporarily offline. Keep this page open and we'll reconnect automatically.");
      return false;
    } finally {
      refreshBusy = false;
      if (refreshQueued) {
        refreshQueued = false;
        window.setTimeout(() => refreshState(true), 0);
      }
    }
  }

  async function submitAnswer(answerIndex) {
    if (answerBusy || completionBusy || !state || state.phase !== "question" || !state.question || state.answer) return;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= state.question.choices.length) return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Bible Bowl session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }

    const previousState = state;
    answerBusy = true;
    interactionEpoch += 1;
    state = {
      ...state,
      answer: { answerIndex, isCorrect: null },
    };
    stateSignature = signature(state);
    renderState();
    try {
      await EventAPI.submitTriviaAnswer(identity.attendeeId, previousState.question.id, answerIndex);
    } catch (error) {
      console.error(error);
      state = previousState;
      stateSignature = signature(state);
      renderState();
      toast(error && error.message ? error.message : "Couldn't lock that answer — please try again.");
    } finally {
      answerBusy = false;
      refreshState(true);
    }
  }

  async function completeTrivia() {
    if (completionBusy || !state || state.phase !== "complete") return;
    if (typeof window.isCurrentBoothRoomOpen === "function" && !window.isCurrentBoothRoomOpen()) {
      toast("This Bible Bowl session has ended. Return to your schedule.");
      if (typeof window.refreshBoothRoomAccess === "function") window.refreshBoothRoomAccess();
      return;
    }
    completionBusy = true;
    interactionEpoch += 1;
    const button = document.getElementById("btn-trivia-done");
    if (button) {
      button.disabled = true;
      button.textContent = "Saving your score…";
    }
    try {
      const result = await EventAPI.completeTrivia(identity.attendeeId);
      const savedScore = object(result && result.score);
      state = {
        ...state,
        score: {
          correctCount: Math.max(0, integer(savedScore.correctCount, state.score.correctCount)),
          answeredCount: Math.max(0, integer(savedScore.answeredCount, state.score.answeredCount)),
          totalQuestions: Math.max(0, integer(savedScore.totalQuestions, state.score.totalQuestions)),
        },
      };
      stateSignature = signature(state);
      completionBusy = false;
      renderState();
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
      if (typeof onCompleted === "function") onCompleted(result);
    } catch (error) {
      console.error(error);
      completionBusy = false;
      renderState();
      toast(error && error.message ? error.message : "Couldn't save your Bible Bowl score — please try again.");
    }
  }

  function handleClick(event) {
    const answer = event.target.closest("[data-trivia-answer]");
    if (answer) {
      submitAnswer(integer(answer.dataset.triviaAnswer, -1));
      return;
    }
    if (event.target.closest("#btn-trivia-retry")) {
      renderLoading();
      refreshState(true);
      return;
    }
    if (event.target.closest("#btn-trivia-done")) completeTrivia();
  }

  function init(options) {
    const settings = object(options);
    const target = document.getElementById(settings.containerId || "booth-content");
    if (!target) throw new Error("Bible Bowl attendee container is missing.");
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
      const pollInterval = Math.round(2500 * (0.85 + Math.random() * 0.3));
      pollTimer = window.setInterval(() => {
        if (!document.hidden && !answerBusy) refreshState(false);
      }, pollInterval);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshState(true);
      });
    }
    renderLoading();
    refreshState(true);
  }

  return { init, refresh: () => refreshState(true) };
})();
