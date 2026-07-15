# Event App — Architecture

This explains *why* the app is built the way it is — the identity model,
the data store, and the reasoning behind each phase. For *how to run it*,
see the main `README.md`; for a live walkthrough script, see
`DEMO_GUIDE.md`. Everything described below has been built — this
document reflects the app as it actually exists in this repo, not just a
plan.

Built from `event-app.html` (the original single-file sketch), split into
a real multi-page, multi-device app. Backend: Google Sheets + Apps Script
in production, a zero-dependency Node server for local demos. Every booth has
its own attendee room and booth-scoped staff dashboard; Art Therapy and New
Song also retain optional staff-run kiosk fallbacks. Organizer: a live
dashboard.

## The core problem this solves

People move between phases, booths, and devices during the event. Phase 1 and
Phase 3 have separate attendee URLs, while Phase 2 has five separate attendee
URLs—one for each physical booth—instead of one automatic consumer flow.
Optional staff kiosks can support Art Therapy and New Song, and Phase 3
remains available even when somebody skipped the booths.

One attendee row is reopened in three ways:

- **Phase 1 name + raffle number** — the explicit registration lookup used
  independently by the Phase 2 and Phase 3 portals. Name alone is not enough
  because two attendees can share it. Matching ignores capitalization and
  extra spaces, and a wrong pair returns one generic error without attendee
  details.
- **`attendeeId`** — a random canonical ID created in Phase 1 and saved after
  a successful portal lookup. Each Phase 2 booth uses its own tab-level marker
  (`eventapp.portal.phase2.<boothId>`), and Phase 3 uses
  `eventapp.portal.phase3`. Entering one booth therefore does not silently
  unlock another booth or Phase 3.
- **phone number** — collected once, at the first booth check-in. On an
  attendee's own phone it is linked through their random `attendeeId`. At a
  staff kiosk, the first link is paired with the raffle number already shown
  at entry; returning phones can then be looked up directly.

Name + raffle number is a lightweight event registration lookup, not strong
authentication; both details can be shared or guessed. It solves duplicate
names and cross-device continuity for the current event prototype. Add phone
OTP or another verified credential before using it as a production security
boundary.

All three resolve to the same row in a Google Sheet. If staff pair a phone that was
previously created as a "skipped entry" visitor with a later entry record, the
backend keeps the entry record and raffle number, migrates its booth/sign-up
history, retains the old ID as an alias, and removes the duplicate attendee.
The model assumes one phone number belongs to one attendee for this event.

## Data store: Google Sheet ("EventDB")

One spreadsheet, one Apps Script Web App in front of it acting as a tiny JSON API. Tabs:

**Attendees** — attendeeId, name, phone, raffleNumber, wristbandConfirmedAt, registeredAt

**BoothCheckins** — attendeeId, phone, boothId, boothName, checkedInBy (self / staff name), checkedInAt, rating, note, extraData (JSON string — trivia score, story answers, art prompt shown, song voted for, etc.)

**SignUps** — attendeeId, phone, optionId, optionTitle, email, stars, comment, submittedAt, confirmedInPerson (bool), confirmedBy, confirmedAt

**Meta** — a small key/value tab; currently holds just one row, `raffleCounter`, the last raffle number handed out. Apps Script increments this under a lock before handing out each new number, so two people registering at the exact same instant can never collide.

Every Apps Script action that touches the Sheet uses the same script-lock
boundary, including dashboard/history reads. Besides keeping a merge that
deletes a duplicate attendee row atomic with every row-number-dependent write,
this serializes creation of the four tabs on a brand-new Sheet. The raffle
helper requires the already-held lock rather than acquiring a nested lock, and
pending Sheet writes are flushed before the lock is released. Public strings
are also forced to text before they reach a Sheet cell so attendee input cannot
be interpreted as a spreadsheet formula.

This Sheet *is* "the file with everyone's name and number" you asked for — Attendees tab, filterable/exportable to CSV anytime, no separate export step needed. `File > Download > CSV` in Google Sheets covers a one-click end-of-day export. Exact column layout for every tab is in `apps-script/SHEET_SCHEMA.md`.

