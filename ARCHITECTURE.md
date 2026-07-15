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

People move between devices during the event:
- Phase 1 happens on the attendee's own phone (QR scan).
- Phase 2 happens either on their own phone (booth's own QR) *or* on a staff tablet (kiosk booths), where the attendee never opens the app themselves.
- Phase 3 can happen on either.

So there needs to be one durable identity that works regardless of which device the attendee is on. Two keys, one record:

- **`attendeeId`** — a random ID generated in the browser at Phase 1, saved to that phone's `localStorage`. Lets an attendee's *own* phone stay logged in across booths without re-entering anything.
- **phone number** — collected once, at the first booth check-in. This is the key staff kiosks use to find the attendee's record, since a kiosk has no `localStorage` memory of who's standing in front of it.

Both point at the same row in a Google Sheet. Whichever device is asking, the backend can always resolve "who is this."

## Data store: Google Sheet ("EventDB")

One spreadsheet, one Apps Script Web App in front of it acting as a tiny JSON API. Tabs:

**Attendees** — attendeeId, name, phone, raffleNumber, wristbandConfirmedAt, registeredAt

**BoothCheckins** — attendeeId, phone, boothId, boothName, checkedInBy (self / staff name), checkedInAt, rating, note, extraData (JSON string — trivia score, story answers, art prompt shown, song voted for, etc.)

**SignUps** — attendeeId, phone, optionId, optionTitle, email, stars, comment, submittedAt, confirmedInPerson (bool), confirmedBy, confirmedAt

**Meta** — a small key/value tab; currently holds just one row, `raffleCounter`, the last raffle number handed out. Apps Script increments this under a lock before handing out each new number, so two people registering at the exact same instant can never collide.

This Sheet *is* "the file with everyone's name and number" you asked for — Attendees tab, filterable/exportable to CSV anytime, no separate export step needed. `File > Download > CSV` in Google Sheets covers a one-click end-of-day export. Exact column layout for every tab is in `apps-script/SHEET_SCHEMA.md`.

Apps Script exposes actions like `registerAttendee`, `confirmWristband`, `findOrRegisterByPhone`, `boothCheckin`, `submitSignup`, `confirmSignupInPerson`, `dashboardData` — each just a `doPost`/`doGet` case reading/writing the Sheet. No server to host, no database to manage, free.

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

1. Page loads → generates `attendeeId` if none saved locally.
2. Name entered → `registerAttendee` → Sheet row created, raffle number assigned server-side.
3. Wristband step: two options worth deciding between —
   - *Self-attest* (matches the current prototype): attendee checks "I have my wristband." Simple, but nothing stops someone skipping the physical step.
   - *Staff-confirmed* (more reliable): the attendee's ticket screen shows a small QR/code; the guardian angel scans or taps it on their own device to confirm, only then unlocking "Enter the Gym." Slightly more setup, closes the loophole.
4. "Enter the Gym" → done with Phase 1.

## Phase 2 — Booths (phone number becomes the shared key)

`hub.html` lists all booths for attendees on their own phone. Self-service booths link straight to that booth's page (identity already cached locally). Kiosk booths just tell the attendee "see staff at this table" — no link needed, since staff run it.

First phone-number entry anywhere (self-service booth *or* kiosk) calls `findOrRegisterByPhone`: looks up the number, links it to the existing `attendeeId`/raffle number if found, or creates one if this is the attendee's very first touchpoint of the day (e.g., they skipped Phase 1 and walked straight to a booth). Every later booth reuses that phone number — nobody re-types it.

Each booth check-in writes its own `BoothCheckins` row with whatever that booth's `extraData` is (trivia score, story answers, chosen art prompt, song vote) — same shape as the prototype's per-booth state, just persisted server-side instead of in-page JS state.

## Phase 3 — Sign-up (app UI + in-person confirmation)

Attendee-facing UI stays close to the current sketch: cards for each option (future events, Bible study, 8-month course, art therapy, refer a friend), expanding relevant fields per selection. Submitting writes `SignUps` rows with `confirmedInPerson: false`.

Organizer-facing piece: the dashboard lists pending sign-ups (name, phone, option chosen) with a one-tap "Confirm in person" button for whichever staff member is standing with that attendee at the actual table — sets `confirmedInPerson: true, confirmedBy, confirmedAt`. This gives you a clean before/after: "said they're interested" vs. "we actually talked to them and signed them up."

## Organizer dashboard (`organizer/dashboard.html`)

Polls `dashboardData` every 4 seconds. Shows: total registered / wristbands
confirmed / raffle entries, live count per booth, the Bible Bowl
leaderboard, song vote tally, and the Phase 3 sign-up confirm queue
described above, plus a "Reset demo data" button (rehearsal use only — see
`demo-server/README.md`). No login system needed if it's only ever opened
on staff's own devices — worth revisiting if that's not a safe assumption
for your event. Drawing the actual raffle winner isn't automated — pick a
number from the Attendees list/dashboard count and call it out live, or add
a "pick random entry" button yourself if you want that automated.

## QR codes needed

1. **Entry QR** (Phase 1) — one, printed at the door.
2. **Booth QRs** — one per self-service booth, printed at that booth's table.
3. Kiosk booths need no attendee-facing QR — staff open `kiosk-*.html` once on their own device for the day.

Full instructions for generating and printing these are in `qr/QR_PLAN.md`.

## Two interchangeable backends

Every action described above (`registerAttendee`, `confirmWristband`,
`findOrRegisterByPhone`, `boothCheckin`, `submitSignup`,
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
