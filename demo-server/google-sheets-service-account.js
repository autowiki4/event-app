"use strict";

const crypto = require("crypto");
const https = require("https");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE_URL = "https://sheets.googleapis.com/v4";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_ROWS_PER_TAB = 10000;
const MAX_CELL_LENGTH = 50000;
const TOKEN_REFRESH_MARGIN_MS = 60000;
const MANAGED_TAB_NAMES = Object.freeze([
  "Attendees",
  "BoothResults",
  "SignUps",
  "TriviaAnswers",
  "HeavenConfirmations",
  "SongVotes",
  "ExportMeta",
]);

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function configurationResult(error, details = {}, configured = false) {
  return Object.freeze({
    configured: Boolean(configured && !error),
    configurationError: error || null,
    spreadsheetId: details.spreadsheetId || "",
    clientEmail: details.clientEmail || "",
    privateKey: details.privateKey || "",
    privateKeyId: details.privateKeyId || "",
    encodedCredentials: details.encodedCredentials || "",
    redactedValues: Object.freeze((details.redactedValues || []).filter(Boolean)),
  });
}

function parseServiceAccountConfiguration(env = process.env) {
  const spreadsheetId = String(env.EVENT_APP_GOOGLE_SHEET_ID || "").trim();
  const encodedCredentials = String(
    env.EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || ""
  ).trim();
  const legacyUrl = String(env.EVENT_APP_SHEETS_EXPORT_URL || "").trim();
  const legacyKey = String(env.EVENT_APP_SHEETS_EXPORT_KEY || "").trim();
  const baseDetails = {
    spreadsheetId,
    encodedCredentials,
    redactedValues: [spreadsheetId, encodedCredentials, legacyUrl, legacyKey],
  };

  if (!spreadsheetId && !encodedCredentials) {
    if (legacyUrl || legacyKey) {
      return configurationResult(
        "The Apps Script export variables are no longer used. Configure the Google Sheet ID and service-account JSON instead.",
        baseDetails
      );
    }
    return configurationResult(null, baseDetails);
  }
  if (!spreadsheetId || !encodedCredentials) {
    return configurationResult(
      "Both EVENT_APP_GOOGLE_SHEET_ID and EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 are required.",
      baseDetails
    );
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
    return configurationResult(
      "EVENT_APP_GOOGLE_SHEET_ID must contain only the spreadsheet ID from between /d/ and /edit.",
      baseDetails
    );
  }
  const compactCredentials = encodedCredentials.replace(/\s+/g, "");
  if (
    compactCredentials.length === 0
    || compactCredentials.length > Math.ceil(MAX_CREDENTIAL_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactCredentials)
  ) {
    return configurationResult(
      "The Google service-account credential is not valid base64.",
      baseDetails
    );
  }

  let decoded;
  try {
    const decodedBuffer = Buffer.from(compactCredentials, "base64");
    if (decodedBuffer.length === 0 || decodedBuffer.length > MAX_CREDENTIAL_BYTES) {
      throw new Error("credential size");
    }
    const normalizedInput = compactCredentials.replace(/=+$/, "");
    const normalizedRoundTrip = decodedBuffer.toString("base64").replace(/=+$/, "");
    if (normalizedInput !== normalizedRoundTrip) throw new Error("credential encoding");
    decoded = JSON.parse(decodedBuffer.toString("utf8"));
  } catch (error) {
    return configurationResult(
      "The Google service-account credential could not be decoded as a JSON key.",
      baseDetails
    );
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return configurationResult("The decoded Google credential is not a service-account JSON key.", baseDetails);
  }
  const clientEmail = String(decoded.client_email || "").trim();
  const privateKey = String(decoded.private_key || "");
  const privateKeyId = String(decoded.private_key_id || "").trim();
  const details = {
    ...baseDetails,
    clientEmail,
    privateKey,
    privateKeyId,
    redactedValues: [
      ...baseDetails.redactedValues,
      clientEmail,
      privateKey,
      decoded.private_key_id,
    ],
  };
  if (decoded.type !== "service_account" || !clientEmail || !privateKey) {
    return configurationResult(
      "The decoded Google credential must be a service-account JSON key with client_email and private_key.",
      details
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(clientEmail)) {
    return configurationResult("The Google service-account client_email is invalid.", details);
  }
  try {
    const keyObject = crypto.createPrivateKey(privateKey);
    if (keyObject.asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch (error) {
    return configurationResult("The Google service-account private_key is invalid.", details);
  }
  return configurationResult(null, details, true);
}

function serviceAccountJwt(configuration, nowMs = Date.now()) {
  if (!configuration || !configuration.clientEmail || !configuration.privateKey) {
    throw new TypeError("A parsed service-account configuration is required.");
  }
  const issuedAt = Math.floor(Number(nowMs) / 1000);
  if (!Number.isFinite(issuedAt)) throw new TypeError("A valid JWT time is required.");
  const jwtHeader = { alg: "RS256", typ: "JWT" };
  if (configuration.privateKeyId) jwtHeader.kid = configuration.privateKeyId;
  const header = base64Url(JSON.stringify(jwtHeader));
  const claims = base64Url(JSON.stringify({
    iss: configuration.clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), configuration.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function googleHttpError(status, hostname) {
  let message;
  if (hostname === "oauth2.googleapis.com") {
    message = status === 429
      ? "Google service-account authentication is temporarily rate limited."
      : "Google service-account authentication failed. Check the JSON key and redeploy Render.";
  } else if (status === 401) {
    message = "Google Sheets authorization expired.";
  } else if (status === 403) {
    message = "Google Sheets access was denied. Enable the Sheets API and share the spreadsheet with the service account as Editor.";
  } else if (status === 404) {
    message = "The Google spreadsheet was not found. Check the Sheet ID and service-account sharing.";
  } else if (status === 429) {
    message = "Google Sheets is temporarily rate limited and will retry automatically.";
  } else if (status >= 500) {
    message = "Google Sheets is temporarily unavailable and will retry automatically.";
  } else {
    message = `Google Sheets returned HTTP ${status}.`;
  }
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function googleRequestJson(urlValue, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body === undefined || options.body === null
    ? ""
    : (typeof options.body === "string" ? options.body : JSON.stringify(options.body));

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlValue);
    } catch (error) {
      reject(new Error("Google Sheets request URL is invalid."));
      return;
    }
    if (
      url.protocol !== "https:"
      || !["oauth2.googleapis.com", "sheets.googleapis.com"].includes(url.hostname)
    ) {
      reject(new Error("Google Sheets requests are restricted to official Google endpoints."));
      return;
    }
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    const request = https.request(url, { method, headers }, (response) => {
      const status = Number(response.statusCode) || 0;
      let responseBody = "";
      let responseBytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Google Sheets response was too large."));
          return;
        }
        responseBody += chunk;
      });
      response.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(googleHttpError(status, url.hostname));
          return;
        }
        if (!responseBody) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(new Error("Google Sheets returned an invalid JSON response."));
        }
      });
      response.on("error", () => reject(new Error("Google Sheets response failed.")));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Google Sheets request timed out."));
    });
    request.on("error", (error) => {
      if (error && /^Google Sheets/.test(String(error.message || ""))) reject(error);
      else reject(new Error("Google Sheets network request failed."));
    });
    if (body) request.write(body);
    request.end();
  });
}

