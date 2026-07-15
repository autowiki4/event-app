# The Perfect Summer Day — Event App

Multi-device event companion app: attendees register and get a wristband
(Phase 1), check into connector booths around the gym (Phase 2), and sign
up for what's next before they leave (Phase 3). See `ARCHITECTURE.md` for
the full design, `DEMO_GUIDE.md` for how to run a live walkthrough of it.

`event-app.html` (repo root) is the original single-file sketch this was
built from — kept for reference, no longer the thing to run or edit.

## Run the demo

```
cd demo-server
node server.js
```

Then open:
- `http://localhost:3000/phase1-entry/index.html` — attendee entry point (Phase 1 QR target)
- `http://localhost:3000/phase2-booths/hub.html` — booth hub (normally reached by finishing Phase 1)
- `http://localhost:3000/organizer/dashboard.html` — live organizer view
- `http://localhost:3000/organizer/qr-codes.html` — printable QR codes for the door + self-service booths

No `npm install` needed — the demo server has zero dependencies.

## Repo layout

```
web/                  every page attendees/staff/organizers open
  shared/             CSS, API client, identity handling, booth data — shared by every page
  phase1-entry/        Phase 1: name → wristband confirm → raffle ticket
  phase2-booths/       Phase 2: booth hub + 3 self-service booths + 2 staff kiosks
  phase3-signup/        Phase 3: interest sign-up
  done/                recap + stay-connected
  organizer/            live dashboard + QR code printing
demo-server/           local backend for demos/rehearsal — no Google account needed
apps-script/           production backend — deploy to Google Sheets + Apps Script for the real event
qr/                    notes on generating/printing QR codes
ARCHITECTURE.md         full design writeup
DEMO_GUIDE.md           script for presenting this live to others
```

## Going from demo to the real event

1. Follow the setup steps at the top of `apps-script/Code.gs` to deploy the
   production backend against a real Google Sheet.
2. Host the `web/` folder somewhere public (Netlify, GitHub Pages, Vercel —
   any static host works, since every page is plain HTML/CSS/JS).
3. In `web/shared/config.js`, set `API_BASE_URL` to your Apps Script `/exec`
   URL.
4. Print QR codes from `organizer/qr-codes.html` pointed at your real,
   public URL.
