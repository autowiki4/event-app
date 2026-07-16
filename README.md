# The Perfect Summer Day — event app mock

This repository is a runnable mock and implementation framework for a timed,
multi-device event experience. It is useful for design reviews, rehearsals,
and validating the flow with the event team. It is **not production-ready**:
the event date and operating rules still need confirmation, access is not
strong authentication, and the deployment needs a security and venue-network
review.

The attendee journey is now one continuous flow:

1. **Phase 1 — entry:** enter a name, receive a raffle number, and have a
   Guardian Angel assign and confirm the physical wristband color. Confirmation
   continues directly into Phase 2 with the same attendee identity.
2. **Phase 2 — timed booth route:** keep one attendee hub open. It shows the
   attendee's name and raffle number, a shared timer, the current booth, and
   the booth leader's live instructions. Its active button opens the correct
   timed booth activity without another sign-in. Each wristband visits three
   of the five booths. A visit counts as complete only after the attendee taps
   to mark it; the current route row can be reopened until that session ends.
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

Start at Phase 1. Confirming the wristband continues directly into the hub,
and Phase 3 reuses that same saved attendee identity. On another device, the
attendee enters their Phase 1 name and raffle number once to recover the same
route. The name and raffle number stay visible at the top of the hub and Phase
3 as a reminder. Refreshing or reopening the same phone restores the attendee,
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
├── apps-script/            Google Sheets + Apps Script core-journey backend
├── ARCHITECTURE.md         identity, timing, controls, and data design
├── DEMO_GUIDE.md           a short presentation/rehearsal script
└── qr/QR_PLAN.md           recommended placement and print checklist
```

Both backends implement the core attendee and staff data API. The Node version
writes to `demo-server/db.json` and adds the protected rehearsal reset and
shared-clock controls. The Apps Script version writes to Google Sheets and
deliberately omits `resetDemo`, `setDemoClock`, and the public `eventClock`
read. Switching backends is controlled by `API_BASE_URL` in
`web/shared/config.js`.

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
check-ins and scores, New Song votes, Phase 3 sign-ups, every booth's current
presentation/control state, and the raffle counter. It replaces the backup
with the same empty state. A durable reset marker also tells connected or
reopened attendee browsers to clear their saved identity and return to Phase 1
to register again. The selected simulated/live clock is deliberately left in
place, so reset data separately from choosing the rehearsal time. This reset
is available on the same-origin Node service locally or on Render; the Apps
Script adapter does not implement it.

## Known mock limitations

- Name plus raffle number is convenient record recovery, not strong identity
  verification.
- The synchronized experience still needs working network access. Booth
  completion taps have a narrow two-minute retry queue, but registration,
  leader controls, live voting, and Phase 3 remain online-only.
- Phase 3 eligibility is enforced by the browser from saved check-ins and the
  shared clock, not as an authentication or authorization boundary at the API.
- Booth leaders share one organizer key. Generic booth controls retain only
  one current state; Bible Bowl and Draw Heaven additionally preserve
  session-isolated prior runs, but this is still not a full audited
  show-control system.
- The shared clock controls are Node-service rehearsal helpers, available when
  the site and `/api` share the local or Render origin. The Apps Script path
  has no remote time override or matching full-data reset.
- The leader-paced Bible Bowl, immediate answer saving, answer reveals, and
  session-separated leaderboards also require that same Node/Render backend;
  they are not implemented by the Apps Script sketch.
- Draw Heaven's leader-paced phases, attendee confirmations, catch-up flow,
  and archived run summaries likewise require the Node/Render backend.
- QR codes must be regenerated and device-tested after the app has a stable
  public URL; never print localhost or preview-query links.

## Related docs

| Document | Purpose |
|---|---|
| `ARCHITECTURE.md` | How identity, schedule synchronization, routing, and booth controls connect |
| `DEMO_GUIDE.md` | How to present the unified flow using the shared timeline |
| `demo-server/README.md` | Node backend, data file, reset, and API differences |
| `apps-script/README.md` | Google Apps Script deployment sketch |
| `apps-script/SHEET_SCHEMA.md` | Sheet tabs and columns |
| `qr/QR_PLAN.md` | Unified-flow QR destinations, placement, and print checklist |
