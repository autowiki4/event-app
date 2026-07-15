# Demo Guide — presenting the event app live

Goal: show an audience the whole journey—Phase 1 entry, two of the five
independent Phase 2 booth rooms, an optional staff kiosk fallback, Phase 3
sign-up, and the organizer views tying it all together in real time—using
nothing but a laptop and the local demo server (no Google account, no
deployment, no internet required except to load Google Fonts). QR generation
is optional and can be skipped completely during local testing.

If you haven't run anything in this repo before, read this section first;
if you've already got the demo server running, skip to **1. Before the
room fills up**.

## 0. First time only: get it running

You need **Node.js** installed (nothing else — no database, no account,
no `npm install`). Check with:

```
node --version
```

If that fails, install it from [nodejs.org](https://nodejs.org) (the
"LTS" button) and try again. Full details, including what to do if you
were handed this folder instead of a GitHub link, are in the main
`README.md` — but the short version, once Node is installed, is:

```
cd demo-server
node server.js
```

Leave that running for the rest of this guide. If it prints an error about
port 3000 already being in use, see the Troubleshooting section in
`README.md`.

## 1. Before the room fills up

Same command as above, if you haven't already started it:

```
cd demo-server
node server.js
```

Leave this terminal window open and visible if you want — the console
prints every URL you need. If you rehearsed earlier and want a clean slate,
reset first:

```
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

(or click "Reset demo data" at the bottom of the organizer dashboard once
it's open).

### Set up your windows

The whole point of this demo is showing that different devices share one
identity. Open three separate browser windows side by side (or across two
screens/laptops on the same wifi) so the audience can watch data move
between them live:

| Window | URL | Represents |
|---|---|---|
| A | `http://localhost:3000/phase1-entry/index.html` | The attendee, opening Phase 1 and individual booth-room links |
| B (optional) | `http://localhost:3000/phase2-booths/kiosk-art.html` | The retained staff-run kiosk fallback |
| C | `http://localhost:3000/organizer/dashboard.html` | The organizer's live view |
| D (optional) | `http://localhost:3000/phase2-staff/index.html` | The booth-specific staff directory |

Use a **private/incognito window** for Window A specifically — regular
windows share `localStorage`, and incognito guarantees Window A behaves
like a genuinely new attendee's phone every time you restart the demo,
instead of remembering the last person you registered.

Arrange them so the audience can see at least Window A and Window C at
the same time (that's where the "different devices, same person" moment
lands hardest). Window B can be a second laptop/tablet if you have one, to
really sell the "staff device" idea — but a third browser window works
fine too.

When Windows B and C show the staff-access gate, enter the local organizer key
printed by the server: **`demo`**. Window D's directory and the individual
booth dashboard it opens each ask for the key as well. It stays only in that
page's memory, so reloads and other staff pages ask for it again.

## 2. The walkthrough script

Talk through it in this order — each step is something to click plus a
line or two of what to say.

**Phase 1 — entry (Window A)**

1. Open `phase1-entry/index.html`. *"This is what's printed at the door —
   one QR code, and it only ever does one thing: register you and get you
   a wristband."*
2. Type a name (e.g. "Jordan"), click through.
3. Point out the raffle ticket and number that appears. *"That number's
   assigned by the backend, not the phone — so two people scanning at the
   exact same second can never collide."*
4. Check "I've handed over the wristband" and click **Complete Phase 1**.
   *"In a real event, this checkbox is really your Guardian Angel
   confirming they physically handed over a wristband — not something the
   attendee can just tick themselves. That's a decision made for the demo;
   flag it if you want it tightened up for the real thing."* Point out the
   thank-you message: Phase 1 ends here, tells Jordan the link can be closed,
   and preserves the name + raffle details for the booth-room logins.

**Phase 2 — first booth room (Window A)**

5. Close the Phase 1 page, then open the exact Bible Bowl room URL:
   `phase2-booths/booth-trivia.html`. Point out that both login fields start
   blank. Enter the same name and raffle number. *"Names can repeat, so both
   details reopen the correct Phase 1 registration—even on another device."*
6. Point out the booth-specific copy: *"It welcomes Jordan to Bible Bowl and
   Bible Bowl only. This is the link posted at this physical booth; there is no
   shared Phase 2 portal to wander through."*
7. The first booth asks for a phone number. *"This booth login repeats at each
   room, but the 10-digit phone check-in is remembered for this attendee on
   this device."* Enter any 10-digit number.
8. Play a question or two, then click **Finish this booth**. Point out the
   message telling Jordan to close this link and log in again when they reach
   another booth.

**Phase 2 — a second, separately locked booth room (Window A)**

