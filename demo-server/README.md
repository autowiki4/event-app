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
  Organizer dashboard:  http://localhost:3000/organizer/dashboard.html
  Print QR codes:       http://localhost:3000/organizer/qr-codes.html
```

Open any of those URLs in a browser. That's the whole app, running
locally — every page under `../web/` is being served by this same process,
and every button click talks to it.

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
  curl -X POST http://localhost:3000/api/resetDemo
  ```

## How this maps to production

Every route here (`registerAttendee`, `confirmWristband`,
`findOrRegisterByPhone`, `boothCheckin`, `submitSignup`,
`confirmSignupInPerson`, `dashboardData`, `myCheckins`) has a matching
function in `../apps-script/Code.gs`, doing the same thing against a real
Google Sheet instead of `db.json`. Swapping from this demo server to the
real event backend is just changing `API_BASE_URL` in
`../web/shared/config.js` — no frontend code changes, and nothing in
`../web/` needs to know which backend it's talking to.
