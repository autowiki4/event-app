"use strict";

const http = require("http");
const https = require("https");

const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_TIMEOUT_MS = 10000;
const INITIAL_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const TAB_HEADERS = Object.freeze({
  Attendees: Object.freeze([
    "attendeeId", "aliasIds", "name", "phone", "raffleNumber", "wristbandColor",
    "registeredAt", "wristbandConfirmedAt", "phase3CompletedAt", "completedBoothIds",
    "completedBoothCount", "signupOptionIds",
  ]),
  BoothResults: Object.freeze([
    "id", "attendeeId", "name", "phone", "raffleNumber", "wristbandColor", "boothId",
    "boothName", "checkedInBy", "checkedInAt", "sessionNumber", "runId", "runNumber",
    "score", "correctCount", "answeredCount", "totalQuestions", "votedFor",
    "featuredWinner", "extraData",
  ]),
  SignUps: Object.freeze([
    "id", "attendeeId", "name", "phone", "raffleNumber", "wristbandColor", "optionId",
    "optionTitle", "submittedAt", "confirmedInPerson", "confirmedBy", "confirmedAt",
  ]),
  TriviaAnswers: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "questionId", "questionNumber", "answerIndex", "isCorrect",
    "answeredAt",
  ]),
  HeavenConfirmations: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "action", "confirmedAt",
  ]),
  SongVotes: Object.freeze([
    "id", "attendeeId", "name", "raffleNumber", "wristbandColor", "sessionNumber",
    "runId", "runNumber", "songTitle", "votedAt", "updatedAt",
  ]),
  ExportMeta: Object.freeze(["key", "value"]),
});

// Keep the Sheet useful for operations without turning Art reflection fields
// into a second free-text data store. They remain in the authoritative Node
// database but are deliberately omitted from the export mirror.
const EXPORTED_BOOTH_METADATA_FIELDS = Object.freeze([
  "sessionNumber", "runId", "runNumber", "promptShown", "reachedBeat",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function normalizedCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  const text = String(value);
  // The Apps Script sink applies the same guard. Keeping it here too means a
  // captured or redirected payload is already safe to place into a Sheet.
  return (/^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text)) ? `'${text}` : text;
}

function jsonCell(value, fallback) {
  let normalized = value;
  if (normalized === undefined || normalized === null) normalized = fallback;
  try {
    return normalizedCell(JSON.stringify(normalized));
  } catch (error) {
    return normalizedCell(JSON.stringify(fallback));
  }
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function exportedBoothMetadata(value) {
  const source = objectOrEmpty(value);
  const exported = {};
  EXPORTED_BOOTH_METADATA_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) return;
    const selected = source[field];
    if (selected === null || selected === undefined) return;
    if (["string", "number", "boolean"].includes(typeof selected)) exported[field] = selected;
  });
  return exported;
}

function attendeeIndexes(db) {
  const byId = new Map();
  const byNameAndPhone = new Map();
  arrayOrEmpty(db.attendees).forEach((attendee) => {
    if (!attendee || typeof attendee !== "object") return;
    [attendee.attendeeId, ...arrayOrEmpty(attendee.aliasIds)].forEach((attendeeId) => {
      if (attendeeId) byId.set(String(attendeeId), attendee);
    });
    const identityKey = attendee.name && attendee.phone
      ? `${String(attendee.name).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")}|${String(attendee.phone).replace(/\D/g, "")}`
      : "";
    if (identityKey) byNameAndPhone.set(identityKey, attendee);
  });
  return { byId, byNameAndPhone };
}

function attendeeForRow(indexes, row) {
  if (!row || typeof row !== "object") return null;
  if (row.attendeeId && indexes.byId.has(String(row.attendeeId))) {
    return indexes.byId.get(String(row.attendeeId));
  }
  const identityKey = row.name && row.phone
    ? `${String(row.name).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")}|${String(row.phone).replace(/\D/g, "")}`
    : "";
  if (identityKey && indexes.byNameAndPhone.has(identityKey)) {
    return indexes.byNameAndPhone.get(identityKey);
  }
  return null;
}

function attendeeValue(attendee, key, fallback = "") {
  return attendee && attendee[key] !== undefined && attendee[key] !== null
    ? attendee[key]
    : fallback;
}

function tab(headers, rows) {
  return {
    headers: headers.slice(),
    rows: rows.map((row) => row.map(normalizedCell)),
  };
}

