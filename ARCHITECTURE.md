# Event App — Architecture Plan

Based on `event-app.html`, split into a real multi-page, multi-device app. Backend: Google Sheets + Apps Script. Booths: mix of self-service (attendee's own phone) and staff-run kiosks. Organizer: live dashboard.

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

**RaffleCounter** — a single running number, so Apps Script (not the browser) hands out raffle numbers — avoids two people getting the same number.

This Sheet *is* "the file with everyone's name and number" you asked for — Attendees tab, filterable/exportable to CSV anytime, no separate export step needed. A `File > Download > CSV` or a small `exportCSV()` Apps Script function covers a one-click end-of-day export.

Apps Script exposes actions like `registerAttendee`, `confirmWristband`, `findOrRegisterByPhone`, `boothCheckin`, `submitSignup`, `confirmSignupInPerson`, `dashboardData` — each just a `doPost`/`doGet` case reading/writing the Sheet. No server to host, no database to manage, free.

## Repo structure

```
event-app/
  README.md
  apps-script/
    Code.gs              # all backend actions, doGet/doPost
    SHEET_SCHEMA.md       # column layout per tab, kept in sync with Code.gs
  web/
    shared/
      api.js              # fetch() wrapper -> Apps Script Web App URL
      identity.js          # get/set attendeeId + cached phone in localStorage
      styles.css           # design system pulled out of the current <style> block
      toast.js
    phase1-entry/
      index.html           # QR lands here: name -> wristband confirm -> raffle ticket -> "enter gym"
    phase2-booths/
      hub.html              # "The Gym" — booth list, for attendees on their own phone
      booth-heaven.html     # self-service booth (own QR)
      booth-trivia.html     # self-service booth (own QR)
      booth-story.html      # self-service booth (own QR)
      kiosk-art.html        # staff-run kiosk: phone number in, prompt shown, done
      kiosk-newsong.html    # staff-run kiosk: phone number in, vote logged, done
    phase3-signup/
      index.html            # attendee picks interests (own phone or a kiosk at the sign-up table)
    done/
      index.html            # recap + "stay connected" email capture
    organizer/
      dashboard.html         # live counts per booth, raffle tally, sign-up list with "confirm in person" button
  qr/
    QR_PLAN.md              # which URL each printed QR code should point to
```

Each booth is its own static HTML file — its own little "platform" — importing only `shared/api.js` and `shared/identity.js`. That's what keeps them separable (a booth leader's page has nothing but its own booth's code) while still writing to the same Sheet so nothing gets lost as people move around.

Self-service vs. kiosk is a per-booth choice, matching the `appReliance: "light"/"full"` split already sketched in the prototype — no need to force every booth into the same interaction model.

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

Polls `dashboardData` every few seconds. Shows: total registered / wristbands confirmed, live count per booth, raffle entries so far (with a "draw winner" button that just picks a random existing raffle number), Bible Bowl leaderboard, song vote tally, and the Phase 3 sign-up confirm queue described above. No login system needed if it's only ever opened on staff's own devices — worth revisiting if that's not a safe assumption for your event.

## QR codes needed

1. **Entry QR** (Phase 1) — one, printed at the door.
2. **Booth QRs** — one per self-service booth, printed at that booth's table.
3. Kiosk booths need no attendee-facing QR — staff open `kiosk-*.html` once on their own device for the day.

## Build order (once this plan is approved)

1. Apps Script backend (`Code.gs`) + Sheet tabs.
2. `shared/api.js` + `shared/identity.js` + extracted `styles.css`.
3. Phase 1 page.
4. Booth hub + 5 booth pages (split self-service vs. kiosk per your call on each booth).
5. Phase 3 sign-up page + done/recap page.
6. Organizer dashboard.
7. QR code generation + a short run-of-show test across two real phones and one kiosk device.
