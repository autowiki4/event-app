# Event app architecture

This document explains how the current runnable mock connects Phase 1,
the timed booth experience, booth-leader controls, and Phase 3. For setup, see
`README.md`; for a presentation script, see `DEMO_GUIDE.md`.

## System shape

The browser UI is a collection of static HTML, CSS, and JavaScript files under
`web/`. The complete current experience uses:

- `demo-server/server.js`: a zero-dependency Node service backed by
  `demo-server/db.json`, with protected reset and shared rehearsal-clock
  features; it can run locally or as the same-origin service on Render; and
- optionally, `demo-server/google-sheets-service-account.js` as the server-only
  direct Sheets API writer that mirrors current Node state into a shared Google
  Sheet.

`Code.gs` also retains a limited legacy implementation of the core attendee
and staff API. `web/shared/config.js` can select that adapter, but it does not
implement the shared clock, full reset, or specialized leader-paced booth
controllers. The Sheet export does not select that adapter: the web app keeps
`API_BASE_URL: "/api"`, Node remains authoritative, and only the server knows
the spreadsheet ID, service-account key, and short-lived access token.

The primary attendee path is:

```text
Phase 1 entry
  name + phone → In person/Online → immediate raffle → color → continuation
        ↓
One Phase 2 hub
  sticky identity → shared timer → color route → attendee completion taps
        ↓
Phase 3
  after 2 saved regular taps → tick next steps → persist completion
        ↓
Message and optional-extra flow
  4:15–4:50 message → choose unvisited booth or Connections
        ↓
  4:50–5:10 optional booth → Connections
```

## Identity and continuity

Phase 1 creates a random device `attendeeId` and immediately creates the
attendee record with name, phone, attendance mode (`in_person` or `online`),
registration time, and the next raffle number. Nothing is sent to the phone.
In-person attendees choose the wristband color they were given; online
attendees choose a color for room assignment. The selected mode and color are
stored against the same record and shown to Overall Organizer.

The attendee's own browser stores the current identity in `localStorage`.
After wristband confirmation, Phase 1 navigates directly to the hub; Phase 2,
Phase 3, and the final screen continue with that same identity. A tab-level
`sessionStorage` marker is only an optional fast-path hint: refresh, a reopened
mobile tab, or a direct booth QR restores from the persistent identity even if
that marker has disappeared. The `/attend` route and attendee return QR open
the Phase 1 entry/resume screen, which finishes any missing wristband step
before routing the attendee to the shared hub. On a different device, name
plus phone reopens the backend record and stores
it locally on that device; the raffle number remains display-only.

`web/shared/journey-state.js` stores unfinished booth steps, typed answers,
activity responses and unsubmitted Phase 3 ticks under an attendee-scoped key.
Backend check-ins and Phase 3 completion remain canonical. A transient API
failure or missing backend record does not erase the phone identity; the UI
keeps the attendee in place and retries. This makes a mounted persistent data
path mandatory for a hosted Node process.

Phase 2 requires a confirmed color. Phase 3 requires both route check-ins and
is available while the regular booth schedule is active. At 4:15 PM the
message takes over every attendee screen. Time ending does not create a
check-in or mark Phase 2 complete; an unvisited booth can instead remain
eligible for the attendee's optional 4:50 choice.

Once a wristband color is confirmed, repeating the same color is idempotent
but an unauthenticated call cannot switch the attendee to another group. A
correction requires the Overall Organizer password at the API boundary; the
mock does not yet include a dedicated correction screen.

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

Name-plus-phone recovery is a lightweight record lookup rather than strong
authentication. The app sends no message and does not prove control of the
phone number. Do not treat it as an account-security boundary if the stored
data or actions become sensitive.

## Wristband routing

`web/shared/booths-config.js` is the shared source of truth for booth metadata,
leader steps, colors, routes, and session timestamps.

| Wristband | Session 1 | Session 2 |
|---|---|---|
| Blue | Can You Draw Heaven? | Bible Bowl |
| Red | Bible Bowl | Can You Draw Heaven? |
| Orange | Art Therapy Table | The Heaven Booth |
| Green | The New Song in Nashville | Art Therapy Table |
| Yellow | The Heaven Booth | The New Song in Nashville |

