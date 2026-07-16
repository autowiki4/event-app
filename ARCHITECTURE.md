# Event app architecture

This document explains how the current runnable mock connects Phase 1,
the timed booth experience, booth-leader controls, and Phase 3. For setup, see
`README.md`; for a presentation script, see `DEMO_GUIDE.md`.

## System shape

The browser UI is a collection of static HTML, CSS, and JavaScript files under
`web/`. It can use either of two API implementations:

- `demo-server/server.js`: a zero-dependency Node service backed by
  `demo-server/db.json`, with protected reset and shared rehearsal-clock
  features; it can run locally or as the same-origin service on Render;
- `apps-script/Code.gs`: a Google Apps Script implementation of the core
  attendee and staff journey, backed by a Google Sheet.

`web/shared/config.js` selects the backend. The attendee/staff data flow does
not change with that URL. The shared clock and full-data reset are Node-only
extensions enabled when the pages use the same-origin `/api` backend; Apps
Script implements neither extension.

The primary attendee path is:

```text
Phase 1 entry
  name → raffle number → staff confirms wristband → direct continuation
        ↓
One Phase 2 hub
  sticky identity → shared timer → color route → attendee completion taps
        ↓
Phase 3
  after 3 saved taps, or at 4:10 → tick next steps → persist completion
        ↓
Waiting/message screen
  early finish → DON'T GO YET countdown → 4:10 PM main message
```

## Identity and continuity

Phase 1 creates a random canonical `attendeeId`. The backend assigns the
raffle number and stores the name, wristband confirmation, and wristband
color against that record.

The attendee's own browser stores the current identity in `localStorage`.
After wristband confirmation, Phase 1 navigates directly to the hub; Phase 2,
Phase 3, and the final screen continue with that same identity. A tab-level
`sessionStorage` marker is only an optional fast-path hint: refresh, a reopened
mobile tab, or a direct booth QR restores from the persistent identity even if
that marker has disappeared. On a different device, name plus raffle number
reopens the same backend record and stores it locally on that device.

`web/shared/journey-state.js` stores unfinished booth steps, typed answers,
ratings/notes, and unsubmitted Phase 3 ticks under an attendee-scoped key.
Backend check-ins and Phase 3 completion remain canonical. A transient API
failure or missing backend record does not erase the phone identity; the UI
keeps the attendee in place and retries. This makes a mounted persistent data
path mandatory for a hosted Node process.

Phase 2 requires a confirmed wristband. Before 4:10 PM, Phase 3 requires all
three route check-ins. At 4:10 PM it becomes available even when one or more
visits remain unmarked, so a missed stop does not block the attendee after
booth time has ended. Time ending does not create a check-in or mark Phase 2
complete.

Once a wristband color is confirmed, repeating the same color is idempotent
but an unauthenticated call cannot switch the attendee to another group. A
correction requires the organizer key at the API boundary; the mock does not
yet include a dedicated correction screen.

Every attendee stage displays the attendee's name and raffle number in a top
banner. Tapping the name opens the explicit **Log out on this device** action;
that is the normal path that clears the identity, portal markers, and that
attendee's local drafts. Refreshing and ordinary recovery never log them out.

A protected organizer reset is the deliberate exception. The Node database
stores a durable `dataResetAt` marker with the empty event state. When an
attendee browser sees that marker change on its next clock sync, it clears its
saved identity and returns to Phase 1 to register again. Persisting the marker
means a phone that was closed during the reset receives the same instruction
when it is reopened, rather than restoring a deleted attendee record.

Name plus raffle number is record lookup, not strong authentication. Both can
be shared or observed. Do not treat this as an account-security boundary; a
production design should use a verified credential if the stored data or
available actions become sensitive.

## Wristband routing

`web/shared/booths-config.js` is the shared source of truth for booth metadata,
leader steps, colors, routes, and session timestamps.

