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

Start with Phase 1. Enter a name and mobile number to create the attendee and
raffle number immediately. No message or phone code is sent. Assign a
wristband color and complete the handoff; the same attendee identity continues
directly into the single Phase 2 hub. The old
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

## Phone registration and recovery login

Phase 1 collects the attendee's name and mobile number and immediately creates
the attendee record and raffle number. The app sends no message. The same
device keeps that identity in local storage; `/attend` and the attendee return
QR open the entry/resume screen on another device, where the same name and
phone recover the pass. The shared server clock then decides which waiting,
booth, or final state to show. Raffle numbers are display-only and are never
accepted as login credentials. Booth pages never ask for the phone again.

No phone-delivery environment variables are required on Render. The only
optional integration credentials in the current flow are the two Google Sheet
export variables documented below.

## `db.json`

The server creates `db.json` on first write. It contains:

- attendees, including the collected phone, raffle number, assigned wristband
  color, and persisted Phase 3 completion time;
- booth check-ins, including scheduled visits created by attendee completion
  taps;
- run-scoped New Song votes, Session 1–3 controllers, and archived runs;
- Phase 3 option selections, which may be empty for **No thanks, finish**;
- one current presentation state per booth;
- versioned Session 1–3 controllers, attendee responses, and archived prior
  runs for Bible Bowl, Draw Heaven, and New Song;
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
check-ins and scores, New Song sessions, votes, and run history, Phase 3
sign-ups, all booth presentation and control
state, and the raffle counter. It
replaces `db.json.bak` with the same empty state and advances the durable reset
marker. On their next sync, connected or reopened attendee browsers clear
their old identity and return to Phase 1. The reset deliberately leaves the
current simulated/live clock mode unchanged.

## Optional Google Sheets mirror

The Node database can be mirrored to a bound Google Sheet while `/api` remains
the frontend backend. This preserves every synchronized booth and clock
feature. The export is best-effort and nonblocking: after a durable JSON write,
the server queues the newest complete snapshot, coalesces bursts, and retries a
failed delivery without changing the attendee or staff API response.

Configure these server-only environment variables locally or in Render:

```text
EVENT_APP_SHEETS_EXPORT_URL=https://script.google.com/macros/s/YOUR_ID/exec
EVENT_APP_SHEETS_EXPORT_KEY=use-a-long-random-secret
```

Optional tuning values are `EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS` and
`EVENT_APP_SHEETS_EXPORT_TIMEOUT_MS`. The export key must match the
`EXPORT_KEY` Script Property in the bound Apps Script. Neither value belongs in
`web/shared/config.js`, a public URL, or client-side storage. Keep
`API_BASE_URL: "/api"`; the Apps Script URL is only the server-to-server export
destination.

Each successful snapshot fully replaces `Live_Attendees`,
`Live_BoothResults`, `Live_SignUps`, `Live_TriviaAnswers`,
`Live_HeavenConfirmations`, `Live_SongVotes`, and `Live_ExportMeta`. Full
replacement reconciles identity merges, updated check-ins, removed Phase 3
choices, and protected resets without duplicate rows. An attendee who chooses
**No thanks** still appears in `Live_Attendees` with `phase3CompletedAt`, even
though no sign-up row exists.

Every registered attendee reaches this mirror, including the phone collected
in Phase 1. The Sheet therefore contains attendee contact information and must
use appropriately restricted access and retention rules.

`Live_BoothResults.extraData` mirrors only allowlisted operational metadata;
attendee-entered Story answers and Art reflections remain out of the Sheet.
`Live_ExportMeta.generatedAt` is written last as the commit marker. If a
transient failure interrupts the tab sequence, the marker stays on the prior
generation and the protected dashboard reports the error until a full retry
succeeds.

Overall Organizer shows whether the export is connected, queued, syncing, up
to date, or failing, plus the latest row counts. **Sync now** is protected by
the organizer key and queues the current snapshot. The status never exposes
the Apps Script URL or export key. `resetDemo` remains the deletion boundary;
after it succeeds, the next export clears the live Sheet mirror too. The Sheet
is therefore an operational view, not a separate backup or immutable archive.
See `../apps-script/README.md` for Sheet and Web App setup.

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

- `registerAttendee` (one-step name and phone registration)
- `confirmWristband`
- `loginAttendee` (name plus phone; raffle is never accepted as login)
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
- `googleSheetsExportStatus` (Node service only; sanitized status)
- `syncGoogleSheetsExport` (Node service only; queues the current snapshot)
- `resetDemo` (Node service only)
- `setDemoClock` (Node service only)

