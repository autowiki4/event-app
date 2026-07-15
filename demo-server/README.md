# Demo server

Local stand-in for the production Google Apps Script backend — same API
shape, backed by `db.json` instead of a Google Sheet. Zero npm
dependencies (just Node's built-in `http` module), so there's nothing to
install beyond Node.js itself.

This is the backend you use for building, rehearsing, and demoing the app
— see `../README.md` for what the app actually does, and `../DEMO_GUIDE.md`
for a script to present it live. This file just covers running this one
piece.

## Prerequisites

Node.js, version 16 or newer. Check with `node --version` in a terminal —
if that fails, install it from [nodejs.org](https://nodejs.org) (the
"LTS" button).

## Run it

Open a terminal, navigate into this folder, and run:

```
cd demo-server
node server.js
```

You should see:

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

Open any of those URLs in a browser. That's the whole app, running
locally — every page under `../web/` is being served by this same process,
and every button click talks to it.

The dashboard and staff kiosks ask for an organizer key. The zero-setup local
default is `demo`. To rehearse with a different key, start the server with:

```
EVENT_APP_ORGANIZER_KEY="a-long-test-key" node server.js
```

You can skip the QR page during local development. Open Phase 1, then open the
exact Phase 2 room for the booth you want to test; each of the five rooms asks
for the Phase 1 name and raffle number independently. The old
`phase2-booths/hub.html` URL is only a compatibility notice, not a shared
login. Phase 3 and the overall organizer dashboard remain separate and
unchanged. Final QR generation for the five booth-room links is deferred until
there is a real public URL to encode; the current generator is intentionally
unchanged.

Every booth also has a scoped staff page under `phase2-staff/`. It receives
only that booth's activity and contains a neutral booth-only settings area for
future controls. Art Therapy and New Song retain their organizer-key kiosks as
optional staff fallbacks.

**To stop it:** click into that terminal window and press `Ctrl+C`.

**If port 3000 is already taken** (you'll see an `EADDRINUSE` error),
either stop whatever else is using it, or run this server on a different
port:

```
PORT=3001 node server.js
```

...then use `http://localhost:3001/...` in place of `3000` everywhere.

## The "database" (`db.json`)

The first time you register an attendee, this folder gets a `db.json`
file — a plain text file holding every attendee, booth check-in, and
sign-up so far. It's created automatically; you never need to make it by
hand, and it's safe to delete any time you want a completely clean slate
(the server will just recreate an empty one on the next request).

It's excluded from git (see the repo's `.gitignore`) on purpose — it's
throwaway demo data, not something to commit or share.

## Reset between rehearsals

Two equivalent ways to wipe it back to empty without deleting the file
yourself:

- Click **"Reset demo data"** at the bottom of the organizer dashboard.
- Or, from a terminal:

  ```
  curl -X POST -H "Content-Type: application/json" \
    -d '{"organizerKey":"demo"}' \
    http://localhost:3000/api/resetDemo
  ```

## Run the regression tests

There are no packages to install. From this folder:

```
npm test
```

The suite starts an isolated temporary server/database and covers separate
per-booth and Phase 3 login lookup, organizer authorization, booth-scoped staff
data, duplicate booth-completion protection, secure phone linking, duplicate
attendee merging, preserved raffle numbers and kiosk history, protected
confirmation/reset actions, and Apps Script-style HTTP-200 error payloads.

## How this maps to production

Every route here (`registerAttendee`, `loginAttendee`,
`attendeePortalSession`, `confirmWristband`, `findOrRegisterByPhone`,
`boothCheckin`, `submitSignup`, `boothDashboardData`,
`confirmSignupInPerson`, `dashboardData`, `myCheckins`) has a matching
function in `../apps-script/Code.gs`, doing the same thing against a real
Google Sheet instead of `db.json`. Swapping from this demo server to the
real event backend is just changing `API_BASE_URL` in
`../web/shared/config.js` — no frontend code changes, and nothing in
`../web/` needs to know which backend it's talking to.

Staff-only routes (`verifyOrganizer`, `dashboardData`,
`boothDashboardData`, kiosk phone lookup, staff kiosk check-in, confirmation,
and demo reset) require the organizer key in their POST JSON. Attendee booth
history resolves only by the canonical attendee ID saved after portal login;
a phone number alone cannot read a record.
