# The Perfect Summer Day — event app mock

This repository is a runnable mock and implementation framework for a timed,
multi-device event experience. It is useful for design reviews, rehearsals,
and validating the flow with the event team. It is **not production-ready**:
the event date and operating rules still need confirmation, access is not
strong authentication, and the deployment needs a security and venue-network
review.

The attendee journey is now one continuous flow:

1. **Phase 1 — entry:** enter a name and mobile number, verify the six-digit
   welcome text, receive the raffle number carried in that same message, and
   have a Guardian Angel confirm the physical wristband color. Confirmation
   continues directly into Phase 2 with the same attendee identity.
2. **Phase 2 — timed booth route:** keep one attendee hub open. It shows the
   attendee's name and raffle number, a shared timer, the current booth, and
   the booth leader's live instructions. Its active button opens the correct
   timed booth activity without another sign-in. Each wristband visits three
   of the five booths. A visit counts as complete only after the attendee taps
   to mark it; the current route row can be reopened until that session ends.
   The generic comment and star-rating footer has been removed from the active
   attendee booth rooms.
3. **Phase 3 — tick and go:** select any next-step options and finish. There
   are no ratings, comments, or extra attendee questions. Phase 3 becomes
   available after all three completion taps are saved, or at 4:10 PM even if
   some visits remain unmarked. Save and **No thanks, finish** both persist
   Phase 3 completion. Anyone who finishes early sees the original-style
   **DON'T GO YET** countdown until the 4:10 PM main message.

The Art Therapy and New Song kiosk pages remain optional staff-assistance
fallbacks; the attendee booth-room pages are linked from the timed hub.

## Wristband routes

The color selected in Phase 1 determines all three stops:

| Wristband | Session 1 | Session 2 | Session 3 |
|---|---|---|---|
| Blue | Can You Draw Heaven? | Bible Bowl | The Sower, Live |
| Red | Bible Bowl | Can You Draw Heaven? | Art Therapy Table |
| Orange | Art Therapy Table | The Sower, Live | The New Song in Nashville |
| Green | The New Song in Nashville | Art Therapy Table | Can You Draw Heaven? |
| Yellow | The Sower, Live | The New Song in Nashville | Bible Bowl |

The current mock schedule is:

| Session | Time |
|---|---|
| 1 | 3:10–3:30 PM |
| 2 | 3:30–3:50 PM |
| 3 | 3:50–4:10 PM |

These timestamps currently assume **July 18, 2026 in Nashville** and use the
event-day offset `-05:00` (CDT). That date is an editable mock assumption, not
a production configuration service. Confirm it with the event team and edit
`BOOTH_SESSIONS` in `web/shared/booths-config.js` before deployment.

## Quick start

The local demo needs Node.js 16 or newer. It has no npm dependencies and does
not need a Google account or database.

```bash
git clone https://github.com/autowiki4/event-app.git
cd event-app/demo-server
node server.js
```

The server prints the main local links:

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

Start at Phase 1. In local console mode, read the welcome code printed in the
server terminal; live delivery is configured separately. Confirming the
wristband continues directly into the hub, and Phase 3 reuses that same saved
attendee identity. On another device, the attendee enters their registration
name and mobile number to recover the same route. The raffle number stays
visible but is never used as a login credential. Refreshing or reopening the
same phone restores the attendee,
the schedule's current timed stop, and unfinished booth/Phase 3 choices. The
attendee stays signed in until they tap their name at the top-right and choose
**Log out on this device**.

Press `Ctrl+C` in the terminal to stop the server.

### Rehearse with the shared Node clock

Open the organizer portal, choose **Overall Organizer**, unlock it with the
local key (`demo` by default), and use the **Demo only · Shared event time**
panel. Its one-hour timeline can start the shared simulated clock at any exact
second from **3:10:00 through 4:10:00 PM America/Chicago**. Drag the timeline,
enter a precise time, or use the 3:10, 3:30, 3:50, and 4:10 boundary shortcuts,
then choose **Apply simulated time**. The chosen point is an anchor rather than
a frozen preview: it continues ticking normally, so every 20-minute booth
transition and countdown still happens. **Show waiting lobby** provides the
pre-session rehearsal state, while **Use live CDT clock** restores actual
Chicago time for the event day.

The change applies to all attendee, overall-organizer, booth-leader, Phase 3,
and final-message screens using the same Node service, whether that service is
running locally or on Render.

