# Demo server

This zero-dependency Node server runs the event app mock locally. It serves the
static files under `../web/`, implements the same API shape as the Apps Script
backend, and stores throwaway rehearsal data in `db.json`.

It is for development and event-flow rehearsal, not a hardened production
service.

## Run

Use Node.js 16 or newer:

```bash
cd demo-server
node server.js
```

No `npm install`, database, or Google account is required. The startup output
lists the primary experience:

```text
Event app demo server running: http://localhost:3000
  Phase 1 entry:        http://localhost:3000/phase1-entry/index.html
  Attendee booth route: http://localhost:3000/phase2-booths/hub.html
  Phase 3 attendee:     http://localhost:3000/phase3-signup/index.html
  Phase 2 staff hub:    http://localhost:3000/phase2-staff/index.html
  Organizer dashboard:  http://localhost:3000/organizer/dashboard.html
  QR codes (optional):  http://localhost:3000/organizer/qr-codes.html
  Timer previews:       add ?preview=before, 1, 2, 3, or ended to the attendee/staff URL
  Local organizer key:  demo
```

Start with Phase 1. Assign a wristband color, complete the handoff, and follow
the button into the single Phase 2 hub. The old direct booth-room and kiosk
URLs are still served, but they are optional fallbacks rather than the primary
attendee route.

Stop the process with `Ctrl+C`.

If port 3000 is already in use:

```bash
PORT=3001 node server.js
```

Use `localhost:3001` in the URLs after changing the port.

## Organizer key

The local default is `demo`. To use another rehearsal value:

```bash
EVENT_APP_ORGANIZER_KEY="a-long-test-key" node server.js
```

The organizer dashboard, booth-leader updates, kiosk actions, sign-up
confirmation, and reset endpoints require this key. All five booth-leader
pages share it. API responses are scoped to the requested booth, but the key
itself is not a booth-level role: its holder can access any staff page. Do not
reuse the local default or this shared-key model for production.

## Local schedule preview

The schedule currently assumes July 18, 2026 in Nashville. Append one of these
values to the unified attendee hub or an individual booth-leader URL to
rehearse a fixed state:

```text
?preview=before
?preview=1
?preview=2
?preview=3
?preview=ended
```

Examples:

```text
http://localhost:3000/phase2-booths/hub.html?preview=2
http://localhost:3000/phase2-staff/trivia.html?preview=2
```

Preview is accepted only on a loopback hostname and intentionally freezes the
selected moment. Without it, the app uses the real synchronized clock.

## `db.json`

The server creates `db.json` on first write. It contains:

- attendees, including raffle number and assigned wristband color;
- booth check-ins;
- Phase 3 option selections;
- one current presentation state per booth; and
- the raffle counter.

The file is ignored by Git and safe to delete between rehearsals. Older demo
files are normalized when read so missing wristband colors or booth
presentation state do not crash the server.

To reset through the protected API:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

The organizer dashboard exposes the same reset action.

## Tests

Run from this directory:

```bash
npm test
```

The suite starts an isolated temporary server and checks the main API/static
contracts: organizer authorization, attendee registration and lookup,
wristband-color validation and persistence, Phase 2 eligibility, booth
check-ins and deduplication, public booth presentation reads, protected
leader updates, booth-scoped staff results, Phase 3 sign-ups and confirmation,
reset behavior, error payloads, and inline page-script syntax. It does not
replace a real-device, network, accessibility, or multi-staff rehearsal.

## API parity

The current primary attendee actions are:

- `registerAttendee`
- `confirmWristband`
- `loginAttendee`
- `attendeePortalSession`
- `myCheckins`
- `boothPresentation`
- `boothCheckin`
- `saveSignupSelections` (primary Phase 3 batch action)
- `mySignupSelections`
- `submitSignup` (legacy single-option compatibility)

The main protected staff actions are:

- `verifyOrganizer`
- `updateBoothPresentation`
- `boothDashboardData`
- `dashboardData`
- `confirmSignupInPerson`
- `resetDemo`

Legacy phone/kiosk actions also remain for the optional fallback pages. These
actions have matching implementations in `../apps-script/Code.gs`.
`../web/shared/api.js` calls either backend the same way; moving to Apps Script
requires changing `API_BASE_URL` in `../web/shared/config.js`.

The Apps Script adapter is a deployment-shaped mock backend, not a production
approval. Confirm the event date, venue connectivity, staff authentication,
data privacy/retention, and operational fallback before using real attendee
data.
