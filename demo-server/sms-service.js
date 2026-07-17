/* Zero-dependency SMS delivery for the first-time attendee welcome code.
 *
 * Local rehearsal defaults to console delivery. Render/production defaults
 * to disabled unless Twilio is configured explicitly. Test delivery never
 * reaches a carrier and is accepted only when NODE_ENV=test.
 */
const https = require("https");

function configurationError(message) {
  const error = new Error(message);
  error.code = "SMS_NOT_CONFIGURED";
  error.status = 503;
  return error;
}

function deliveryError(message, status = 502) {
  const error = new Error(message);
  error.code = "SMS_DELIVERY_FAILED";
  error.status = status;
  return error;
}

function normalizedMode(env) {
  const explicit = String(env.EVENT_APP_SMS_MODE || "").trim().toLowerCase();
  if (explicit) return explicit;
  return env.NODE_ENV === "production" || env.RENDER ? "disabled" : "console";
}

function createSmsService(env = process.env) {
  const mode = normalizedMode(env);
  const accountSid = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || "").trim();
  const messagingServiceSid = String(env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const fromNumber = String(env.TWILIO_FROM_NUMBER || "").trim();

  function configured() {
    if (mode === "console") return env.NODE_ENV !== "production" && !env.RENDER;
    if (mode === "test") return env.NODE_ENV === "test";
    if (mode !== "twilio") return false;
    return Boolean(accountSid && authToken && (messagingServiceSid || fromNumber));
  }

  function status() {
    return { mode, configured: configured() };
  }

  function sendWithTwilio(to, body) {
    if (!configured()) {
      return Promise.reject(configurationError(
        "Twilio SMS requires an account SID, auth token, and either a Messaging Service SID or sender number."
      ));
    }
    const params = new URLSearchParams({ To: to, Body: body });
    if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
    else params.set("From", fromNumber);
    const payload = params.toString();
    const requestPath = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: "api.twilio.com",
        port: 443,
        path: requestPath,
        method: "POST",
        auth: `${accountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10000,
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => {
          let parsed = {};
          try { parsed = responseBody ? JSON.parse(responseBody) : {}; }
          catch (error) { /* the status code remains authoritative */ }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({
              provider: "twilio",
              messageSid: typeof parsed.sid === "string" ? parsed.sid : null,
              status: typeof parsed.status === "string" ? parsed.status : "accepted",
            });
            return;
          }
          reject(deliveryError(
            typeof parsed.message === "string" ? parsed.message : "Twilio rejected the SMS request."
          ));
        });
      });
      request.on("timeout", () => request.destroy(deliveryError("Twilio SMS delivery timed out.", 504)));
      request.on("error", (error) => {
        reject(error && error.code === "SMS_DELIVERY_FAILED"
          ? error
          : deliveryError("The SMS provider could not be reached."));
      });
      request.write(payload);
      request.end();
    });
  }

  async function send({ phoneDigits, body }) {
    const digits = String(phoneDigits || "").replace(/\D/g, "");
    if (digits.length !== 10) throw deliveryError("A valid 10-digit phone number is required.", 400);
    if (!configured()) throw configurationError("Welcome-text delivery is not configured on this server.");
    const to = `+1${digits}`;
    if (mode === "twilio") return sendWithTwilio(to, body);
    if (mode === "test") return { provider: "test", messageSid: "SM_TEST", status: "queued" };
    // Console mode is deliberately local-only. It gives a no-credential
    // rehearsal a real OTP flow without pretending a carrier received it.
    console.log(`[local SMS to ***-***-${digits.slice(-4)}] ${body}`);
    return { provider: "console", messageSid: null, status: "logged" };
  }

  return { configured, send, status };
}

module.exports = { createSmsService };