Each group visits two of the five booths. Across the five color routes, every
booth is used once in each rotation. The inverse lookup also tells a
booth-leader portal which wristband group should be at that booth during the
current session.

## Shared clock

The mock defines two regular booth sessions, a message window, and one
optional extra-booth window:

- Session 1: 3:35–3:55 PM
- Session 2: 3:55–4:15 PM
- Main message: 4:15–4:50 PM
- Optional extra booth: 4:50–5:10 PM
- Connections: 5:10 PM onward

The ISO timestamps currently assume **July 18, 2026 in Nashville**, where the
event-day offset is `-05:00`. This is an editable mock assumption. It must be
confirmed and changed across the regular-session, message, extra-session, and
event-end constants in `web/shared/booths-config.js` before a real event if the
date, venue, or timing changes.

`web/shared/event-schedule.js` turns those timestamps into five phases:
`before`, `active`, `message`, `extra`, or `connections`. During backend reads, it
can estimate the difference between the device clock and server clock; the
browser uses that offset between refreshes. The attendee timer renders every
second, while the current booth presentation is refreshed periodically.

This reduces ordinary phone-clock drift but is not precision show control. A
bad network connection can delay leader updates. Booth completion taps are
staged locally for two minutes and retried because a venue-wide burst is most
likely during each session's final seconds; other requests remain online-only.
The hub shows an offline note and continues from its last clock sync.

For deterministic local rehearsals, `event-schedule.js` recognizes
`?preview=before|1|2|message|extra|connections` only on `localhost`,
`127.0.0.1`, or `::1`.
Preview mode freezes the selected state; it does not simulate a ticking
20-minute session. Attendee navigation preserves the preview value from Phase
1 through the hub, Phase 3, and the final waiting/message screen.

The Node service adds a second, shared rehearsal layer. After organizer
authentication, the dashboard can anchor the shared clock at any exact second
from **3:35:00 through 5:10:00 PM America/Chicago**. A continuous slider,
exact-time field, and 3:35/3:55/4:15/4:50/5:10 boundary shortcuts preserve
both 20-minute rotations, the 35-minute message, and the optional 20-minute
extra booth. A **Show waiting
lobby** action anchors the clock before Session 1, and **Use live CDT clock**
removes the override and returns every screen to actual Chicago time.

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
That adapter retains legacy single-key authentication, but it is not deployed
or called while `web/shared/config.js` uses the current same-origin `/api` path.
The timeline is a rehearsal convenience, not resilient show control.

## Unified Phase 2 attendee hub

`web/phase2-booths/hub.html` is the primary Phase 2 attendee URL. It:

1. restores the verified Phase 1 identity, or asks for name plus phone on
   a new device;
2. loads the attendee's attendance mode, color, two-stop route, completed
   check-ins, and optional-extra choice;
3. shows the shared session label and countdown;
4. resolves the correct booth for the current color and session;
5. polls that booth's public presentation state and links the active card to
   the matching timed activity page without another sign-in;
6. records completion only when the attendee taps **Finish booth** in the
   activity, then returns the attendee to the schedule and does not reopen the
   completed room;
7. reveals Phase 3 when both regular taps are saved while the regular schedule
   is active;
8. shows **The message is being delivered. I hope you get blessed today.** on
   every attendee screen from 4:15–4:50;
9. at 4:50, offers one booth not already present in that attendee's check-ins,
   plus Connections, and persists the choice so it cannot be switched; and
10. opens the selected booth as Session 3 until 5:10, then directs the attendee
    to Connections after completion or when the window ends.

A scheduled check-in includes the booth, attendee, session number/ID, and
color. An optional-booth check-in uses Session 3. Repeating the same
attendee/booth combination updates the
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
as a compatibility redirect. Bible Bowl, Draw Heaven, Art Therapy, and New
Song use specialized ordered controllers. The Heaven Booth uses the shared
ordered-screen controller.