| Wristband | Session 1 | Session 2 | Session 3 |
|---|---|---|---|
| Blue | Can You Draw Heaven? | Bible Bowl | The Sower, Live |
| Red | Bible Bowl | Can You Draw Heaven? | Art Therapy Table |
| Orange | Art Therapy Table | The Sower, Live | The New Song in Nashville |
| Green | The New Song in Nashville | Art Therapy Table | Can You Draw Heaven? |
| Yellow | The Sower, Live | The New Song in Nashville | Bible Bowl |

Each group visits three of the five booths. The inverse lookup also tells a
booth-leader portal which wristband group should be at that booth during the
current session.

## Shared clock

The mock defines three contiguous sessions:

- Session 1: 3:10–3:30 PM
- Session 2: 3:30–3:50 PM
- Session 3: 3:50–4:10 PM

The ISO timestamps currently assume **July 18, 2026 in Nashville**, where the
event-day offset is `-05:00`. This is an editable mock assumption. It must be
confirmed and changed in `BOOTH_SESSIONS` before a real event if the date,
venue, or timing changes.

`web/shared/event-schedule.js` turns those timestamps into three states:
`before`, an active session, or `ended`. During backend reads, it can estimate
the difference between the device clock and server clock; the browser uses
that offset between refreshes. The attendee timer renders every second, while
the current booth presentation is refreshed periodically.

This reduces ordinary phone-clock drift but is not precision show control. A
bad network connection can delay leader updates. Booth completion taps are
staged locally for two minutes and retried because a venue-wide burst is most
likely during each session's final seconds; other requests remain online-only.
The hub shows an offline note and continues from its last clock sync.

For deterministic local rehearsals, `event-schedule.js` recognizes
`?preview=before|1|2|3|ended` only on `localhost`, `127.0.0.1`, or `::1`.
Preview mode freezes the selected state; it does not simulate a ticking
20-minute session. Attendee navigation preserves the preview value from Phase
1 through the hub, Phase 3, and the final waiting/message screen.

The Node service adds a second, shared rehearsal layer. After organizer
authentication, the dashboard can anchor the shared clock at any exact second
from **3:10:00 through 4:10:00 PM America/Chicago**. A continuous slider,
exact-time field, and 3:10/3:30/3:50/4:10 boundary shortcuts all preserve the
three 20-minute session windows. A legacy **Show waiting lobby** action anchors
the clock before Session 1, and **Use live CDT clock** removes the override and
returns every screen to actual Chicago time.

The protected `setDemoClock` action changes the in-memory mode and anchor. The
clock ticks normally from that anchor; it is not a frozen preview. The public
`eventClock` action returns only clock state plus the non-PII reset marker.
Attendee, overall-organizer, and booth-staff pages sample that state about
every five seconds with randomized staggering and pause polling while hidden.
Their countdowns still update locally every second, and separate browsers
connected to the same Node process stay in sync. An active
organizer-controlled mode takes precedence over a page's query preview.

This shared override works with the same-origin Node `/api`, locally or on
Render. The Apps Script adapter exposes neither clock action, its organizer
controls are hidden, and its pages continue to use synchronized real time.
The timeline is a rehearsal convenience, not resilient show control.

## Unified Phase 2 attendee hub

`web/phase2-booths/hub.html` is the primary Phase 2 attendee URL. It:

1. restores the Phase 1 identity, or asks for name plus raffle number once on
   a new device;
2. loads the wristband's three-stop route and completed check-ins;
3. shows the shared session label and countdown;
4. resolves the correct booth for the current color and session;
5. asks once for a personal phone number, with a raffle-only path for guests
   who do not have a unique number;
6. polls that booth's public presentation state and links the active card to
   the matching timed activity page without another sign-in;
7. records completion only when the attendee taps **Finish** in the activity
   or **Mark this booth complete** in the hub;
8. keeps the active route row reopenable, even after that tap, until the
   session ends; and
9. reveals Phase 3 when all three taps are saved, or at 4:10 PM with any
   untapped visits still visibly unmarked.

A scheduled check-in includes the booth, attendee, session number/ID, and
wristband color. Repeating the same attendee/booth combination updates the
existing check-in instead of inflating the booth count or changing the
original completion time. The clock changes the active booth and eventually
closes booth access; it never manufactures completion.