Bible Bowl adds a Node-service-only, leader-paced API:

- `triviaState` returns the current attendee-safe question state
- `submitTriviaAnswer` locks one answer and scores it on the server
- `completeTrivia` records the server-verified final result
- `triviaDashboardData` returns protected Session 1–3 leaderboards
- `advanceTriviaSession` starts, reveals, advances, or finishes one session
- `resetTriviaSession` archives the selected run and opens a fresh run without
  mixing its answers or leaderboard with the previous run

Draw Heaven uses the same Node-only, leader-paced run model:

- `heavenState` returns the current global phase plus the attendee's saved
  confirmations
- `confirmHeavenStep` idempotently saves the attendee response that is open in
  the current leader phase
- `heavenDashboardData` returns protected progress for all three rotations and
  their archived runs
- `advanceHeavenSession` moves one rotation through welcome, drawing, verse,
  comparison, reflection, programs, and completion using optimistic versions
- `resetHeavenSession` archives the current run and opens a clean welcome run

Art Therapy uses a Node/Render-only leader-paced controller at its existing
attendee and staff URLs:

- `artState` returns only the attendee's assigned session and currently
  published slide/reveal
- `completeArt` records an immutable completion for the current run and the
  ordinary route-level booth check-in, but accepts no artwork or reflection
  text
- `artDashboardData` returns protected progress for the Orange, Green, and Red
  rotations plus their archived runs
- `advanceArtSession` publishes the definition, importance, supplied image,
  heart question, two verses, creative activity, closing reflection, and Done
  release using optimistic versions
- `resetArtSession` archives the selected run and starts a clean welcome run

New Song also uses a Node/Render-only leader-paced run model without changing
its attendee (`/phase2-booths/booth-newsong.html`) or staff
(`/phase2-staff/newsong.html`) URLs. Green, Yellow, and Orange wristbands use
Sessions 1, 2, and 3 respectively. `newSongState`, `submitNewSongVote`, and
`completeNewSong` serve attendees; protected `newSongDashboardData`,
`advanceNewSongSession`, and `resetNewSongSession` serve staff. The leader
advances `welcome → voting → winner → verse → complete`, choosing when to show
the winner, Revelation 14:3, and the end. Tallies are live and isolated by
session/run, the first attendee vote is locked, and session reset preserves an
archived run before opening the next.

The exact eleven-song poll is **He Called Me — Eugy Official**, **He Turned
It**, **Victory**, **Brighter Day**, **Praise — Elevation Worship**, **247 —
Tbabz**, **Elohim — Sondae**, **I Thank God — Maverick City**, **Amen — Madison
Ryann Ward**, **Quick — Caleb Gordon**, and **Goodbye Yesterday — Elevation
Rhythm**.

Session reset preserves prior-run answers, confirmations, Art completions,
votes, and results
for staff review while keeping each active run isolated. The overall
`resetDemo` action is the deliberate deletion boundary: it clears active and
archived runs, including New Song sessions, votes, and history, along with all
other event data.

The question answer key stays outside `web/`, and the public attendee state
does not include the correct answer until the booth leader reveals it. Each
session and leaderboard is persisted separately in `triviaSessions`,
`triviaAnswers`, and `triviaRunHistory`. Draw Heaven, Art Therapy, and New Song
use matching session/run-history collections, with Art completions and New
Song votes carrying their run ID.
Run one Node instance with a persistent `EVENT_APP_DB_PATH`; the Apps Script
adapter does not implement these synchronized booth workflows. Its New Song
support remains the legacy unsynchronized vote path.

The optional Apps Script export sink is different from using Apps Script as
the app backend: it mirrors the complete Node data model into `Live_*` tabs and
does not change `API_BASE_URL`. This is the recommended Sheet arrangement for
the current full experience.

The Node service also exposes the public, PII-free `eventClock` read so pages
can follow the shared rehearsal time and durable reset marker. `resetDemo`,
`eventClock`, and `setDemoClock` deliberately have no Apps Script counterpart.

Legacy registration and phone/kiosk actions remain for optional staff fallback
pages. Pointing the frontend directly at Apps Script does not provide the full
current Node journey, shared clock/reset, or synchronized booth controllers.
Keep `API_BASE_URL: "/api"` for the current attendee journey.

The Apps Script adapter is a deployment-shaped mock backend, not a production
approval. Confirm the event date, venue connectivity, staff authentication,
data privacy/retention, and operational fallback before using real attendee
data.
