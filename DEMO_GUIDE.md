# Demo guide — unified timed booth experience

This is a short rehearsal script for the current mock. It demonstrates one
attendee moving from entry to three wristband-routed booth sessions, a booth
leader changing what attendees see, and the checkbox-only Phase 3.

The mock schedule assumes **July 18, 2026 in Nashville**. Local preview URLs
let you show every state without waiting for those exact times.

## 1. Start clean

From the repository:

```bash
cd demo-server
node server.js
```

No `npm install`, Google account, or database is needed. The local organizer
key is `demo`.

If this is not the first rehearsal, clear the old data from the organizer
dashboard or run:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"organizerKey":"demo"}' \
  http://localhost:3000/api/resetDemo
```

Open these windows:

| Window | URL | Role |
|---|---|---|
| A | `http://localhost:3000/phase1-entry/index.html` | Attendee phone |
| B | `http://localhost:3000/phase2-staff/index.html` | Booth leader directory |
| C | `http://localhost:3000/organizer/dashboard.html` | Overall organizer |

Use a private/incognito window for A so a previous attendee identity is not
reused. Unlock B's selected booth page and C with `demo`. Staff access is kept
in the current page's memory, so a reload may ask for the key again.

## 2. Register and assign a route

In Window A:

1. Enter `Jordan` and continue.
2. Point out the backend-assigned raffle number.
3. Select the **Blue** wristband.
4. Check the Guardian Angel handoff box and complete Phase 1.
5. Point out the three-stop route shown immediately:

   - Session 1, 3:10–3:30: Can You Draw Heaven?
   - Session 2, 3:30–3:50: Bible Bowl
   - Session 3, 3:50–4:10: The Sower, Live

6. Choose **Open my booth schedule**.

Suggested explanation: “The color is assigned once at entry. The attendee
keeps one page open; they do not scan and sign in separately at every booth.”

## 3. Show the before-session state

In Window A, use:

```text
http://localhost:3000/phase2-booths/hub.html?preview=before
```

Point out:

- Jordan's name and raffle number remain visible at the top;
- the Blue wristband and full three-stop route are visible;
- the page names the first booth before the session starts; and
- the countdown is shared from the event schedule.

The preview query deliberately freezes a deterministic moment. Remove the
query to see the real synchronized clock tick.

## 4. Let the booth leader control Session 1

From Window B, open **Can You Draw Heaven?**, then use this URL if needed:

```text
http://localhost:3000/phase2-staff/heaven.html?preview=1
```

Unlock it with `demo`. The page should show that Blue wristbands are scheduled
there in Session 1. Set the presentation to **Live**, choose an activity step,
optionally add a short announcement, and choose **Save to attendee screen**.

Now change Window A to:

```text
http://localhost:3000/phase2-booths/hub.html?preview=1
```

Within the next refresh, the attendee card shows the leader's status, selected
step, and announcement. Point out the Session 1 label, the 3:10–3:30 time, the
20-minute-session countdown, and the sticky name/raffle banner. Choose **Mark
this booth complete**.

Suggested explanation: “The schedule decides which booth Jordan sees. The
leader for that booth decides which instruction the group sees.”

## 5. Rotate through Sessions 2 and 3

Use these attendee preview URLs in order:

```text
http://localhost:3000/phase2-booths/hub.html?preview=2
http://localhost:3000/phase2-booths/hub.html?preview=3
```

For Blue, the current booth changes to Bible Bowl and then The Sower, Live.
The matching leader pages are:

```text
http://localhost:3000/phase2-staff/trivia.html?preview=2
http://localhost:3000/phase2-staff/story.html?preview=3
```

You can publish one step from each page and mark each attendee booth complete,
or simply show that the color route changes automatically. Every booth portal
has the same types of controls but booth-specific activity steps.

The complete routing matrix is:

| Wristband | Session 1 | Session 2 | Session 3 |
|---|---|---|---|
| Blue | Draw Heaven | Bible Bowl | The Sower, Live |
| Red | Bible Bowl | Draw Heaven | Art Therapy |
| Orange | Art Therapy | The Sower, Live | New Song |
| Green | New Song | Art Therapy | Draw Heaven |
| Yellow | The Sower, Live | New Song | Bible Bowl |

## 6. Finish with tick-and-go Phase 3

In Window A, open:

```text
http://localhost:3000/phase2-booths/hub.html?preview=ended
```

The hub now says all three sessions are complete and reveals **Choose my next
steps**. Open it. Jordan's name and raffle number remain at the top.

Tick one or more next-step cards and choose **Save & finish**. Demonstrate
that no rating, email, comment, or follow-up questionnaire appears. To finish
without a choice, use **No thanks, finish**.

Suggested explanation: “We already know whose raffle record this is, so the
last phase is deliberately just tick and go.”

## 7. Show the staff result

In Window C, wait for the organizer dashboard to refresh. Show:

- the registered and wristband-confirmed attendee;
- completed booth check-ins; and
- the selected Phase 3 option roster.

The organizer can still confirm a next-step conversation in person. That is a
staff workflow after the attendee's simple submission, not another attendee
question.

## Useful variations

### Recover on a second device

Open the Phase 2 hub in a separate private window. It asks once for Jordan's
Phase 1 name and raffle number, then restores the Blue route. This demonstrates
cross-device recovery without creating a second attendee.

### Try another color

Reset the demo and register a new attendee with Red, Orange, Green, or Yellow.
Use the same `?preview=1`, `2`, and `3` values to verify all route assignments.

### Show optional fallback pages

The direct `phase2-booths/booth-*.html` pages and the Art Therapy/New Song
kiosks remain available for compatibility or staff assistance. They are not
the default timed journey and should be described as fallbacks, not as links
every attendee must open.

## Questions to be ready for

- **Does this work offline?** No. The timer can continue from its last sync,
  but sign-in, leader updates, check-ins, and submissions need the backend.
- **Can a leader control only their booth?** The data endpoint and page are
  booth-scoped, but all staff pages currently share one organizer key. Anyone
  with that key can open another booth or the overall dashboard.
- **Is name plus raffle number secure login?** No. It is lightweight event
  record recovery for this mock.
- **What if the event date changes?** Edit `BOOTH_SESSIONS` in
  `web/shared/booths-config.js`; the current July 18, 2026 Nashville date is an
  assumption copied into the mock.
- **Can Phase 3 be opened early by URL?** Yes. The hub reveals it after 4:10,
  but the standalone page is not a server-enforced time gate.
- **Is this ready for live attendee data?** Not yet. Confirm credentials,
  access roles, privacy/retention, device testing, venue Wi-Fi, and a manual
  fallback first.
