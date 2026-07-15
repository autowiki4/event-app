# Event App — Architecture

This explains *why* the app is built the way it is — the identity model,
the data store, and the reasoning behind each phase. For *how to run it*,
see the main `README.md`; for a live walkthrough script, see
`DEMO_GUIDE.md`. Everything described below has been built — this
document reflects the app as it actually exists in this repo, not just a
plan.

Built from `event-app.html` (the original single-file sketch), split into
a real multi-page, multi-device app. Backend: Google Sheets + Apps Script
in production, a zero-dependency Node server for local demos. Booths: a
mix of self-service (attendee's own phone) and staff-run kiosks.
Organizer: a live dashboard.

## The core problem this solves

People move between phases and devices during the event. Phase 1, Phase 2,
and Phase 3 therefore have separate attendee URLs instead of one automatic
consumer flow. Phase 2 can run on an attendee phone or staff tablet, and Phase
3 remains available even when somebody skipped the booths.

One attendee row is reopened in three ways:

- **Phase 1 name + raffle number** — the explicit registration lookup used
  independently by the Phase 2 and Phase 3 portals. Name alone is not enough
  because two attendees can share it. Matching ignores capitalization and
  extra spaces, and a wrong pair returns one generic error without attendee
  details.
- **`attendeeId`** — a random canonical ID created in Phase 1 and saved after
  a successful portal lookup. Phase 2 and Phase 3 use separate tab-level
  access markers, so entering one portal does not silently unlock the other.
- **phone number** — collected once, at the first booth check-in. On an
  attendee's own phone it is linked through their random `attendeeId`. At a
  staff kiosk, the first link is paired with the raffle number already shown
  at entry; returning phones can then be looked up directly.

Name + raffle number is a lightweight event registration lookup, not strong
authentication; both details can be shared or guessed. It solves duplicate
names and cross-device continuity for the current event prototype. Add phone
OTP or another verified credential before using it as a production security
boundary.

Both point at the same row in a Google Sheet. If staff pair a phone that was
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

The short version: each booth is its own static HTML file — its own
little "platform" — importing only `shared/api.js` and `shared/identity.js`.
That's what keeps them separable (a booth leader's page has nothing but
its own booth's code) while still writing to the same backend so nothing
gets lost as people move around.

Self-service vs. kiosk is a per-booth choice — see the `mode: "self"` /
`mode: "kiosk"` field on each entry in `web/shared/booths-config.js` — no
need to force every booth into the same interaction model.

## Phase 1 — Entry (own phone, one QR code)

Single QR code, printed once, pointing to `phase1-entry/index.html`.

1. Page loads → generates `attendeeId` if none is saved locally.
2. Name entered → `registerAttendee` → Sheet row created and a unique raffle
   number assigned server-side.
3. A Guardian Angel confirms the wristband handoff in the current prototype.
4. The page ends on a Phase 1-complete screen showing the two details needed
   later: registered name and raffle number. It does not navigate to Phase 2.

## Phase 2 — Booths (phone number becomes the shared key)

`phase2-booths/hub.html` is its own attendee portal. Even on the same phone
used at entry, the attendee explicitly finds the Phase 1 record using name +
raffle number. A completed wristband check is required. The hub then explains
that the first self-service booth will ask for a phone once, lists all booths,
and shows completed visits. It ends inside Phase 2 rather than linking directly
to Phase 3.

Direct self-service booth links preserve the intended booth while routing an
unsigned attendee through the Phase 2 lookup. Kiosk booths still tell the
attendee to see staff because staff run those experiences.

First phone-number entry anywhere calls `findOrRegisterByPhone`. A
self-service booth links it to the random attendee ID already on that phone.
A kiosk is unlocked with the organizer key and pairs a new phone with the
visitor's raffle number, preventing a second attendee/raffle record from being
created when the kiosk is their first booth. Before a new pairing is written,
staff see the entry name and raffle number and explicitly confirm the ticket.
Staff can mark someone as having skipped entry only after entering their name;
the kiosk then displays the newly assigned raffle number. Returning kiosk
phones need no raffle re-entry. The current event flow accepts exactly ten
phone digits: inputs format them as `(555) 555-5555`, while the backends and
stored rows keep the canonical digits-only value (`5555555555`).

Phone knowledge alone is not treated as identity proof. If a self-service
device enters a phone already attached to another record, it receives a
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
sign-ups, or phone numbers. All pages temporarily share the organizer key, so
this is data/UI separation rather than per-booth authorization; dedicated
booth keys can be introduced when the final controls are defined.

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
2. **Phase 2 attendee link** — opens the independent Gym login/hub.
3. **Booth QRs** — one per self-service booth; a logged-out visitor is sent
   through the Phase 2 lookup and returned to that booth.
4. **Phase 3 attendee link** — opens the independent final signup login.
5. Kiosk booths need no attendee-facing QR — staff use their booth staff page
   and live kiosk.

Full instructions for generating and printing these are in `qr/QR_PLAN.md`.
For local testing, QR codes are optional: open the printed localhost URLs
directly and exercise the entire flow without visiting the QR page. The QR
generator itself remains deployment-time work for when a public URL exists.

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