The five `booth-*.html` pages provide the detailed activity reached from the
active hub card. Their own route checks still reject early, late, or
wrong-wristband access. The Art Therapy/New Song kiosk pages remain optional
staff-assistance fallbacks and should not be printed as attendee links.

## Booth-leader control flow

`web/organizer/index.html` is the canonical staff entry point. It links to the
overall organizer dashboard and one staff page per booth under
`web/phase2-staff/`. The former `web/phase2-staff/index.html` directory remains
as a compatibility redirect. Each booth page uses the same shared module but
loads only that booth's metadata and API data.

A booth leader chooses:

- a presentation status (`waiting`, `live`, `paused`, `wrap`, or `complete`);
- one of the activity steps defined for that booth; and
- an optional announcement.

Saving calls the protected `updateBoothPresentation` action. The backend
stores one current presentation record for that booth. The attendee hub calls
the read-only `boothPresentation` action without receiving the organizer key.
`boothDashboardData` returns that booth's current presentation and recent
check-ins to the authenticated staff page.

Control writes include the last-seen `version`. The backend rejects a stale
leader tab instead of silently overwriting a newer update. This is still a
small mock rather than a full multi-operator show-control system, so staff
should decide who owns each booth page during a live session.

New Song is a specialized Node/Render-only controller while retaining the
existing attendee and staff URLs. Its independent session controllers serve
Green wristbands in Session 1, Yellow in Session 2, and Orange in Session 3,
and progress through `welcome → voting → winner → verse → complete`. The first
vote from an attendee is locked. Staff see a live tally for only the active
session/run and control when the winner, Revelation 14:3, and completion are
shown. Restarting one session archives its current run and opens a clean one.

The canonical ten-song poll is: **God in Me**, **He Turned It**, **Victory**,
**Brighter Day**, **Praise — Elevation Worship**, **Jireh**, **I Thank God —
Maverick City**, **Amen — Madison Ryann Ward**, **Quick — Caleb Gordon**, and
**Goodbye Yesterday — Elevation Rhythm**.

All booth and organizer pages currently use the same organizer key. The API
does filter booth dashboard results by the requested booth, but the key does
not prevent its holder from opening a different booth page or the overall
dashboard. A live deployment should use role-based or booth-specific access,
key rotation, and an audit/incident plan.

## Phase 3

`web/phase3-signup/index.html` reuses the saved identity or performs the same
name-plus-raffle lookup on a new device. It renders the name and raffle number
at the top, then presents each next-step option as a checkbox-style card.

The page first loads `mySignupSelections`, so reopening it preserves earlier
ticks. One `saveSignupSelections` request reconciles the complete set, writes
one `SignUps` row per selected option, and persists Phase 3 completion on the
attendee record. **No thanks, finish** persists the same completion state even
though it creates no option rows. There are no email, rating, stars, comments,
or social-sharing questions in the attendee form. Existing Sheet columns for
older optional details remain for backend compatibility but the new Phase 3
UI does not collect them.

The organizer dashboard may still confirm an expressed interest in person.
After a successful Phase 3 save, the final page verifies the persisted
completion. Before 4:10 PM it shows the original-style **DON'T GO YET** card
and countdown, with a return-to-booth action while a session remains active.
At 4:10 PM the card switches to the main-message state. A direct Phase 3 URL
uses the same client-side eligibility rules and returns an early attendee to
the hub.

## Data model

The local JSON object and Google Sheet tabs represent the same concepts:

- **Attendees:** canonical ID, aliases, name, optional legacy phone, raffle
  number, registration time, wristband confirmation time, color, and Phase 3
  completion time.
- **BoothCheckins:** attendee, booth, time, method, and optional booth/session
  metadata.
- **SongVotes:** one immediate, run-scoped New Song choice per attendee; the
  first vote is locked and available to the live staff tally before check-in.
- **SignUps:** one row per selected next-step option plus staff confirmation
  fields.
- **BoothControls:** one current status, step, message, timestamps, and version
  per booth.