Every booth exposes a fixed **Next** action that publishes the next screen to
attendees. The Heaven Booth also exposes **Back** and direct screen selection.
Leaving the controls alone holds the current screen, so booth leaders do not
manage a separate waiting/live/paused/wrap selector or a free-text
announcement. Restarting a run remains a separate, confirmed action.

Forward and direct-publish controls are clock-gated. Unless the selected
Session 1, Session 2, or Session 3 is the session currently live on the shared
clock, the portal disables them and displays **Wait for booth time**. The Node
API independently applies the same active-session check to every booth control
write. This fail-closed server check prevents a waiting-lobby tab, stale
session tab, or crafted request from changing attendee screens outside that
booth window.

The shared Heaven Booth controller calls the protected
`updateBoothPresentation` action. The backend stores an independent ordered
presentation for Sessions 1, 2, and 3 while retaining older status values for
saved-data/API compatibility. The controller follows the clock-current run,
includes its session number on every publish, and rejects stale or
wrong-session updates at a rotation boundary. The current UI derives waiting,
active, and complete from the ordered flow.
The attendee hub calls
the read-only `boothPresentation` action without receiving any staff password.
`boothDashboardData` returns that booth's current presentation and recent
check-ins to the authenticated staff page.

Control writes include the last-seen `version`. The backend rejects a stale
leader tab instead of silently overwriting a newer update. This is still a
small mock rather than a full multi-operator show-control system, so staff
should decide who owns each booth page during a live session.

Art Therapy is a specialized Node/Render-only controller at its existing
attendee and staff URLs. Its independent Session 1–3 runs serve the two routed
color groups plus attendees who select Art Therapy at 4:50, and move through
`welcome → definition → importance →
purpose_image → heart_question → proverbs → philippians → create → finished →
complete`. Only staff can change the published phase. The attendee client
polls the versioned state, rejects stale responses, and receives its completion
action only in the final phase. The app stores no artwork, reflection text,
rating, or comment; immutable `artCompletions` preserve final Done taps by run.

New Song is a specialized Node/Render-only controller while retaining the
existing attendee and staff URLs. Its independent session controllers serve
Green attendees in Session 1, Yellow in Session 2, and attendees who select
New Song in Session 3,
and progress through `welcome → voting → winner → verse → complete`. The first
vote from an attendee is locked. Staff see a live tally for only the active
session/run and control when the winner, Revelation 14:3, and completion are
shown. Restarting one session archives its current run and opens a clean one.
The verse is labelled **Revelation 14:3 · NIV** and uses this exact text:

> And they sang a new song before the throne and before the four living
> creatures and the elders. No one could learn the song except the 144,000 who
> had been redeemed from the earth.

Bible Bowl, Draw Heaven, Art Therapy, New Song, and The Heaven Booth keep
independent Session 1–3 progress. The four specialized portals expose session
tabs and archived runs; The Heaven Booth follows the clock-current session
automatically and keeps a separate ordered presentation for each run. Session
3 booth access is based on the attendee's persisted extra choice rather than
the original color route.

The canonical eleven-song poll is: **He Turned It**, **Victory**, **Brighter
Day**, **Praise - elevation worship**, **I thank God - maverick city**, **Amen-
Madison Ryann Ward**, **Quick - Caleb Gordon**, **Goodbye Yesterday - elevation
rhythm**, **He called me**, **247**, and **Elohim**.

The Node API uses six strict staff scopes. `EVENT_APP_ORGANIZER_KEY` grants
Overall Organizer only; `EVENT_APP_DRAW_HEAVEN_KEY`,
`EVENT_APP_BIBLE_BOWL_KEY`, `EVENT_APP_HEAVEN_BOOTH_KEY`,
`EVENT_APP_ART_THERAPY_KEY`, and `EVENT_APP_NEW_SONG_KEY` each grant only the
named booth. The browser sends the requested non-secret scope along with the
entered password, while every protected API action independently derives and
enforces its required scope. There is no master-password or cross-scope
fallback. Passwords stay in the staff page's memory and are not written to a
URL or browser storage.

Hosted runtimes fail closed: a missing value disables only its matching
portal, and duplicate values are treated as invalid rather than allowing one
password to span roles. Local development has separate defaults: `demo`,
`demo-draw-heaven`, `demo-bible-bowl`, `demo-heaven-booth`,
`demo-art-therapy`, and `demo-new-song`.

