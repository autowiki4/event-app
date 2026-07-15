# Demo server

Local stand-in for the production Google Apps Script backend — same API
shape, backed by `db.json` instead of a Google Sheet. Zero npm dependencies
(just Node's built-in `http` module), so there's nothing to install.

## Run it

```
node server.js
```

Then open `http://localhost:3000/phase1-entry/index.html` to start the
flow, or `http://localhost:3000/organizer/dashboard.html` to watch it live.

Change the port with `PORT=4000 node server.js`.

## Reset between rehearsals

```
curl -X POST http://localhost:3000/api/resetDemo
```

Or click "Reset demo data" at the bottom of the organizer dashboard. Either
wipes `db.json` back to empty.

## How this maps to production

Every route here (`registerAttendee`, `confirmWristband`,
`findOrRegisterByPhone`, `boothCheckin`, `submitSignup`,
`confirmSignupInPerson`, `dashboardData`, `myCheckins`) has a matching
function in `../apps-script/Code.gs`. Swapping from this demo server to the
real event backend is just changing `API_BASE_URL` in
`../web/shared/config.js` — no frontend code changes.