Screens sample the same public, PII-free demo clock about every five seconds,
with randomized staggering, while their visible countdown continues locally
every second. Hidden tabs pause network polling and resynchronize when opened.
The selected anchor is an in-memory rehearsal override owned by the running
Node process; it is not resilient production show control.

The panel appears when `API_BASE_URL` uses the same-origin Node `/api` backend,
including a Render deployment of this server. It is not available in the Apps
Script adapter. Choosing **Use live CDT clock** removes the override rather
than changing the real clock; Apps Script pages always use synchronized real
time.

Before Session 1, every registered attendee sees a waiting lobby and their
first booth, but no booth can be opened. The lobby changes automatically at
3:10 PM; during a Node-backed rehearsal, the overall organizer can use
**Show waiting lobby**, then the **3:10** boundary shortcut and **Apply
simulated time**, to demonstrate that transition on every connected screen.

### Planning for around 150 attendees

About 150 is a planning estimate, not a registration limit. If turnout lands
near that number, the five wristband routes are roughly balanced at 30 people
per color. The organizer dashboard recommends the least-used next color and
shows the live spread without blocking or labelling guests above 150 as over
capacity. Each color expands to its attendee roster, current scheduled booth,
raffle numbers, and booth-progress status.

For the event, use exactly one always-on Node process with `EVENT_APP_DB_PATH`
on a persistent disk. Database writes use a flushed temporary file, atomic
rename, and last-known-good `.bak`; `/api/health` confirms that the store can be
loaded. A staged booth-completion tap also retries for two minutes if venue
Wi-Fi drops at a session boundary. The regression suite uses a concurrent
150-attendee journey as a representative load check, with 90 live New Song
votes and 450 booth completions; that test number is not an application cap.

### Welcome text and phone verification

The welcome code, raffle number, and stable `/attend` return link are delivered
through Twilio Programmable Messaging in a live deployment. The link opens the
entry/resume screen: it restores an unfinished wristband step or continues a
fully checked-in attendee to the shared hub, which derives the current
waiting/session/ended state from the same server clock. Phase 2 does not
collect the phone again.

Render needs `EVENT_APP_SMS_MODE=twilio`, a random
`EVENT_APP_OTP_PEPPER`, Twilio credentials, and either a Messaging Service SID
or SMS-capable sender number. See `demo-server/SMS_SETUP.md` for the exact
variables, local console behavior, compliance prerequisites, and test steps.

### Optional live Google Sheets export

The same-origin Node/Render service can mirror its current event data into a
Google Sheet without giving up the shared clock or the leader-paced Bible
Bowl, Draw Heaven, and New Song features. The Node JSON database remains the
source of truth. A bound Apps Script receives a debounced, complete snapshot
and replaces seven `Live_*` tabs for attendees, booth results, Phase 3
sign-ups, Bible Bowl answers, Draw Heaven confirmations, New Song votes, and
export metadata.

The Sheet mirror excludes attendee-entered Story answers, Art reflections,
OTP challenges, code digests, and SMS provider IDs;
`Live_BoothResults.extraData` contains only allowlisted operational metadata.
`Live_ExportMeta.generatedAt` is written last as the complete-snapshot marker.

This export is optional: without its two environment variables, the app keeps
working normally and the protected organizer dashboard reports that no Sheet
is connected. Once configured, writes queue automatically and staff can use
**Sync now** from Overall Organizer. Export failures never turn a successful
attendee save into an error; the exporter retains the newest pending snapshot
and retries. Because each export is a full mirror, **Clear all attendee data**
also clears the `Live_*` rows on the next successful sync. Treat the Sheet as
an operational export, not as a backup or archive.

Setup requires the Apps Script Web App URL and a separate random export key in
Render:

```text
EVENT_APP_SHEETS_EXPORT_URL=https://script.google.com/macros/s/YOUR_ID/exec
EVENT_APP_SHEETS_EXPORT_KEY=use-a-long-random-secret
```

Do not change `web/shared/config.js` away from `/api` for this arrangement.
The step-by-step Sheet deployment and Script Property setup are in
`apps-script/README.md`. Decide who may access the exported names, phone
numbers, raffle numbers, operational activity results, and selections, along
with retention and deletion, before enabling it with live attendees.

### Per-page preview fallback