For an existing Render service, preserve the current
`EVENT_APP_ORGANIZER_KEY` value as the Overall Organizer credential. Add the
five booth variables with unique strong values **before** deploying the new
code, then choose **Save and deploy** and distribute each value only to its
leader. Existing staff tabs must authenticate again. The change is confined
to staff authorization: routes, attendee state, the persistent database, and
the Google Sheets credentials and managed-tab schema are unchanged.

## Phase 3

`web/phase3-signup/index.html` reuses the saved identity or performs the same
name-plus-phone lookup on a new device. It renders the name and raffle number
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
completion. From 4:15–4:50 it shows the exact message notice and a countdown
to the optional activity. At 4:50 it routes to the hub's unvisited-booth or
Connections chooser; at 5:10 it routes to Connections. A direct Phase 3 URL
uses the same client-side eligibility rules and returns an early attendee to
the hub.

## Data model

The Node JSON object is the authoritative data store for the complete current
experience:

- **Attendees:** canonical ID, aliases, name, collected or organizer-paired
  phone, attendance mode, raffle number, registration time, color confirmation
  time, color, Phase 3 completion time, optional extra-booth/Connections choice,
  and extra completion time.
- **BoothCheckins:** attendee, booth, time, method, and optional booth/session
  metadata.
- **SongVotes:** one immediate, run-scoped New Song choice per attendee; the
  first vote is locked and available to the live staff tally before check-in.
- **SignUps:** one row per selected next-step option plus staff confirmation
  fields.
- **BoothControls:** one current status, step, message, timestamps, and version
  per booth.
- **Meta:** the raffle counter.

It additionally stores the durable top-level `dataResetAt` marker used by
`resetDemo` and has
`triviaSessions` (one versioned welcome/question/reveal/complete controller for
each rotation), `triviaAnswers`, and `triviaRunHistory`. Draw Heaven similarly
uses `heavenSessions`, `heavenConfirmations`, and `heavenRunHistory`. New Song
uses `newSongSessions`, run-scoped `songVotes`, and `newSongRunHistory`. Art
Therapy uses `artSessions`, immutable run-scoped `artCompletions`, and
`artRunHistory`. Every
specialized attendee response carries a `runId`, so restarting a rotation
opens an empty active run without overwriting the archived answers,
confirmations, votes, results, or staff summary from the prior run. These
collections are not implemented by the legacy Apps Script API adapter.

When the optional exporter is configured, every successful durable Node write
queues a complete snapshot. Bursts are coalesced and only the newest pending
snapshot is retained. A server-only service account writes directly through
the Google Sheets API and strictly maps the logical export to
`Live_Attendees`, `Live_BoothResults`, `Live_SignUps`, `Live_TriviaAnswers`,
`Live_HeavenConfirmations`, `Live_SongVotes`, and `Live_ExportMeta`. Full
replacement prevents duplicate rows and reconciles changed selections,
identity merges, and reset deletions. The distinct `Live_*` names avoid
colliding with tabs used if the same script is tested as the legacy backend.
Free-text Art reflections, Bible Bowl answer/score data, and New
Song vote/result data are excluded from the mirror. The two activity tabs stay
header-only so a full sync clears old rows while preserving the Sheet schema;
`Live_BoothResults.extraData` contains only allowlisted non-activity
operational metadata.
Missing managed tabs, necessary grid expansion, header freezing, stale-value
clearing, and all seven replacements are submitted as one atomic
`spreadsheets.batchUpdate`. Strings are always sent as `stringValue`, never as
formulas. A rejected batch leaves the prior snapshot intact and the retry sends
the newest complete state. `Live_ExportMeta` is the final managed tab in the
batch and records that snapshot's `generatedAt` marker.
The export is a best-effort operational mirror rather than a second source of
truth or backup.

See `apps-script/SHEET_SCHEMA.md` for exact columns.

## API boundary