Apps Script exposes actions like `registerAttendee`, `loginAttendee`,
`attendeePortalSession`, `confirmWristband`, `findOrRegisterByPhone`,
`boothCheckin`, `submitSignup`, `boothDashboardData`,
`confirmSignupInPerson`, and `dashboardData`. Sensitive staff actions are
authenticated POST requests; the organizer key lives in Apps Script's Script
Properties rather than the public static site. There is no separate server or
database to manage.

## Repo structure

See the annotated file tree in the main `README.md` — it's kept there
(rather than duplicated here) so there's only one place it can go stale.

The short version: each booth is its own static HTML file—its own little
"platform"—using the shared booth-room login and check-in modules. That keeps
the attendee experience specific to the booth where the person is standing
while still writing to the same backend so nothing gets lost as people move
around.

All five booths now have attendee-room pages. The `mode: "self"` /
`mode: "kiosk"` metadata in `web/shared/booths-config.js` preserves the current
operating model and optional kiosk links; it no longer means that Art Therapy
or New Song lacks an attendee room.

## Phase 1 — Entry (own phone, one QR code)

Single QR code, printed once, pointing to `phase1-entry/index.html`.

1. Page loads → generates `attendeeId` if none is saved locally.
2. Name entered → `registerAttendee` → Sheet row created and a unique raffle
   number assigned server-side.
3. A Guardian Angel confirms the wristband handoff in the current prototype.
4. The page ends on a Phase 1-complete screen showing the two details needed
   later: registered name and raffle number. It thanks the attendee, tells
   them they can close the link, and instructs them to open and log in to the
   room link when they arrive at each booth. It does not navigate to Phase 2.

## Phase 2 — Booths (phone number becomes the shared key)

There is no shared Phase 2 attendee login. The five attendee-room links are:

- `phase2-booths/booth-heaven.html`
- `phase2-booths/booth-trivia.html`
- `phase2-booths/booth-story.html`
- `phase2-booths/booth-art.html`
- `phase2-booths/booth-newsong.html`

On first arrival, each room starts with blank name and raffle-number fields.
The attendee explicitly reopens the Phase 1 record, even on the same phone used
at entry, and sees a welcome naming only the booth they are currently visiting.
A completed wristband check is required. The browser stores access under that
booth's own `eventapp.portal.phase2.<boothId>` session marker, while backend
login/session calls still use the common `phase2` policy. This means the same
Phase 1 eligibility check applies everywhere without allowing a Heaven-room
login to unlock Bible Bowl, for example.

`phase2-booths/hub.html` remains only as a compatibility notice for old links;
it explains that the attendee should open the link posted at their current
booth and contains neither the shared login nor a booth picker. Completing a
booth thanks the attendee and tells them they can close that link. Phase 2 does
not automatically navigate into another booth or Phase 3. If the same attendee
finishes the same booth again, the backend updates that booth record instead of
adding a duplicate person to its activity count.

First phone-number entry anywhere calls `findOrRegisterByPhone`. An attendee
room links it to the random attendee ID already on that phone.
The phone gate is still collected once and then reused for the same attendee on
that browser. The optional Art Therapy and New Song kiosks are unlocked with
the organizer key and can pair a new phone with the visitor's raffle number,
preventing a second attendee/raffle record from being created when a kiosk is
their first booth. Before a new pairing is written, staff see the entry name
and raffle number and explicitly confirm the ticket. Staff can mark someone as
having skipped entry only after entering their name; the kiosk then displays
the newly assigned raffle number. Returning kiosk phones need no raffle
re-entry. The current event flow accepts exactly ten phone digits: inputs
format them as `(555) 555-5555`, while the backends and stored rows keep the
canonical digits-only value (`5555555555`).

Phone knowledge alone is not treated as identity proof. If an attendee device
enters a phone already attached to another record, it receives a
generic "ask staff" conflict rather than the other attendee's name or raffle.
This prototype does not perform SMS verification, so a determined caller can
still test whether a number is already linked by comparing success with that
generic conflict. Add OTP verification before treating phone ownership as a
production security boundary.

Each booth check-in writes its own `BoothCheckins` row with whatever that booth's `extraData` is (trivia score, story answers, chosen art prompt, song vote) — same shape as the prototype's per-booth state, just persisted server-side instead of in-page JS state.

