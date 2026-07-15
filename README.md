# The Perfect Summer Day — Event App

A multi-device event companion app, built for a one-day event with three
stages:

1. **Phase 1 — Entry.** Attendee scans a QR code at the door, types their
   name, gets a raffle number, and a staff member ("Guardian Angel")
   confirms they physically received a wristband before letting them into
   the gym.
2. **Phase 2 — Booths.** Attendees visit connector booths around the gym.
   Each of the five booths has its own attendee link and its own login, so
   opening one booth never drops someone into a shared Phase 2 hub or unlocks
   the other four. Every booth also has a separate, booth-scoped staff
   dashboard. Art Therapy and New Song retain optional staff-held kiosk pages
   as a fallback.
3. **Phase 3 — Sign-up.** Before leaving, attendees pick what they're
   interested in next (future events, Bible study, a course, etc.). Staff
   later confirm in person which of those sign-ups actually happened.

This README is the starting point. If you just want to see it running,
skip to **Quick start** below. Everything else in this repo is documented
in its own `.md` file — see **Where to go next** at the bottom of this
file for a map.

---

## Prerequisites

You only need one thing installed: **Node.js** (version 16 or newer — 18
or 20 is fine too). Nothing else. No database, no Google account, no
`npm install` step, no paid services, to run the demo.

**Check if you already have it:** open a terminal and run:

```
node --version
```

- If that prints something like `v18.19.0`, you're set — skip to Quick
  start.
- If it says "command not found," install Node.js from
  [nodejs.org](https://nodejs.org) (pick the "LTS" button — it's a normal
  installer, like installing any other app), then re-run `node --version`
  to confirm.

You'll also want `git` if you're cloning this from GitHub rather than
receiving the folder directly — it comes pre-installed on macOS, and on
Windows you'd install [Git for Windows](https://git-scm.com/downloads).

**A "terminal," if that phrase is new:** on macOS it's the app called
"Terminal" (search for it with Spotlight/Cmd+Space); on Windows it's
"Command Prompt" or "PowerShell." Every command below is typed into that
window, one line at a time, followed by Enter.

---

## Quick start

Copy and paste these commands into a terminal:

```bash
git clone https://github.com/autowiki4/event-app.git
cd event-app/demo-server
node server.js
```

(If you were handed this folder directly instead of a GitHub link, skip
the `git clone` line and just open a terminal *inside* the `demo-server`
folder, then run `node server.js`.)

You'll see:

```
Event app demo server running: http://localhost:3000
  Phase 1 entry:        http://localhost:3000/phase1-entry/index.html
  Phase 2 booth rooms:
    Heaven:             http://localhost:3000/phase2-booths/booth-heaven.html
    Bible Bowl:         http://localhost:3000/phase2-booths/booth-trivia.html
    The Sower:          http://localhost:3000/phase2-booths/booth-story.html
    Art Therapy:        http://localhost:3000/phase2-booths/booth-art.html
    New Song:           http://localhost:3000/phase2-booths/booth-newsong.html
  Phase 3 attendee:     http://localhost:3000/phase3-signup/index.html
  Phase 2 staff hub:    http://localhost:3000/phase2-staff/index.html
  Organizer dashboard:  http://localhost:3000/organizer/dashboard.html
  QR codes (optional):  http://localhost:3000/organizer/qr-codes.html
  Local testing:        open each booth room directly; no QR scan required
  Local organizer key:  demo
```

