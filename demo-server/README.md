# Demo server

This zero-dependency Node service runs the event app mock locally or behind a
same-origin Render URL. It serves the static files under `../web/`, implements
the shared attendee/staff API plus protected rehearsal clock and reset
features, and stores event data in `db.json`.

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
  Organizer portal:     http://localhost:3000/organizer/index.html
  QR codes (optional):  http://localhost:3000/organizer/qr-codes.html
  Timer previews:       add ?preview=before, 1, 2, 3, or ended to the attendee/staff URL
  Local organizer key:  demo
```

Start with Phase 1. Assign a wristband color and complete the handoff; the same
attendee identity continues directly into the single Phase 2 hub. The old
direct booth-room and kiosk URLs are still served, but they are optional
fallbacks rather than the primary attendee route.

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

The organizer portal is the single staff starting link; choose the overall
dashboard or one of the five booth-leader pages from it. The organizer
dashboard, booth-leader updates, kiosk actions, sign-up
confirmation, and reset endpoints require this key. All five booth-leader
pages share it. API responses are scoped to the requested booth, but the key
itself is not a booth-level role: its holder can access any staff page. Do not
reuse the local default or this shared-key model for production.

## Shared rehearsal clock

Open the organizer portal, choose **Overall Organizer**, unlock the dashboard
with the organizer key, and use its **Demo only · Shared event time** panel.
The continuous timeline accepts any exact second from **3:10:00 through
4:10:00 PM America/Chicago**. Drag the slider, enter an exact time, or use the
3:10, 3:30, 3:50, and 4:10 boundary shortcuts, then choose **Apply simulated
time**. **Show waiting lobby** provides the pre-session state, and **Use live
CDT clock** restores actual Chicago time.

The selected mode and anchor are held in memory by this Node process. Simulated
time ticks normally from that anchor, preserving the three 20-minute booth
windows. Attendee, overall-organizer, and booth-leader pages sample it about
every five seconds with per-browser jitter, while their visible countdown
advances locally every second. Hidden tabs stop polling and resynchronize when
visible. The public clock read contains time state and a non-PII reset marker;
changing the clock still requires the organizer key. Restarting the service
returns the rehearsal clock to its default state; resetting attendee data
leaves the selected clock in place so a rehearsal can continue at the same
moment.

These controls work on the same-origin Node service locally or on Render. They
are not implemented by the Apps Script adapter and must not be treated as
resilient live-event show control.

### Per-page preview fallback

The schedule currently assumes July 18, 2026 in Nashville. Append one of these
values to Phase 1, the unified attendee hub, or an individual booth-leader URL
to rehearse a fixed state:

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

Preview is accepted only on a loopback hostname and intentionally freezes one
browser journey. Prefer the organizer clock for multi-window rehearsals. Once
an organizer-controlled shared mode is active, it takes precedence over query
preview; otherwise the app uses query preview or the real synchronized clock.

## `db.json`

The server creates `db.json` on first write. It contains:

- attendees, including raffle number, assigned wristband color, and persisted
  Phase 3 completion time;
- booth check-ins, including scheduled visits created by attendee completion
  taps;
- New Song votes saved as soon as an attendee taps a song;
- Phase 3 option selections, which may be empty for **No thanks, finish**;
- one current presentation state per booth;
- the raffle counter; and
- a durable `dataResetAt` marker used to invalidate attendee browser identity
  after an organizer starts fresh.

The file is ignored by Git. Use the protected reset action between rehearsals;
if you stop the server and reset manually, delete both `db.json` and
`db.json.bak` together. Writes are
flushed to a temporary file and atomically renamed; the previous good version
is retained beside it as `db.json.bak`. A malformed primary file is recovered
from that backup instead of being interpreted as an empty event. If neither
copy is readable, API requests return `503` and refuse to report a false empty
database. Older files are normalized when read so missing fields do not crash
the server.

For a hosted event, mount persistent storage and set an absolute path, for
example `EVENT_APP_DB_PATH=/var/data/event-app-db.json`. Keep exactly one Node
instance because both the in-memory rehearsal clock and JSON write ownership
are process-local. Use `GET /api/health` as the host health-check path.

To reset through the protected API:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

The organizer dashboard exposes the same protected action as **Clear all
attendee data & start fresh**. It deletes attendees and wristbands, booth
check-ins and scores, New Song votes, Phase 3 sign-ups, all booth presentation
and control state, and the raffle counter. It replaces `db.json.bak` with the
same empty state and advances the durable reset marker. On their next sync,
connected or reopened attendee browsers clear their old identity and return to
Phase 1. The reset deliberately leaves the current simulated/live clock mode
unchanged.

## Tests

Run from this directory:

```bash
npm test
```

The suite starts an isolated temporary server and checks the main API/static
contracts: organizer authorization, attendee registration and lookup,
wristband-color validation and persistence, Phase 2 eligibility, tap-backed
booth check-ins and deduplication, public booth presentation reads, protected
leader updates, booth-scoped staff results, Phase 3 selections and persisted
completion (including **No thanks**), preview propagation, reset behavior,
error payloads, reset/backup recovery, the two-minute completion retry,
inline page-script syntax, and a concurrent 150-attendee representative load
check with balanced wristbands, 90 live song votes, and 450 booth completions.
Around 150 is a planning estimate, not an application cap. The protected
overall dashboard also verifies each color's current scheduled booth and
expandable attendee progress roster. It does not replace a
real-device, venue-network, accessibility, or multi-staff rehearsal.

## API surface and backend differences

The current primary attendee actions are:

- `registerAttendee`
- `confirmWristband`
- `loginAttendee`
- `attendeePortalSession`
- `myCheckins`
- `boothPresentation`
- `boothCheckin`
- `saveSongVote` (persists a New Song choice immediately for the live tally)
- `saveSignupSelections` (reconciles selections and persists Phase 3 completion)
- `mySignupSelections` (returns selections plus the saved completion time)
- `submitSignup` (legacy single-option compatibility)

The main protected staff actions are:

- `verifyOrganizer`
- `updateBoothPresentation`
- `boothDashboardData`
- `dashboardData`
- `confirmSignupInPerson`
- `resetDemo` (Node service only)
- `setDemoClock` (Node service only)

Bible Bowl adds a Node-service-only, leader-paced API:

- `triviaState` returns the current attendee-safe question state
- `submitTriviaAnswer` locks one answer and scores it on the server
- `completeTrivia` records the server-verified final result
- `triviaDashboardData` returns protected Session 1–3 leaderboards
- `advanceTriviaSession` starts, reveals, advances, or finishes one session
- `resetTriviaSession` clears only the selected session for rehearsal

The question answer key stays outside `web/`, and the public attendee state
does not include the correct answer until the booth leader reveals it. Each
session and leaderboard is persisted separately in `triviaSessions` and
`triviaAnswers`. Run one Node instance with a persistent `EVENT_APP_DB_PATH`;
the Apps Script adapter does not implement this synchronized trivia workflow.

The Node service also exposes the public, PII-free `eventClock` read so pages
can follow the shared rehearsal time and durable reset marker. `resetDemo`,
`eventClock`, and `setDemoClock` deliberately have no Apps Script counterpart.

Legacy phone/kiosk actions also remain for the optional fallback pages. The
core attendee and staff journey actions have matching implementations in
`../apps-script/Code.gs`; the three Node-only actions called out above do not.
`../web/shared/api.js` calls either backend the same way; moving to Apps Script
requires changing `API_BASE_URL` in `../web/shared/config.js`.

The Apps Script adapter is a deployment-shaped mock backend, not a production
approval. Confirm the event date, venue connectivity, staff authentication,
data privacy/retention, and operational fallback before using real attendee
data.