For isolated page checks on localhost, you can still append one of these query
values to Phase 1, the attendee hub, or a booth-leader page:

```text
?preview=before
?preview=1
?preview=2
?preview=3
?preview=ended
```

For example:

```text
http://localhost:3000/phase2-booths/hub.html?preview=1
http://localhost:3000/phase2-staff/heaven.html?preview=1
```

Query preview holds only that browser journey at a deterministic point and is
intentionally frozen. Use the organizer control for multi-window rehearsals;
once the organizer selects a shared time, that server-controlled state wins
over a query preview. The query override is ignored on non-local hosts.

## Booth-leader portals

`web/organizer/index.html` is the single staff starting link. It offers the
overall organizer dashboard plus one portal for each of the five booths. The
older `web/phase2-staff/index.html` URL redirects there so saved links and
previously printed codes still work. After choosing and unlocking a booth
page, its leader can publish:

- a status: waiting, live, paused, wrap up, or complete;
- the current booth-specific activity step; and
- an optional short announcement.

The attendee hub polls for that booth's published state and refreshes the
current screen automatically. Leaders also see the wristband group scheduled
for their booth, the shared timer, and that booth's recent check-ins.

### Specialized Art Therapy controls

Art Therapy keeps the existing attendee URL
(`/phase2-booths/booth-art.html`) and staff URL
(`/phase2-staff/art.html`). On Node/Render, Orange wristbands attend Session 1,
Green attend Session 2, and Red attend Session 3. Each rotation follows the
leader-paced sequence **welcome → definition → importance → purpose image →
heart question → Proverbs 4:23 → Philippians 4:7 → create → finished →
complete**. The heart question and two passages are progressive reveals within
one conceptual slide, so attendees never skip ahead independently.

The supplied heart-and-mind image has its own leader release and can be
enlarged on an attendee phone. The activity collects no artwork, reflection
text, rating, or comment. Only the final Done tap is persisted. Restarting a
session archives its current run and immutable per-run completions before
opening a clean welcome screen. This synchronized controller is Node/Render-
only; the optional Art kiosk remains a separate fallback.

### Specialized New Song controls

New Song keeps the same attendee URL (`/phase2-booths/booth-newsong.html`) and
staff URL (`/phase2-staff/newsong.html`). On the Node/Render backend, each
rotation follows the leader-paced sequence **welcome → voting → winner → verse
→ complete**: Green wristbands attend Session 1, Yellow attend Session 2, and
Orange attend Session 3. The leader opens the poll, reveals its winner, shows
Revelation 14:3, and releases the final completion action.

The poll contains exactly these eleven choices:

1. He Called Me — Eugy Official
2. He Turned It
3. Victory
4. Brighter Day
5. Praise — Elevation Worship
6. 247 — Tbabz
7. Elohim — Sondae
8. I Thank God — Maverick City
9. Amen — Madison Ryann Ward
10. Quick — Caleb Gordon
11. Goodbye Yesterday — Elevation Rhythm

Tallies update live within the current session and run. An attendee's first
vote is locked; restarting a session opens a clean run while retaining the
prior run in protected staff history. The synchronized New Song experience is
Node/Render-only. Apps Script retains its legacy vote path and does not support
these leader-paced phases or run archives.

All five staff portals currently share one organizer key. The backend scopes
the data and controls by booth, but the shared key is **not per-booth access
control**: anyone with it can unlock another staff or organizer page. Use the
local value `demo` only for rehearsal. A production version needs strong,
rotatable credentials and preferably separate roles or booth-level grants.

## What is in the repo

```text
event-app/
├── web/
│   ├── phase1-entry/       registration + raffle + wristband assignment
│   ├── phase2-booths/      unified hub + optional legacy booth/kiosk pages
│   ├── phase2-staff/       compatibility redirect and five scoped portals
│   ├── phase3-signup/      checkbox-only next steps + saved completion
│   ├── done/               early-finish countdown + 4:10 message state
│   ├── organizer/          unified staff directory, dashboard, and QR utility
│   └── shared/             identity, schedule, API, content, and shared UI
├── demo-server/            Node rehearsal backend using a JSON data file
├── apps-script/            Google Sheets export sink + limited legacy adapter
├── ARCHITECTURE.md         identity, timing, controls, and data design
├── DEMO_GUIDE.md           a short presentation/rehearsal script
└── qr/QR_PLAN.md           recommended placement and print checklist
```

