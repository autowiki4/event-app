# Demo Guide — presenting the event app live

Goal: show an audience the whole journey — Phase 1 entry, Phase 2 booths
(both self-service and staff kiosk), Phase 3 sign-up, and the organizer
dashboard tying it all together in real time — using nothing but a laptop
and the local demo server (no Google account, no deployment, no internet
required except to load Google Fonts and the QR library).

## 1. Before the room fills up

```
cd demo-server
node server.js
```

Leave this terminal window open and visible if you want — the console
prints every URL you need. If you rehearsed earlier and want a clean slate,
reset first:

```
curl -X POST http://localhost:3000/api/resetDemo
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
| A | `http://localhost:3000/phase1-entry/index.html` | The attendee's own phone |
| B | `http://localhost:3000/phase2-booths/kiosk-art.html` | A staff-run kiosk device |
| C | `http://localhost:3000/organizer/dashboard.html` | The organizer's live view |

Use a **private/incognito window** for Window A specifically — regular
windows share `localStorage`, and incognito guarantees Window A behaves
like a genuinely new attendee's phone every time you restart the demo,
instead of remembering the last person you registered.

Arrange them so the audience can see at least Window A and Window C at
the same time (that's where the "different devices, same person" moment
lands hardest). Window B can be a second laptop/tablet if you have one, to
really sell the "staff device" idea — but a third browser window works
fine too.

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
4. Check "I've handed over the wristband" and click **Enter the Gym**.
   *"In a real event, this checkbox is really your Guardian Angel
   confirming they physically handed over a wristband — not something the
   attendee can just tick themselves. That's a decision made for the demo;
   flag it if you want it tightened up for the real thing."*

**Phase 2 — self-service booth (Window A, still)**

5. From the booth hub, open a self-service booth (Bible Bowl is the most
   fun to demo — it's scored).
6. It asks for a phone number — *"first booth, first time, this is the
   only time today they'll type this in."* Enter any 10-digit number.
7. Play a question or two, click **Done**.
8. Go back to the hub — point out the booth now shows "Completed ✓".

**Phase 2 — staff kiosk booth (Window B)**

9. Switch to Window B (Art Therapy kiosk). *"This is a tablet sitting at
   the art table all day — nobody's phone touches this, staff run it."*
10. Type the **same phone number** you used in Window A.
11. *"Watch — it already knows this is Jordan."* — the visitor's name
    appears, pulled from the record Window A created a minute ago.
12. Show a prompt, click **Done — next visitor**.

**Organizer dashboard (Window C)**

13. Switch to Window C. It's already been polling — point out the Bible
    Bowl leaderboard has Jordan's score, and the booth check-in table shows
    one visit each to Bible Bowl and Art Therapy. *"Same person, two
    completely different devices, one shared record — nothing gets lost
    as people move around the room."*

**Phase 3 — sign-up (Window A)**

14. Back in Window A, click **Wrap up & head out**.
15. Pick a couple of options (e.g. "Keep me posted" needs an email —
    good excuse to show that field), submit.
16. Show the recap screen and raffle number one more time.

**Organizer dashboard again (Window C)**

17. Refresh (or just wait ~4s, it polls automatically) — the new sign-up
    appears in the "confirm in person" table as **Pending**.
18. Click **Confirm** — *"This is the actual moment a staff member at the
    sign-up table talks to this person face to face. Until someone taps
    this, it's just an intention, not a commitment."*

**QR codes (optional, if time allows)**

19. Open `organizer/qr-codes.html` — show the live-generated codes for the
    door and each self-service booth, and mention printing them before the
    real event.

## 3. Questions to be ready for

- **"What happens if wifi drops?"** — Nothing in this design works
  offline right now; every action is a live network call. Worth deciding
  if that's acceptable for your venue before the real event, or whether
  some booths need an offline fallback.
- **"What if someone doesn't have a smartphone?"** — Any booth can be
  handled by staff on the kiosk pattern already used for Art Therapy /
  New Song — a staff member can walk someone through Phase 1 and 2 on
  their own device too, using the person's phone number as the ID either
  way.
- **"Can two people be at the same booth on Window A and Window B at
  once?"** — Yes — every booth page (self-service or kiosk) just calls
  the same backend independently per visit; there's no per-booth
  bottleneck.
- **"Where does the final list of names and numbers live?"** — In the demo,
  `demo-server/db.json`. In production, the `Attendees` tab of the Google
  Sheet — see `apps-script/SHEET_SCHEMA.md` for the exact columns, and it's
  a one-click CSV export any time from Sheets itself.

## 4. If you want to demo on real phones instead of browser windows

1. Find your laptop's local IP (e.g. `ipconfig getifaddr en0` on a Mac).
2. Make sure phones are on the **same wifi** as the laptop.
3. Use `http://<that-ip>:3000/...` instead of `localhost` on the phones.
4. Regenerate QR codes from `organizer/qr-codes.html` with that IP as the
   base URL so they're actually scannable.

This is closer to how the real event will feel, but takes a bit more setup
— the incognito-windows version above is faster to rehearse and just as
convincing for showing the concept to a room.