9. Open `phase2-booths/booth-heaven.html`. The name and raffle fields are
   blank again even though Bible Bowl was just completed. *"A Bible Bowl login
   never unlocks the Heaven room—or any of the other three rooms."*
10. Enter the same Phase 1 name and raffle number. Point out the new welcome
    names only **Can You Draw Heaven?**. The already linked phone is reused, so
    the booth activity opens without collecting the number again. The same
    pattern applies to:

    - `phase2-booths/booth-story.html`
    - `phase2-booths/booth-art.html`
    - `phase2-booths/booth-newsong.html`

**Phase 2 — optional staff kiosk fallback (Window B)**

11. Switch to Window B (Art Therapy kiosk). *"Art Therapy has its own attendee
    room now, just like the other four. This older kiosk is still available as
    an optional staff-operated fallback when a visitor needs help."*
12. Type the **same phone number** you used in Window A. Because that phone
    was already linked at the self-service booth, leave raffle number blank.
    If the kiosk had been the first booth, staff would also enter the raffle
    number shown in Window A; that securely attaches the phone without
    creating a second attendee or raffle entry.
13. *"Watch—it already knows this is Jordan."* The visitor's name
    appears, pulled from the record Window A created a minute ago.
14. Show a prompt, click **Done—next visitor**.

**Phase 2 — booth staff portal (Window D, optional)**

15. Unlock `phase2-staff/index.html`, choose Bible Bowl, and unlock that booth
    page. *"Each of the five booths has its own organizer URL and receives
    only its own activity—not the overall attendee list, another booth's
    activity, or Phase 3 data."* Point out the count, recent roster, direct
    attendee-room link, and the neutral settings area where only Bible Bowl's
    future controls will go. Art Therapy and New Song staff pages also expose
    their optional kiosk links.

**Organizer dashboard (Window C)**

16. Switch to Window C. It has already been polling—point out that the overall
    organizer still sees the event-wide booth counts, the Bible Bowl
    leaderboard, and the optional Art Therapy kiosk visit. *"The booth staff
    page is deliberately narrow; this overall portal remains the complete
    event view."*

**Phase 3 — sign-up (Window A)**

17. Back in Window A, open the separate URL
    `phase3-signup/index.html`. Sign in again with the Phase 1 name + raffle
    number. *"Phase 3 does not require a booth visit or phone number."*
18. Pick a couple of options (e.g. "Keep me posted" needs an email—
    good excuse to show that field), submit.
19. Show the recap screen and raffle number one more time.

**Organizer dashboard again (Window C)**

20. Refresh (or just wait ~4s, it polls automatically)—the new sign-ups
    appear under their option rosters as **Pending**.
21. Click **Confirm**—*"This is the actual moment a staff member at the
    sign-up table talks to this person face to face. Until someone taps
    this, it's just an intention, not a commitment."*

**QR codes (optional — skip for normal local testing)**

22. The current `organizer/qr-codes.html` page is intentionally unchanged and
    still generates the entry code plus the three original self-service booth
    codes. The final QR decision for all five booth-room links is deferred
    until the app has a deployed public URL. Nothing else in this walkthrough
    depends on that page, so skip it during normal local testing.

## 3. Questions to be ready for

- **"What happens if wifi drops?"** — Nothing in this design works
  offline right now; every action is a live network call. Worth deciding
  if that's acceptable for your venue before the real event, or whether
  some booths need an offline fallback.
- **"What if someone doesn't have a smartphone?"** — A staff member can walk
  someone through an attendee room on a staff device. Art Therapy and New Song
  also retain their dedicated kiosk fallback, where staff verify the raffle
  ticket or explicitly mark that a visitor skipped entry and provide the new
  raffle number.
- **"Can two people be in the same booth room at once?"** — Yes. Every browser
  calls the same backend independently per visit; there is no one-device or
  one-attendee bottleneck in an attendee room.
- **"Where does the final list of names and numbers live?"** — In the demo,
  `demo-server/db.json`. In production, the `Attendees` tab of the Google
  Sheet — see `apps-script/SHEET_SCHEMA.md` for the exact columns, and it's
  a one-click CSV export any time from Sheets itself.

## 4. If you want to demo on real phones instead of browser windows

1. Find your laptop's local IP (e.g. `ipconfig getifaddr en0` on a Mac).
2. Make sure phones are on the **same wifi** as the laptop.
3. Use `http://<that-ip>:3000/...` instead of `localhost` on the phones.
4. Type or bookmark the direct booth-room URLs on each device. The QR generator
   has intentionally not been expanded to all five rooms yet; finish that work
   only after the final public deployment URL and QR plan are decided.

This is closer to how the real event will feel, but takes a bit more setup
— the incognito-windows version above is faster to rehearse and just as
convincing for showing the concept to a room.