function createGoogleApiClient(configuration, options = {}) {
  const send = options.requestJson || googleRequestJson;
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const now = typeof options.now === "function" ? options.now : Date.now;
  let cachedToken = null;
  let tokenRequest = null;

  async function requestAccessToken() {
    const assertion = serviceAccountJwt(configuration, now());
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();
    const response = await send(TOKEN_URL, {
      method: "POST",
      timeoutMs,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const accessToken = response && typeof response.access_token === "string"
      ? response.access_token.trim()
      : "";
    if (!accessToken) throw new Error("Google service-account authentication returned no access token.");
    const expiresInSeconds = Number(response.expires_in);
    const expiresInMs = Number.isFinite(expiresInSeconds)
      ? Math.max(60000, Math.min(3600000, expiresInSeconds * 1000))
      : 3600000;
    cachedToken = {
      value: accessToken,
      expiresAt: now() + expiresInMs,
    };
    return cachedToken.value;
  }

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) {
      return cachedToken.value;
    }
    if (!tokenRequest) {
      tokenRequest = requestAccessToken().finally(() => { tokenRequest = null; });
    }
    return tokenRequest;
  }

  async function request(path, requestOptions = {}, canRetryAuthorization = true) {
    const token = await accessToken();
    try {
      return await send(`${SHEETS_API_BASE_URL}${path}`, {
        ...requestOptions,
        timeoutMs,
        headers: {
          ...(requestOptions.headers || {}),
          Authorization: `Bearer ${token}`,
          ...(requestOptions.body === undefined
            ? {}
            : { "Content-Type": "application/json; charset=utf-8" }),
        },
      });
    } catch (error) {
      if (canRetryAuthorization && error && error.statusCode === 401) {
        if (cachedToken && cachedToken.value === token) cachedToken = null;
        return request(path, requestOptions, false);
      }
      throw error;
    }
  }

  return Object.freeze({ request });
}

