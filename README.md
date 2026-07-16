# The Perfect Summer Day — event app mock

This repository is a runnable mock and implementation framework for a timed,
multi-device event experience. It is useful for design reviews, rehearsals,
and validating the flow with the event team. It is **not production-ready**:
the event date and operating rules still need confirmation, access is not
strong authentication, and the deployment needs a security and venue-network
review.

The attendee journey is now one continuous flow:

1. **Phase 1 — entry:** enter a name, receive a raffle number, and have a
   Guardian Angel assign and confirm the physical wristband color.
2. **Phase 2 — timed booth route:** keep one attendee hub open. It shows the
   attendee's name and raffle number, a shared timer, the current booth, and
   the booth leader's live instructions. Each wristband visits three of the
   five booths.
3. **Phase 3 — tick and go:** select any next-step options and finish. There
   are no ratings, comments, or extra attendee questions.

The older direct booth-room pages remain available as optional fallbacks, but
they are no longer the primary attendee experience.

## Wristband routes

The color selected in Phase 1 determines all three stops:

| Wristband | Session 1 | Session 2 | Session 3 |
|---|---|---|---|
| Blue | Can You Draw Heaven? | Bible Bowl | The Sower, Live |
| Red | Bible Bowl | Can You Draw Heaven? | Art Therapy Table |
| Orange | Art Therapy Table | The Sower, Live | The New Song in Nashville |
| Green | The New Song in Nashville | Art Therapy Table | Can You Draw Heaven? |
| Yellow | The Sower, Live | The New Song in Nashville | Bible Bowl |

The current mock schedule is:

| Session | Time |
|---|---|
| 1 | 3:10–3:30 PM |
| 2 | 3:30–3:50 PM |
| 3 | 3:50–4:10 PM |

These timestamps currently assume **July 18, 2026 in Nashville** and use the
event-day offset `-05:00` (CDT). That date is an editable mock assumption, not
a production configuration service. Confirm it with the event team and edit
`BOOTH_SESSIONS` in `web/shared/booths-config.js` before deployment.

## Quick start

The local demo needs Node.js 16 or newer. It has no npm dependencies and does
not need a Google account or database.

```bash
git clone https://github.com/autowiki4/event-app.git
cd event-app/demo-server
node server.js
```

The server prints the main local links:

```text
Event app demo server running: http://localhost:3000
  Phase 1 entry:        http://localhost:3000/phase1-entry/index.html
  Attendee booth route: http://localhost:3000/phase2-booths/hub.html
  Phase 3 attendee:     http://localhost:3000/phase3-signup/index.html
  Phase 2 staff hub:    http://localhost:3000/phase2-staff/index.html
  Organizer dashboard:  http://localhost:3000/organizer/dashboard.html
  QR codes (optional):  http://localhost:3000/organizer/qr-codes.html
  Timer previews:       add ?preview=before, 1, 2, 3, or ended to the attendee/staff URL
  Local organizer key:  demo
```

Start at Phase 1. On the same device, the hub and Phase 3 reuse the saved
attendee identity. On another device, the attendee enters their Phase 1 name
and raffle number once to recover the same route. The name and raffle number
stay visible at the top of the hub and Phase 3 as a reminder.

Press `Ctrl+C` in the terminal to stop the server.

### Preview a session without changing the clock

The real event time is not convenient for rehearsals. On localhost only,
append one of these query values to the attendee hub or an individual booth
leader page:

```text
?preview=before
?preview=1
?preview=2
?preview=3
?preview=ended
```

For example:

```text
http://localhost:3000/phase2-booths/hub.html?preview=1
http://localhost:3000/phase2-staff/heaven.html?preview=1
```

Preview mode holds the page at a deterministic point in that state, so its
countdown is intentionally frozen. Without `?preview=...`, the synchronized
clock counts down normally. The override is ignored on non-local hosts.

## Booth-leader portals

`web/phase2-staff/index.html` links to one staff portal per booth. After
unlocking a booth page, its leader can publish:

- a status: waiting, live, paused, wrap up, or complete;
- the current booth-specific activity step; and
- an optional short announcement.

The attendee hub polls for that booth's published state and refreshes the
current screen automatically. Leaders also see the wristband group scheduled
for their booth, the shared timer, and that booth's recent check-ins.

All five staff portals currently share one organizer key. The backend scopes
the data and controls by booth, but the shared key is **not per-booth access
control**: anyone with it can unlock another staff or organizer page. Use the
local value `demo` only for rehearsal. A production version needs strong,
rotatable credentials and preferably separate roles or booth-level grants.

## What is in the repo

```text
event-app/
├── web/
│   ├── phase1-entry/       registration + raffle + wristband assignment
│   ├── phase2-booths/      unified hub + optional legacy booth/kiosk pages
│   ├── phase2-staff/       booth-leader directory and five scoped portals
│   ├── phase3-signup/      checkbox-only next steps
│   ├── done/               final recap
│   ├── organizer/          event-wide dashboard and unified-flow QR utility
│   └── shared/             identity, schedule, API, content, and shared UI
├── demo-server/            local Node backend using a throwaway JSON file
├── apps-script/            Google Sheets + Apps Script parity backend
├── ARCHITECTURE.md         identity, timing, controls, and data design
├── DEMO_GUIDE.md           a short presentation/rehearsal script
└── qr/QR_PLAN.md           recommended placement and print checklist
```

Both backends implement the same browser-facing API. The Node version writes
to `demo-server/db.json`; the Apps Script version writes to Google Sheets.
Switching backends is controlled by `API_BASE_URL` in
`web/shared/config.js`.

The Apps Script implementation is deployment-shaped, not proof that the whole
system is ready for a live event. Test it on the venue network, replace the
shared organizer-key model, confirm privacy/retention requirements, and define
an offline fallback before collecting real attendee data.

## Test and reset

From `demo-server/`:

```bash
npm test
```

The zero-dependency regression suite exercises the API and static-page
contracts, including attendee identity lookup, wristband-color persistence,
Phase 2 eligibility, booth presentation reads and protected updates,
booth-scoped staff data, duplicate check-in protection, Phase 3 sign-ups,
organizer authorization, reset behavior, and inline JavaScript syntax.

To clear rehearsal data, use the organizer dashboard or run:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

## Known mock limitations

- Name plus raffle number is convenient record recovery, not strong identity
  verification.
- The synchronized experience needs working network access; there is no
  offline queue.
- Phase 3 is revealed by the hub after 4:10 PM, but the standalone Phase 3 URL
  is not a security-enforced time gate.
- Booth leaders share one organizer key, and their controls are one current
  state per booth rather than a historical show-control system.
- QR codes must be regenerated and device-tested after the app has a stable
  public URL; never print localhost or preview-query links.

## Related docs

| Document | Purpose |
|---|---|
| `ARCHITECTURE.md` | How identity, schedule synchronization, routing, and booth controls connect |
| `DEMO_GUIDE.md` | How to present the unified flow using local preview states |
| `demo-server/README.md` | Local backend, data file, reset, and API parity |
| `apps-script/README.md` | Google Apps Script deployment sketch |
| `apps-script/SHEET_SCHEMA.md` | Sheet tabs and columns |
| `qr/QR_PLAN.md` | Unified-flow QR destinations, placement, and print checklist |
