# Welcome-code SMS setup

Phase 1 now collects the attendee's name and 10-digit US mobile number. The
server reserves a raffle number, sends one welcome/verification text, and only
creates the attendee record after the six-digit code is verified. The text is:

```text
Welcome to The Perfect Summer Day! Code: 123456. Raffle #1001. Reopen anytime: https://YOUR-SITE/attend
```

`/attend` opens the attendee entry/resume screen. A verified attendee who still
needs a wristband returns to that step; an attendee whose wristband is already
assigned continues to the shared schedule, where the live event clock shows
the waiting lobby, current booth, or Phase 3 as appropriate. The link contains
no credential or attendee data; a different browser signs in with name and
phone without requesting another code. Raffle numbers remain visible but are
not used for attendee login.

## Access required for live texts

You need:

- a Twilio account with Programmable Messaging access;
- an SMS-capable Twilio sender, preferably attached to a Messaging Service;
- the Account SID and Auth Token for the server;
- an approved US messaging compliance path for that sender (for example,
  registered A2P 10DLC or a verified toll-free number); and
- access to add secret environment variables to the Render web service.

Twilio's Messages API requires a recipient, sender, and content. A US
application sending from a 10-digit long-code number must register its A2P
traffic. See the official [Messages API](https://www.twilio.com/docs/messaging/api/message-resource)
and [A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc).

## Render environment variables

Add these under **Render service → Environment**:

```text
EVENT_APP_SMS_MODE=twilio
EVENT_APP_OTP_PEPPER=a-long-random-server-only-secret
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

If you are not using a Messaging Service, omit
`TWILIO_MESSAGING_SERVICE_SID` and use an SMS-capable E.164 sender instead:

```text
TWILIO_FROM_NUMBER=+16155550101
```

Render supplies `RENDER_EXTERNAL_URL`, which the app uses for the `/attend`
link. Set this only if the public attendee URL should use a custom domain:

```text
EVENT_APP_PUBLIC_URL=https://your-event-domain.example
```

You may instead provide the complete link with `EVENT_APP_ATTENDEE_URL`, but
it should normally stay on the same event-app origin. Save and redeploy after
adding the variables. Never put Twilio credentials or `EVENT_APP_OTP_PEPPER`
in `web/`, Git, a QR code, or a Google Sheet.

## Local rehearsal without Twilio

Local development defaults to console delivery:

```bash
cd demo-server
EVENT_APP_SMS_MODE=console node server.js
```

The page still follows the real code-verification flow, but the welcome text
is printed in the server terminal with the phone number masked. Console/test
delivery is refused on Render and when `NODE_ENV=production`.

## Verification and privacy behavior

- Codes expire after 10 minutes and allow five attempts.
- Resends wait at least 60 seconds and have per-phone and global rate limits.
- Only an HMAC digest is stored; plaintext codes are not written to `db.json`.
- Pending challenges do not appear as registered attendees or consume a row
  in the Google Sheet mirror.
- OTP challenge data, provider message IDs, and code digests are never
  exported to Google Sheets. A verified attendee's phone number is exported
  through `Live_Attendees` and related operational rows.
- The disclosure on Phase 1 covers the transactional welcome text only. Do
  not reuse attendee numbers for marketing without a separately reviewed
  consent and messaging workflow.

After deployment, register a test attendee, confirm the text arrives, verify
the code, assign a wristband, open the text's `/attend` link in another browser,
and confirm name plus phone restores the same raffle and timed route.