The Node version is the recommended backend for the complete current flow. It
writes to `demo-server/db.json`, provides the protected reset and shared clock,
and can optionally mirror that complete state to Google Sheets through Apps
Script. `Code.gs` still contains a limited legacy implementation of the core
attendee/staff API, but pointing `API_BASE_URL` directly at it omits the
leader-paced controllers, `resetDemo`, `setDemoClock`, and the public
`eventClock` read. The export-sink arrangement keeps `API_BASE_URL: "/api"`.

The Apps Script implementation is deployment-shaped, not proof that the whole
system is ready for a live event. Test it on the venue network, replace the
shared organizer-key model, confirm privacy/retention requirements, and define
an offline fallback before collecting real attendee data.

## Test and reset

From `demo-server/`:

```bash
npm test
```

The zero-dependency regression suite exercises the API and static-page
contracts, including attendee identity lookup, wristband-color persistence,
Phase 2 eligibility, tap-backed booth completion, booth presentation reads and
protected updates, booth-scoped staff data, duplicate check-in protection,
persisted Phase 3 completion and sign-ups, organizer authorization, reset
behavior, and inline JavaScript syntax.

To start a fresh Node-backed rehearsal, unlock **Overall Organizer** and use
**Clear all attendee data**, or run:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

The protected reset deletes attendees and wristband assignments, booth
check-ins and scores, New Song sessions, votes, and run history, Phase 3
sign-ups, every booth's current presentation/control state, and the raffle
counter. It replaces the backup
with the same empty state. A durable reset marker also tells connected or
reopened attendee browsers to clear their saved identity and return to Phase 1
to register again. The selected simulated/live clock is deliberately left in
place, so reset data separately from choosing the rehearsal time. This reset
is available on the same-origin Node service locally or on Render; the Apps
Script adapter does not implement it.

## Known mock limitations

- Name plus phone is lightweight record recovery after the first OTP, not
  strong ongoing authentication. The raffle number is display-only.
- The synchronized experience still needs working network access. Booth
  completion taps have a narrow two-minute retry queue, but registration,
  leader controls, live voting, and Phase 3 remain online-only.
- Phase 3 eligibility is enforced by the browser from saved check-ins and the
  shared clock, not as an authentication or authorization boundary at the API.
- Booth leaders share one organizer key. Generic booth controls retain only
  one current state; Bible Bowl, Draw Heaven, Art Therapy, and New Song additionally
  preserve session-isolated prior runs, but this is still not a full audited
  show-control system.
- The shared clock controls are Node-service rehearsal helpers, available when
  the site and `/api` share the local or Render origin. The Apps Script path
  has no remote time override or matching full-data reset.
- The leader-paced Bible Bowl, immediate answer saving, answer reveals, and
  session-separated leaderboards also require that same Node/Render backend;
  they are not implemented by the Apps Script sketch.
- Draw Heaven's leader-paced phases, attendee confirmations, catch-up flow,
  and archived run summaries likewise require the Node/Render backend.
- Art Therapy's staff-paced slides, progressive verse reveals, completion
  records, and archived runs also require Node/Render; its attendee activity
  intentionally stores no artwork or reflection text.
- New Song's session-separated live poll, winner and Revelation 14:3 reveals,
  locked first votes, and archived runs also require Node/Render; Apps Script
  supports only the legacy unsynchronized vote path.
- The optional Google Sheet is a best-effort live mirror. It does not replace
  the persistent Node data file or provide an audit-grade backup. A deployment
  must monitor its protected status and establish data-access and retention
  rules before collecting real attendee information.
- QR codes must be regenerated and device-tested after the app has a stable
  public URL; never print localhost or preview-query links.

## Related docs

| Document | Purpose |
|---|---|
| `ARCHITECTURE.md` | How identity, schedule synchronization, routing, and booth controls connect |
| `DEMO_GUIDE.md` | How to present the unified flow using the shared timeline |
| `demo-server/README.md` | Node backend, data file, reset, and API differences |
| `demo-server/SMS_SETUP.md` | Twilio welcome-text credentials, privacy, and verification setup |
| `apps-script/README.md` | Google Apps Script deployment sketch |
| `apps-script/SHEET_SCHEMA.md` | Sheet tabs and columns |
| `qr/QR_PLAN.md` | Unified-flow QR destinations, placement, and print checklist |