- **Meta:** the raffle counter.

The Node JSON object additionally stores the durable top-level `dataResetAt`
marker used by `resetDemo`. The Apps Script Sheet has no equivalent because
that adapter does not implement the full-data reset. The Node object also has
`triviaSessions` (one versioned welcome/question/reveal/complete controller for
each rotation), `triviaAnswers`, and `triviaRunHistory`. Draw Heaven similarly
uses `heavenSessions`, `heavenConfirmations`, and `heavenRunHistory`. New Song
uses `newSongSessions`, run-scoped `songVotes`, and `newSongRunHistory`. Every
specialized attendee response carries a `runId`, so restarting a rotation
opens an empty active run without overwriting the archived answers,
confirmations, votes, results, or staff summary from the prior run. These
collections are not part of the Apps Script sketch.

See `apps-script/SHEET_SCHEMA.md` for exact columns.

## API boundary

The main attendee actions are `registerAttendee`, `confirmWristband`,
`loginAttendee`, `attendeePortalSession`, `myCheckins`, `mySignupSelections`,
`boothPresentation`, `boothCheckin`, `saveSongVote`, `saveSignupSelections`,
and the legacy `submitSignup` action. `saveSignupSelections` records Phase 3 completion for
both selected options and the empty **No thanks** path; reads return that
completion state so the final page cannot be reached by merely opening Phase
3.

The protected actions shared by both backends are `verifyOrganizer`,
`updateBoothPresentation`, `boothDashboardData`, `dashboardData`, and
`confirmSignupInPerson`. The Node service additionally has protected
`resetDemo` and `setDemoClock` actions plus the public, PII-free `eventClock`
read. The leader-paced Bible Bowl adds attendee `triviaState`,
`submitTriviaAnswer`, and `completeTrivia` actions plus protected
`triviaDashboardData`, `advanceTriviaSession`, and `resetTriviaSession`
actions. Draw Heaven adds attendee `heavenState` and `confirmHeavenStep` plus
protected `heavenDashboardData`, `advanceHeavenSession`, and
`resetHeavenSession`. New Song adds attendee `newSongState`,
`submitNewSongVote`, and `completeNewSong` plus protected
`newSongDashboardData`, `advanceNewSongSession`, and `resetNewSongSession`.
All three activities keep independent Session 1–3 controllers and require the
version returned by the preceding staff read when advancing. Their session
reset actions archive one run and create the next; only
`resetDemo` deletes the histories. Apps Script intentionally implements none
of these synchronized Node extensions; its New Song endpoint remains a legacy
unsynchronized vote path.
Legacy phone/kiosk actions remain for the optional fallback pages.

`resetDemo` clears all attendees and wristband assignments, check-ins and
scores, New Song sessions/votes/history, Phase 3 sign-ups, booth
presentation/control state, all other active and archived leader-paced runs,
and the raffle counter. It writes the same fresh state to the primary JSON
file and backup, advances `dataResetAt`, and thereby clears connected or
reopened attendee identities at their next sync. It deliberately does not
change the selected clock mode or anchor.

Public presentation reads return only the booth's display state and server
time. They do not return the organizer key, attendee roster, or event-wide
dashboard data.

## What still needs a production decision

- Confirm the event date, Nashville timezone assumption, and exact session
  transitions.
- Replace the shared organizer key with appropriate staff authentication and
  authorization.
- Test venue Wi-Fi capacity and define an offline/manual fallback.
- Treat around 150 as a planning estimate rather than a registration cap. If
  turnout is near that estimate, keep wristband colors reasonably close to 30
  each. The protected organizer dashboard exposes the live distribution,
  current scheduled booth, and attendee progress roster under each color.
- Decide attendee-data consent, access, retention, export, and deletion rules.
- Update and validate the final QR plan after a stable public URL exists.
- Test real devices, accessibility, staff handoff, and recovery from late or
  incorrectly assigned wristbands.

The included Apps Script backend provides core-journey compatibility for
testing the proposed shape, but no remote clock or full-data reset parity. It
does not remove these operating and security decisions.