function scalarCellData(value) {
  if (value === undefined || value === null) return { userEnteredValue: { stringValue: "" } };
  if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Google Sheets export contains a non-finite number.");
    return { userEnteredValue: { numberValue: value } };
  }
  const text = String(value);
  if (text.length > MAX_CELL_LENGTH) throw new Error("Google Sheets export contains a cell that is too long.");
  return { userEnteredValue: { stringValue: text } };
}

function snapshotMatrices(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.tabs || typeof snapshot.tabs !== "object") {
    throw new Error("Google Sheets export snapshot is invalid.");
  }
  const incomingNames = Object.keys(snapshot.tabs).sort();
  const expectedNames = MANAGED_TAB_NAMES.slice().sort();
  if (
    incomingNames.length !== expectedNames.length
    || incomingNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Google Sheets export snapshot must contain exactly the managed tabs.");
  }
  return Object.fromEntries(MANAGED_TAB_NAMES.map((name) => {
    const selected = snapshot.tabs[name];
    if (!selected || !Array.isArray(selected.headers) || !Array.isArray(selected.rows)) {
      throw new Error(`Google Sheets export tab ${name} is invalid.`);
    }
    if (selected.headers.length === 0 || selected.rows.length > MAX_ROWS_PER_TAB) {
      throw new Error(`Google Sheets export tab ${name} has an invalid size.`);
    }
    const width = selected.headers.length;
    const matrix = [selected.headers, ...selected.rows];
    matrix.forEach((row) => {
      if (!Array.isArray(row) || row.length !== width) {
        throw new Error(`Google Sheets export tab ${name} has a row with the wrong width.`);
      }
    });
    return [name, matrix];
  }));
}

function sheetMapFromMetadata(metadata) {
  const sheets = metadata && Array.isArray(metadata.sheets) ? metadata.sheets : [];
  const result = new Map();
  sheets.forEach((sheet) => {
    const properties = sheet && sheet.properties;
    if (!properties || !Number.isInteger(properties.sheetId) || typeof properties.title !== "string") return;
    const grid = properties.gridProperties || {};
    result.set(properties.title, {
      sheetId: properties.sheetId,
      title: properties.title,
      rowCount: Math.max(1, Number(grid.rowCount) || 1),
      columnCount: Math.max(1, Number(grid.columnCount) || 1),
      frozenRowCount: Math.max(0, Number(grid.frozenRowCount) || 0),
    });
  });
  return result;
}