function buildExportSnapshot(rawDb, options = {}) {
  const db = rawDb && typeof rawDb === "object" ? rawDb : {};
  const generatedAt = options.generatedAt || new Date().toISOString();
  const indexes = attendeeIndexes(db);
  const checkins = arrayOrEmpty(db.boothCheckins);
  const signups = arrayOrEmpty(db.signups);

  const attendeesRows = arrayOrEmpty(db.attendees).map((attendee) => {
    const attendeeIds = new Set([
      attendee.attendeeId,
      ...arrayOrEmpty(attendee.aliasIds),
    ].filter(Boolean).map(String));
    const completedBoothIds = Array.from(new Set(checkins
      .filter((checkin) => (
        attendeeIds.has(String(checkin.attendeeId || ""))
          || (!checkin.attendeeId && attendeeForRow(indexes, checkin) === attendee)
      ))
      .map((checkin) => String(checkin.boothId || ""))
      .filter(Boolean)))
      .sort();
    const signupOptionIds = Array.from(new Set(signups
      .filter((signup) => (
        attendeeIds.has(String(signup.attendeeId || ""))
          || (!signup.attendeeId && attendeeForRow(indexes, signup) === attendee)
      ))
      .map((signup) => String(signup.optionId || ""))
      .filter(Boolean)))
      .sort();
    return [
      attendee.attendeeId,
      jsonCell(arrayOrEmpty(attendee.aliasIds), []),
      attendee.name,
      attendee.phone,
      attendee.raffleNumber,
      attendee.wristbandColor,
      attendee.registeredAt,
      attendee.wristbandConfirmedAt,
      attendee.phase3CompletedAt,
      jsonCell(completedBoothIds, []),
      completedBoothIds.length,
      jsonCell(signupOptionIds, []),
    ];
  });

  const boothRows = checkins.map((checkin) => {
    const attendee = attendeeForRow(indexes, checkin);
    const extra = objectOrEmpty(checkin.extraData);
    const boothOnlyResult = checkin.boothId === "trivia" || checkin.boothId === "newsong";
    return [
      checkin.id,
      attendeeValue(attendee, "attendeeId", checkin.attendeeId),
      attendeeValue(attendee, "name", checkin.name),
      attendeeValue(attendee, "phone", checkin.phone),
      attendeeValue(attendee, "raffleNumber"),
      attendeeValue(attendee, "wristbandColor"),
      checkin.boothId,
      checkin.boothName,
      checkin.checkedInBy,
      checkin.checkedInAt,
      extra.sessionNumber,
      extra.runId,
      extra.runNumber,
      boothOnlyResult ? "" : extra.score,
      boothOnlyResult ? "" : extra.correctCount,
      boothOnlyResult ? "" : extra.answeredCount,
      boothOnlyResult ? "" : extra.totalQuestions,
      boothOnlyResult ? "" : extra.votedFor,
      boothOnlyResult ? "" : extra.featuredWinner,
      jsonCell(exportedBoothMetadata(extra), {}),
    ];
  });

  const signupRows = signups.map((signup) => {
    const attendee = attendeeForRow(indexes, signup);
    return [
      signup.id,
      attendeeValue(attendee, "attendeeId", signup.attendeeId),
      attendeeValue(attendee, "name", signup.name),
      attendeeValue(attendee, "phone", signup.phone),
      attendeeValue(attendee, "raffleNumber"),
      attendeeValue(attendee, "wristbandColor"),
      signup.optionId,
      signup.optionTitle,
      signup.submittedAt,
      signup.confirmedInPerson,
      signup.confirmedBy,
      signup.confirmedAt,
    ];
  });

  // Bible Bowl answers and New Song votes are booth-only operational data.
  // Keep their tab contracts so the existing Apps Script deployment can
  // atomically clear older rows without changing its URL or credentials.
  const triviaRows = [];

  const heavenRows = arrayOrEmpty(db.heavenConfirmations).map((confirmation) => {
    const attendee = attendeeForRow(indexes, confirmation);
    return [
      confirmation.id,
      attendeeValue(attendee, "attendeeId", confirmation.attendeeId),
      attendeeValue(attendee, "name"),
      attendeeValue(attendee, "raffleNumber"),
      attendeeValue(attendee, "wristbandColor"),
      confirmation.sessionNumber,
      confirmation.runId,
      confirmation.runNumber,
      confirmation.action,
      confirmation.confirmedAt,
    ];
  });

  const songRows = [];

  const rowCounts = {
    Attendees: attendeesRows.length,
    BoothResults: boothRows.length,
    SignUps: signupRows.length,
    TriviaAnswers: triviaRows.length,
    HeavenConfirmations: heavenRows.length,
    SongVotes: songRows.length,
  };
  const exportMetaRows = [
    ["schemaVersion", 1],
    ["generatedAt", generatedAt],
    ["dataResetAt", db.dataResetAt || "initial"],
    ...Object.entries(rowCounts).map(([name, count]) => [`${name}.rowCount`, count]),
  ];

  return {
    generatedAt,
    dataResetAt: db.dataResetAt || "initial",
    tabs: {
      Attendees: tab(TAB_HEADERS.Attendees, attendeesRows),
      BoothResults: tab(TAB_HEADERS.BoothResults, boothRows),
      SignUps: tab(TAB_HEADERS.SignUps, signupRows),
      TriviaAnswers: tab(TAB_HEADERS.TriviaAnswers, triviaRows),
      HeavenConfirmations: tab(TAB_HEADERS.HeavenConfirmations, heavenRows),
      SongVotes: tab(TAB_HEADERS.SongVotes, songRows),
      ExportMeta: tab(TAB_HEADERS.ExportMeta, exportMetaRows),
    },
  };
}