The separate staff side starts at `phase2-staff/index.html`. Every booth has
its own URL under that folder. Those pages call authenticated
`boothDashboardData`, which filters on the server and returns only that
booth's count and recent check-ins—never the overall dashboard, Phase 3
sign-ups, or phone numbers. Each page also has a neutral booth-only settings
area; actual controls will be added after that booth's rules are defined. All
pages temporarily share the organizer key, so this is data/UI separation
rather than per-booth authorization; dedicated booth keys can be introduced
when the final controls are defined. Art Therapy and New Song staff pages also
link to their optional kiosk fallbacks.

## Phase 3 — Sign-up (app UI + in-person confirmation)

`phase3-signup/index.html` is a separate attendee portal with its own name +
raffle lookup and its own phase session. It does not depend on a Phase 2 phone
or booth visit. After lookup, the UI stays close to the current sketch: cards
for each option (future events, Bible study, 8-month course, art therapy, refer
a friend), expanding relevant fields per selection. Submitting writes
`SignUps` rows with `confirmedInPerson: false`.

Organizer-facing piece: the dashboard groups sign-ups into one roster per
option, with each person's name, formatted phone number, status, and a one-tap
"Confirm in person" button for whichever staff member is standing with that
attendee at the actual table. Confirmation sets `confirmedInPerson: true`,
`confirmedBy`, and `confirmedAt`. A person who selected multiple options
appears in each relevant roster, without repeating the option title on every
row. This gives you a clean before/after: "said they're interested" vs. "we
actually talked to them and signed them up."

## Organizer dashboard (`organizer/dashboard.html`)

Polls `dashboardData` every 4 seconds. Shows: total registered / wristbands
confirmed / raffle entries, live count per booth, the Bible Bowl
leaderboard, song vote tally, and the grouped Phase 3 sign-up rosters
described above, plus a "Reset demo data" button (rehearsal use only — see
`demo-server/README.md`). The dashboard and kiosk pages stay behind a runtime
organizer-key gate, and the backend independently checks that key on every
sensitive read or mutation. The key stays only in the current page's memory,
not web storage, static source, or a URL; staff re-enter it after a reload or on
each staff page. Drawing the actual raffle winner isn't automated — pick a
number from the Attendees list/dashboard count and call it out live, or add a
"pick random entry" button if you want that automated.

## QR codes and separate links

1. **Entry QR** (Phase 1) — one, printed at the door.
2. **Five Phase 2 booth-room links** — one direct attendee URL per physical
   booth, each with its own login and welcome.
3. **Phase 3 attendee link** — opens the independent final signup login.
4. **Optional staff kiosks** — Art Therapy and New Song retain separate staff
   tools, but those do not replace their new attendee-room links.

The current QR generator is intentionally unchanged and still reflects the
older entry-plus-three-self-service-booths set. Expanding it to the five room
links, deciding which public routes receive printed codes, and printing those
codes are deferred until the app has a deployed public URL. For local testing,
open the localhost room URLs directly and skip the QR page. See
`qr/QR_PLAN.md` for the current generator and deployment note.

## Two interchangeable backends

Every action described above (`registerAttendee`, `loginAttendee`,
`attendeePortalSession`, `confirmWristband`, `findOrRegisterByPhone`,
`boothCheckin`, `submitSignup`, `boothDashboardData`,
`confirmSignupInPerson`, `dashboardData`, `myCheckins`) exists twice:

- **`demo-server/`** — a small zero-dependency Node server, backed by a
  JSON file (`db.json`). Used for local development and rehearsal. No
  Google account, no deployment, no cost.
- **`apps-script/Code.gs`** — the production version, backed by a real
  Google Sheet. Used for the actual event.

`web/shared/api.js` calls both the exact same way — only
`web/shared/config.js`'s `API_BASE_URL` changes between them. This is
what lets you build and rehearse everything for free, then flip one
setting to go live. See `demo-server/README.md` and
`apps-script/README.md` for how to run each.

## Current status

Everything described in this document has been built and tested
end-to-end (see repo `README.md` for how to run it). This file describes
the reasoning behind the design, not a to-do list.