Open any of those links in your browser — that's the whole app running
locally on your machine, with a local, throwaway copy of the "database"
(no attendee's real data, nothing shared with anyone else).

For ordinary local testing, open Phase 1, any of the five Phase 2 booth-room
URLs, and Phase 3 directly; ignore QR codes entirely. Phase 1 registers a
person and ends by telling them they can close the link. At the event, they
open the link for the booth where they are standing and enter their Phase 1
name and raffle number. They repeat that login at each booth. Phase 3 keeps its
existing separate login. Deployment QR work is intentionally deferred until
the site has a real public URL to encode.

**To stop the server:** click back into that terminal window and press
`Ctrl+C`.

**To run the zero-dependency regression suite:** from `demo-server/`, run
`npm test`. It covers independent booth-room and Phase 3 login lookup,
identity pairing/merging, duplicate booth-completion protection, scoped booth
staff data, organizer authorization, API error propagation, and the protected
dashboard mutations.

**To reset the demo data** (start over with zero attendees): either click
"Reset demo data" at the bottom of the organizer dashboard, or run:

```
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

Want a guided, step-by-step walkthrough of every part of the app, written
as a script you can read aloud while presenting it to other people? See
**`DEMO_GUIDE.md`**.

---

## What each part of the project is

```
event-app/
├── README.md              you are here — setup + orientation
├── ARCHITECTURE.md         why the app is built this way (identity model, data flow)
├── DEMO_GUIDE.md           step-by-step script for presenting a live demo to a room
├── event-app.html          the ORIGINAL single-file sketch — kept for reference only, don't edit this
│
├── web/                    every page a person actually opens in a browser
│   ├── shared/              code shared by every page (see below)
│   ├── phase1-entry/        Phase 1: name → wristband confirmation → raffle ticket
│   ├── phase2-booths/       five independent attendee booth rooms + optional kiosks
│   ├── phase2-staff/        Phase 2 staff hub + one scoped page per booth
│   ├── phase3-signup/       Phase 3 attendee login + "what's next" choices
│   ├── done/                 final recap screen + "stay connected" email capture
│   └── organizer/            live dashboard + printable QR codes (staff-only pages)
│
├── demo-server/            local backend for demos/rehearsal (no Google account needed)
│   ├── server.js             the actual server — see demo-server/README.md
│   ├── package.json
│   └── db.json               local "database" file, created automatically, safe to delete
│
├── apps-script/            production backend — deploy this for the real event
│   ├── Code.gs               the backend code itself
│   ├── README.md              step-by-step deployment instructions
│   └── SHEET_SCHEMA.md        exact spreadsheet column layout it creates
│
└── qr/
    └── QR_PLAN.md            how the printable QR codes work
```

### `web/` — the pages people open

Every page in here is a plain, standalone HTML file — no build step, no
compiling, nothing to install. Open any of them directly in a browser (via
the demo server, or later via a real web host) and they work.

- **`web/shared/`** — not a page itself, but code every page reuses:
  `styles.css` (the look of the app), `api.js` (how every page talks to
  the backend), `identity.js` and `attendee-portal.js` (phase-specific
  attendee sign-in), `booths-config.js` (the list of booths, trivia
  questions, sign-up options — edit this file to change any of that
  content), `booth-room.js` (the independent login shell used by all five
  attendee rooms), `booth-common.js` (shared attendee-booth behavior),
  `booth-staff-common.js` (scoped booth-staff data), `organizer-auth.js`
  (page-memory-only staff access), and `toast.js` (confirmation messages).

- **`web/phase1-entry/index.html`** — what the entry QR code points to.
  Name entry → raffle ticket → wristband confirmation → a Phase 1-complete
  screen that thanks the attendee, tells them they can close the link, and
  reminds them to use the same name and raffle number when they reach a booth.
  It no longer sends attendees directly into Phase 2.

- **`web/phase2-booths/`** — five independent attendee rooms:
  - `booth-heaven.html` ("Can You Draw Heaven?"), `booth-trivia.html`
    ("Bible Bowl"), `booth-story.html` ("The Sower, Live"),
    `booth-art.html` ("Art Therapy Table"), and `booth-newsong.html`
    ("The New Song in Nashville").
  - On first arrival, every room opens with blank name and raffle-number
    fields, validates the Phase 1 registration, welcomes the attendee to that
    booth only, and keeps its own tab-level access marker. Signing in at
    Heaven, for example, does not unlock Bible Bowl. The first booth also
    collects a 10-digit phone number; the same attendee record is reused as
    they move between rooms.
  - `kiosk-art.html` and `kiosk-newsong.html` remain available as optional
    staff-operated fallback tools. Staff unlock them with the organizer key,
    verify a first-time visitor's name and raffle number, and can explicitly
    create a visitor who truly skipped entry. They are not the primary
    attendee links.
  - `hub.html` is now only a compatibility notice explaining that Phase 2 has
    no shared attendee portal. It does not provide a login or a booth list.

- **`web/phase2-staff/`** — the independent Phase 2 staff side:
  - **`index.html`** — staff booth directory.
  - **`heaven.html`, `trivia.html`, `story.html`, `art.html`, and
    `newsong.html`** — five distinct organizer URLs. Each calls a
    server-filtered endpoint that returns only that booth's count and recent
    check-ins. Each includes a booth-only settings area ready for the controls
    that will be defined later. Art and New Song also link to their optional
    staff kiosks. The pages currently share one organizer key, so this is
    server-enforced data scoping and UI separation rather than five separate
    staff credentials.

- **`web/phase3-signup/index.html`** — the independent Phase 3 attendee
  link. It finds the Phase 1 registration by name + raffle number, then shows
  future events, Bible study, the 8-month course, art therapy, and referring
  a friend. Phase 2 participation is not required.

- **`web/done/index.html`** — recap screen shown after Phase 3: raffle
  number, booths completed, choices made, and an email capture if they
  haven't given one already.

- **`web/organizer/`** — for staff, not attendees:
  - **`dashboard.html`** — live-updating view of registrations, wristband
    confirmations, booth check-in counts, the Bible Bowl leaderboard, song
    votes, and Phase 3 sign-up rosters grouped by option for in-person
    confirmation. Phone numbers are shown in `(555) 555-5555` format. It
    stays locked until staff enter the runtime organizer key.
  - **`qr-codes.html`** — generates and prints the QR codes for the door
    and the three original self-service booths. It remains unchanged for now;
    the deployment-time QR update for all five booth-room links is deferred
    until a real public URL exists.

### `demo-server/` vs `apps-script/` — two interchangeable backends

Both implement the *exact same* set of actions (register or sign in an
attendee, confirm a wristband, look up someone by phone, log a booth
check-in, return booth-scoped staff data, etc.) — the pages in `web/` don't
know or care which one they're talking
to. That's on purpose: build and rehearse everything against
`demo-server/` (fast, free, no Google account), then switch to
`apps-script/` for the actual event by changing one line in
`web/shared/config.js`. See `demo-server/README.md` and
`apps-script/README.md` for how to run each one.

---

## Troubleshooting

- **"node: command not found"** — Node.js isn't installed yet; see
  Prerequisites above.
- **"Error: listen EADDRINUSE ... :3000"** — something else is already
  using port 3000 (maybe a previous copy of this server still running).
  Either stop that process, or run this one on a different port:
  `PORT=3001 node server.js`, then use `localhost:3001` in the URLs
  instead.
- **A page loads but looks unstyled / broken fonts** — the page couldn't
  reach Google Fonts (needs internet the first time it loads, after that
  your browser usually caches it). The app still works, it just won't
  look as polished.
- **Booth pages keep asking for a phone number again** — that's expected
  behavior if you're using a private/incognito window (which doesn't
  keep `localStorage` between sessions) or if you cleared your browser
  data. It's also expected on kiosk pages — those intentionally ask every
  time, since a new visitor is standing there each time.
- **Dashboard shows nothing / stays at zero** — make sure you're looking
  at the dashboard from the *same* server you registered attendees on
  (e.g. both on `localhost:3000`, not one on `3000` and one on `3001`) and
  that you unlocked it with the local key `demo`.
- **A kiosk asks for a raffle number** — this is how staff securely attach
  a first-time kiosk phone number to the attendee record created at entry.
  Verify the name and number in the confirmation against their ticket.
  Returning phones can leave it blank. Only mark "skipped entry" when the
  visitor really has no entry raffle number, then give them the new number
  displayed by the kiosk.

---

## Going from demo to the real event

1. Deploy the production backend — follow `apps-script/README.md`
   end-to-end (create a Google Sheet, set a strong organizer key in Script
   Properties, paste in `Code.gs`, deploy as a Web App, and copy its URL).
2. Host the `web/` folder somewhere public — any static host works
   (Netlify, GitHub Pages, Vercel), since every page is plain HTML/CSS/JS
   with no build step.
3. In `web/shared/config.js`, set `API_BASE_URL` to the Apps Script
   `/exec` URL from step 1.
4. Once the final public routes are deployed, finish the deferred QR setup and
   print codes pointed at that real public URL (not `localhost`) — see
   `qr/QR_PLAN.md`. The current generator has intentionally not yet been
   expanded to all five booth rooms.
5. Do a full run-through with a couple of real phones and one kiosk
   device before the actual day — `DEMO_GUIDE.md` doubles as a rehearsal
   script for this.

---

## Where to go next

| Doc | What's in it |
|---|---|
| `ARCHITECTURE.md` | Why the app is designed this way — the shared-identity model that lets different devices (an attendee's phone, a staff kiosk) stay in sync, and the reasoning behind self-service vs. kiosk booths. |
| `DEMO_GUIDE.md` | A word-for-word script for presenting this live to a room — what to click, what to say, in order, plus a Q&A section. |
| `demo-server/README.md` | Everything about the local backend used for demos. |
| `apps-script/README.md` | Step-by-step deployment of the real, production backend. |
| `apps-script/SHEET_SCHEMA.md` | The exact spreadsheet columns the production backend creates and uses. |
| `qr/QR_PLAN.md` | How the printable QR codes work and which ones you need. |