The main attendee actions are `registerAttendee`, `confirmWristband`,
`loginAttendee`, `attendeePortalSession`, `myCheckins`, `mySignupSelections`,
`boothPresentation`, `boothCheckin`, `saveSongVote`, `saveSignupSelections`,
`chooseExtraDestination`, and the legacy `submitSignup` action.
`chooseExtraDestination` accepts one unvisited booth or Connections only
during 4:50–5:10 and preserves that first choice. `saveSignupSelections`
records Phase 3 completion for
both selected options and the empty **No thanks** path; reads return that
completion state so the final page cannot be reached by merely opening Phase
3.

The protected action names shared by both backends include `verifyOrganizer`,
`updateBoothPresentation`, `boothDashboardData`, `dashboardData`, and
`confirmSignupInPerson`. On Node, each action is bound to Overall Organizer or
the relevant booth scope. The legacy Apps Script adapter still uses its one
legacy organizer key and is not the configured backend when
`API_BASE_URL` is `/api`. The Node service additionally has protected
`resetDemo`, `setDemoClock`, `googleSheetsExportStatus`, and
`syncGoogleSheetsExport` actions plus the public, PII-free `eventClock` read.
The export status is sanitized and never returns the spreadsheet ID,
service-account email/key, or access token.
The leader-paced Bible Bowl adds attendee `triviaState`,
`submitTriviaAnswer`, and `completeTrivia` actions plus protected
`triviaDashboardData`, `advanceTriviaSession`, and `resetTriviaSession`
actions. Draw Heaven adds attendee `heavenState` and `confirmHeavenStep` plus
protected `heavenDashboardData`, `advanceHeavenSession`, and
`resetHeavenSession`. Art Therapy adds attendee `artState` and `completeArt`
plus protected `artDashboardData`, `advanceArtSession`, and `resetArtSession`.
New Song adds attendee `newSongState`,
`submitNewSongVote`, and `completeNewSong` plus protected
`newSongDashboardData`, `advanceNewSongSession`, and `resetNewSongSession`.
All four activities keep independent Session 1–3 controllers and require the
version returned by the preceding staff read when advancing. Their session
reset actions archive one run and create the next; only
`resetDemo` deletes the histories. Apps Script intentionally implements none
of these synchronized Node extensions; its New Song endpoint remains a legacy
unsynchronized vote path.
Legacy phone/kiosk actions remain for the optional fallback pages.

`resetDemo` clears all attendees, attendance/color assignments, optional-extra
choices, check-ins and
scores, New Song sessions/votes/history, Phase 3 sign-ups, booth
presentation/control state, all other active and archived leader-paced runs,
and the raffle counter. It writes the same fresh state to the primary JSON
file and backup, advances `dataResetAt`, and thereby clears connected or
reopened attendee identities at their next sync. It deliberately does not
change the selected clock mode or anchor. If the Sheet mirror is configured,
the empty post-reset state is exported and clears the `Live_*` data rows.

Public presentation reads return only the booth's display state and server
time. They do not return staff passwords, attendee roster, or event-wide
dashboard data.

## What still needs a production decision

- Confirm the event date, Nashville timezone assumption, and exact session
  transitions.
- Decide whether the scoped static staff passwords are sufficient or should be
  replaced with managed accounts, rotation, recovery, and audit logging.
- Test venue Wi-Fi capacity and define an offline/manual fallback.
- Treat around 150 as a planning estimate rather than a registration cap. If
  turnout is near that estimate, keep wristband colors reasonably close to 30
  each. The protected organizer dashboard exposes the live distribution,
  current scheduled booth, in-person/online status, optional extra choice, and
  attendee progress roster under each color.
- Decide attendee-data consent, access, retention, export, and deletion rules.
  The live Sheet contains attendee names, phone numbers, raffle numbers,
  activity results, and Phase 3 selections; access should be narrower than the
  public event site.
- Update and validate the final QR plan after a stable public URL exists.
- Test real devices, accessibility, staff handoff, and recovery from late or
  incorrectly assigned wristbands.

The included Apps Script code now remains only for legacy core-journey
compatibility testing; it is not in the direct Sheets export path. Its legacy
API mode still has no remote clock, full-data reset, or specialized run parity.
Neither arrangement removes these operating and security decisions.