function importUrl(baseUrl) {
  const url = new URL(String(baseUrl || "").trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = trimmedPath.endsWith("/importNodeSnapshot")
    ? trimmedPath
    : `${trimmedPath}/importNodeSnapshot`;
  return url.toString();
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4Parts = normalized.split(".");
  const isLoopbackIpv4 = ipv4Parts.length === 4
    && ipv4Parts[0] === "127"
    && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || isLoopbackIpv4;
}

function validExportUrl(url) {
  if (url.username || url.password) return false;
  return url.protocol === "https:"
    || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
}

function requestJson(urlValue, body, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redirectsRemaining = options.redirectsRemaining === undefined
    ? 5
    : options.redirectsRemaining;
  const method = options.method || "POST";
  const serialized = method === "GET" ? "" : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlValue);
    } catch (error) {
      reject(new Error("Google Sheets export URL is invalid."));
      return;
    }
    if (!validExportUrl(url)) {
      reject(new Error("Google Sheets export URL must use HTTPS outside loopback."));
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const headers = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(serialized);
    }
    const request = transport.request(url, { method, headers }, (response) => {
      const status = Number(response.statusCode) || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error("Google Sheets export followed too many redirects."));
          return;
        }
        const redirected = new URL(response.headers.location, url);
        const redirectedMethod = [301, 302, 303].includes(status) ? "GET" : method;
        if (url.protocol === "https:" && redirected.protocol !== "https:") {
          reject(new Error("Google Sheets export refused an insecure redirect."));
          return;
        }
        if (redirectedMethod !== "GET" && redirected.origin !== url.origin) {
          reject(new Error("Google Sheets export refused to resend data across origins."));
          return;
        }
        requestJson(redirected.toString(), body, {
          timeoutMs,
          redirectsRemaining: redirectsRemaining - 1,
          method: redirectedMethod,
        }).then(resolve, reject);
        return;
      }

      let responseBody = "";
      let responseBytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Google Sheets export response was too large."));
          return;
        }
        responseBody += chunk;
      });
      response.on("end", () => {
        let parsed = {};
        try {
          parsed = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          reject(new Error("Google Sheets export returned an invalid response."));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error(`Google Sheets export returned HTTP ${status}.`));
          return;
        }
        if (parsed && parsed.error) {
          const exportError = new Error(String(parsed.error));
          if (parsed.code) exportError.code = String(parsed.code);
          reject(exportError);
          return;
        }
        resolve(parsed);
      });
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Google Sheets export timed out."));
    });
    request.on("error", reject);
    if (serialized) request.write(serialized);
    request.end();
  });
}

function sanitizedError(error, redactedValues = []) {
  let message = error && error.message ? String(error.message) : "Google Sheets export failed.";
  redactedValues.filter(Boolean).forEach((value) => {
    message = message.split(String(value)).join("[redacted]");
  });
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function rowCountsForSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.tabs)
    .filter(([name]) => name !== "ExportMeta")
    .map(([name, value]) => [name, value.rows.length]));
}