function allocateSheetId(title, usedIds) {
  const digest = crypto.createHash("sha256").update(`event-app:${title}`).digest();
  let candidate = digest.readUInt32BE(0) & 0x7fffffff;
  if (candidate === 0) candidate = 1;
  while (usedIds.has(candidate)) {
    candidate = candidate === 0x7fffffff ? 1 : candidate + 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function buildAtomicSnapshotRequests(snapshot, metadata) {
  const matrices = snapshotMatrices(snapshot);
  const existing = sheetMapFromMetadata(metadata);
  const usedIds = new Set(Array.from(existing.values()).map((sheet) => sheet.sheetId));
  const managedSheets = new Map();
  const requests = [];

  MANAGED_TAB_NAMES.forEach((name) => {
    const title = `Live_${name}`;
    const matrix = matrices[name];
    const requiredRows = Math.max(1, matrix.length);
    const requiredColumns = matrix[0].length;
    const current = existing.get(title);
    if (!current) {
      const sheet = {
        sheetId: allocateSheetId(title, usedIds),
        title,
        rowCount: requiredRows,
        columnCount: requiredColumns,
        frozenRowCount: 1,
      };
      managedSheets.set(name, sheet);
      requests.push({
        addSheet: {
          properties: {
            sheetId: sheet.sheetId,
            title,
            gridProperties: {
              rowCount: sheet.rowCount,
              columnCount: sheet.columnCount,
              frozenRowCount: 1,
            },
          },
        },
      });
      return;
    }
    const sheet = {
      ...current,
      rowCount: Math.max(current.rowCount, requiredRows),
      columnCount: Math.max(current.columnCount, requiredColumns),
      frozenRowCount: 1,
    };
    managedSheets.set(name, sheet);
    if (
      sheet.rowCount !== current.rowCount
      || sheet.columnCount !== current.columnCount
      || current.frozenRowCount !== 1
    ) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: sheet.sheetId,
            gridProperties: {
              rowCount: sheet.rowCount,
              columnCount: sheet.columnCount,
              frozenRowCount: 1,
            },
          },
          fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
        },
      });
    }
  });

  // ExportMeta is already last in MANAGED_TAB_NAMES. Google validates every
  // request before applying this batch, so the seven tab replacements are
  // atomic and a failed sync leaves the prior snapshot intact.
  MANAGED_TAB_NAMES.forEach((name) => {
    const sheet = managedSheets.get(name);
    const matrix = matrices[name];
    requests.push({
      updateCells: {
        range: {
          sheetId: sheet.sheetId,
          startRowIndex: 0,
          endRowIndex: sheet.rowCount,
          startColumnIndex: 0,
          endColumnIndex: sheet.columnCount,
        },
        rows: matrix.map((row) => ({ values: row.map(scalarCellData) })),
        fields: "userEnteredValue",
      },
    });
  });
  return requests;
}

function createGoogleSheetsServiceAccountSink(options = {}) {
  const env = options.env || process.env;
  const configuration = parseServiceAccountConfiguration(env);
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const api = configuration.configured
    ? createGoogleApiClient(configuration, {
      requestJson: options.requestJson,
      timeoutMs,
      now: options.now,
    })
    : null;

  async function writeSnapshot(snapshot) {
    if (!configuration.configured || !api) {
      throw new Error(configuration.configurationError || "Google Sheets export is not configured.");
    }
    const spreadsheetPath = `/spreadsheets/${encodeURIComponent(configuration.spreadsheetId)}`;
    const metadata = await api.request(
      `${spreadsheetPath}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount))`,
      { method: "GET" }
    );
    const requests = buildAtomicSnapshotRequests(snapshot, metadata);
    await api.request(`${spreadsheetPath}:batchUpdate`, {
      method: "POST",
      body: { requests, includeSpreadsheetInResponse: false },
    });
  }

  return Object.freeze({
    configured: configuration.configured,
    configurationError: configuration.configurationError,
    redactedValues: configuration.redactedValues,
    writeSnapshot,
  });
}

module.exports = {
  MANAGED_TAB_NAMES,
  buildAtomicSnapshotRequests,
  createGoogleApiClient,
  createGoogleSheetsServiceAccountSink,
  googleRequestJson,
  parseServiceAccountConfiguration,
  serviceAccountJwt,
};
