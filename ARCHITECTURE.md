# Event app architecture

This document explains how the current runnable mock connects Phase 1,
the timed booth experience, booth-leader controls, and Phase 3. For setup, see
`README.md`; for a presentation script, see `DEMO_GUIDE.md`.

## System shape

The browser UI is a collection of static HTML, CSS, and JavaScript files under
`web/`. It can use either of two API implementations:

- `demo-server/server.js`: a zero-dependency local Node server backed by
  `demo-server/db.json`, with an additional in-memory rehearsal clock;
- `apps-script/Code.gs`: an API-compatible Google Apps Script implementation
  backed by a Google Sheet.

`web/shared/config.js` selects the backend. The attendee/staff data flow does
not change with that URL; demo-clock UI and polling are enabled only for the
local `/api` backend.

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
`sessionStorage` marker records access to the unified Phase 2 portal or Phase
3. On a different device, name plus raffle number reopens the same backend
record and stores it locally on that device.

Phase 2 requires a confirmed wristband. Before 4:10 PM, Phase 3 requires all
three route check-ins. At 4:10 PM it becomes available even when one or more
visits remain unmarked, so a missed stop does not block the attendee after
booth time has ended. Time ending does not create a check-in or mark Phase 2
complete.

Once a wristband color is confirmed, repeating the same color is idempotent
but an unauthenticated call cannot switch the attendee to another group. A
correction requires the organizer key at the API boundary; the mock does not
yet include a dedicated correction screen.

The hub and Phase 3 display the attendee's name and raffle number in a top
banner. This is both a reminder and a quick way to notice that a shared device
is showing the wrong person's session. The **Switch** action clears the local
identity and portal markers.

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
bad network connection can delay leader updates, and there is no offline
queue. The hub shows an offline note and continues from its last clock sync.

For deterministic local rehearsals, `event-schedule.js` recognizes
`?preview=before|1|2|3|ended` only on `localhost`, `127.0.0.1`, or `::1`.
Preview mode freezes the selected state; it does not simulate a ticking
20-minute session. Attendee navigation preserves the preview value from Phase
1 through the hub, Phase 3, and the final waiting/message screen.

The Node demo adds a second, shared rehearsal layer. After organizer
authentication, the dashboard can select live time, before-event, each
session midpoint, each session's final 15 seconds, or the post-booth state.
The protected `setDemoClock` action changes an in-memory override, while the
public `eventClock` action returns only the current clock state and no attendee
data. Attendee, completion, and booth-staff pages poll that state every second,
so separate browsers connected to the same process stay in sync. An active
organizer-controlled mode takes precedence over a page's query preview.

This shared override deliberately exists only in `demo-server`. The Apps
Script adapter exposes neither action, the organizer controls are hidden for
that backend, and live pages continue to use synchronized real time. The
demo-clock presets are a rehearsal convenience, not resilient show control.

## Unified Phase 2 attendee hub

`web/phase2-booths/hub.html` is the primary Phase 2 attendee URL. It:

1. restores the Phase 1 identity, or asks for name plus raffle number once on
   a new device;
2. loads the wristband's three-stop route and completed check-ins;
3. shows the shared session label and countdown;
4. resolves the correct booth for the current color and session;
5. polls that booth's public presentation state;
6. records completion only when the attendee taps **Mark this booth complete**;
7. keeps the active route row reopenable, even after that tap, until the
   session ends; and
8. reveals Phase 3 when all three taps are saved, or at 4:10 PM with any
   untapped visits still visibly unmarked.

A scheduled check-in includes the booth, attendee, session number/ID, and
wristband color. Repeating the same attendee/booth combination updates the
existing check-in instead of inflating the booth count or changing the
original completion time. The clock changes the active booth and eventually
closes booth access; it never manufactures completion.

The five `booth-*.html` pages and the Art Therapy/New Song kiosk pages remain
as optional compatibility or staff-assistance fallbacks. They are not part of
the normal color-routed journey and should not be printed as the default booth
links.

## Booth-leader control flow

There is one staff page per booth under `web/phase2-staff/`. Each uses the
same shared module but loads only that booth's metadata and API data.

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
- **SignUps:** one row per selected next-step option plus staff confirmation
  fields.
- **BoothControls:** one current status, step, message, timestamps, and version
  per booth.
- **Meta:** the raffle counter.

See `apps-script/SHEET_SCHEMA.md` for exact columns.

## API boundary

The main attendee actions are `registerAttendee`, `confirmWristband`,
`loginAttendee`, `attendeePortalSession`, `myCheckins`, `mySignupSelections`,
`boothPresentation`, `boothCheckin`, `saveSignupSelections`, and the legacy
`submitSignup` action. `saveSignupSelections` records Phase 3 completion for
both selected options and the empty **No thanks** path; reads return that
completion state so the final page cannot be reached by merely opening Phase
3.

The protected staff actions are `verifyOrganizer`,
`updateBoothPresentation`, `boothDashboardData`, `dashboardData`,
`confirmSignupInPerson`, and the demo reset. The Node demo additionally has
the protected `setDemoClock` action and a public, PII-free `eventClock` read;
these two demo-clock actions intentionally have no Apps Script parity. Legacy
phone/kiosk actions remain for the optional fallback pages.

Public presentation reads return only the booth's display state and server
time. They do not return the organizer key, attendee roster, or event-wide
dashboard data.

## What still needs a production decision

- Confirm the event date, Nashville timezone assumption, and exact session
  transitions.
- Replace the shared organizer key with appropriate staff authentication and
  authorization.
- Test venue Wi-Fi capacity and define an offline/manual fallback.
- Decide attendee-data consent, access, retention, export, and deletion rules.
- Update and validate the final QR plan after a stable public URL exists.
- Test real devices, accessibility, staff handoff, and recovery from late or
  incorrectly assigned wristbands.

The included Apps Script backend provides API parity for testing the proposed
shape. It does not remove these operating and security decisions.