function createGoogleSheetsExporter(options = {}) {
  if (typeof options.getSnapshot !== "function") {
    throw new TypeError("getSnapshot is required for the Google Sheets exporter.");
  }
  const env = options.env || process.env;
  const logger = options.logger || console;
  const send = options.requestJson || requestJson;
  const configuredUrl = String(env.EVENT_APP_SHEETS_EXPORT_URL || "").trim();
  const exportKey = String(env.EVENT_APP_SHEETS_EXPORT_KEY || "").trim();
  const debounceMs = boundedInteger(
    env.EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS,
    DEFAULT_DEBOUNCE_MS,
    0,
    60000
  );
  const timeoutMs = boundedInteger(
    env.EVENT_APP_SHEETS_EXPORT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1000,
    60000
  );
  let endpoint = "";
  let configurationError = null;
  if (configuredUrl || exportKey) {
    if (!configuredUrl || !exportKey) {
      configurationError = "Both Google Sheets export environment variables are required.";
    } else {
      try {
        endpoint = importUrl(configuredUrl);
        const parsed = new URL(endpoint);
        if (!validExportUrl(parsed)) {
          configurationError = "Google Sheets export URL must use HTTPS outside loopback.";
        }
      } catch (error) {
        configurationError = "Google Sheets export URL is invalid.";
      }
    }
  }
  const configured = Boolean(endpoint && exportKey && !configurationError);

  let dirty = false;
  let timer = null;
  let inFlight = null;
  let retryDelayMs = INITIAL_RETRY_MS;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastError = configurationError;
  let lastRowCounts = null;
  let nextRetryAt = null;

  function publicStatus() {
    let state = "idle";
    if (!configured) state = "disabled";
    else if (inFlight) state = "syncing";
    else if (lastError) state = "error";
    else if (dirty || timer) state = "pending";
    return {
      configured,
      state,
      pending: Boolean(dirty || timer),
      syncing: Boolean(inFlight),
      lastAttemptAt,
      lastSuccessAt,
      lastError,
      lastRowCounts: lastRowCounts ? { ...lastRowCounts } : null,
      nextRetryAt,
    };
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    nextRetryAt = null;
  }

  function schedule(delayMs, isRetry = false) {
    if (!configured || timer) return;
    const delay = Math.max(0, delayMs);
    nextRetryAt = isRetry ? new Date(Date.now() + delay).toISOString() : null;
    timer = setTimeout(() => {
      timer = null;
      nextRetryAt = null;
      flush();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  function markDirty() {
    if (!configured) return publicStatus();
    dirty = true;
    if (!inFlight) schedule(debounceMs, false);
    return publicStatus();
  }

  function queueImmediate() {
    if (!configured) return publicStatus();
    dirty = true;
    clearTimer();
    if (!inFlight) schedule(0, false);
    return publicStatus();
  }

  async function flush() {
    if (!configured) return publicStatus();
    if (inFlight) {
      await inFlight;
      return publicStatus();
    }
    if (!dirty) return publicStatus();
    clearTimer();
    dirty = false;
    lastAttemptAt = new Date().toISOString();

    const operation = (async () => {
      try {
        const snapshot = buildExportSnapshot(options.getSnapshot());
        await send(endpoint, { exportKey, snapshot }, { timeoutMs });
        lastSuccessAt = new Date().toISOString();
        lastError = null;
        lastRowCounts = rowCountsForSnapshot(snapshot);
        retryDelayMs = INITIAL_RETRY_MS;
      } catch (error) {
        let endpointHost = "";
        try { endpointHost = new URL(endpoint).hostname; } catch (urlError) { /* already validated */ }
        lastError = sanitizedError(error, [exportKey, configuredUrl, endpoint, endpointHost]);
        dirty = true;
        if (logger && typeof logger.error === "function") {
          try {
            logger.error(`Google Sheets export failed: ${lastError}`);
          } catch (loggingError) {
            // Export status remains available even if a supplied logger fails.
          }
        }
      }
    })();
    inFlight = operation;
    try {
      await operation;
    } finally {
      inFlight = null;
      if (dirty) {
        const delay = lastError ? retryDelayMs : debounceMs;
        if (lastError) retryDelayMs = Math.min(MAX_RETRY_MS, retryDelayMs * 2);
        schedule(delay, Boolean(lastError));
      }
    }
    return publicStatus();
  }

  return Object.freeze({
    configured: () => configured,
    status: publicStatus,
    markDirty,
    queueImmediate,
    flush,
  });
}

module.exports = {
  TAB_HEADERS,
  buildExportSnapshot,
  createGoogleSheetsExporter,
  normalizedCell,
  requestJson,
};
