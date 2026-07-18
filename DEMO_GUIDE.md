# Demo guide — unified timed booth experience

This is a short rehearsal script for the current mock. It demonstrates one
attendee moving from entry to two color-routed booth sessions, a booth leader
changing what attendees see, the checkbox-only Phase 3, the message window,
and one optional extra booth or Connections.

The mock schedule assumes **July 18, 2026 in Nashville**. The organizer's
shared Node clock lets every attendee and staff window using the same service
show the same event moment without waiting for those exact times. It works
with the Node service locally or when that same service is hosted on Render.

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

The dashboard action is deliberately broad: it clears registrations and
wristbands, check-ins and scores, votes, Phase 3 sign-ups, booth presentation
controls, and the raffle sequence. It also replaces the backup and signals
connected or reopened attendee phones to clear their saved identity and return
to Phase 1. It does not change the selected rehearsal time.

Open these windows:

| Window | URL | Role |
|---|---|---|
| A | `http://localhost:3000/phase1-entry/index.html` | Attendee phone |
| B | `http://localhost:3000/organizer/index.html` | Choose a booth leader view |
| C | `http://localhost:3000/organizer/index.html` | Choose Overall Organizer |

Use a private/incognito window for A so a previous attendee identity is not
reused. The same organizer URL is used in B and C: choose the relevant booth
in B and **Overall Organizer** in C, then unlock each selected page with
`demo`. Staff access is kept in the current page's memory, so a reload may ask
for the key again.

In Window C, find **Demo only · Shared event time**. Its continuous timeline
affects every attendee, overall-organizer, and booth-leader page connected to
this Node service, including Window A in incognito. Drag to any second from
3:35:00 through 5:10:00 PM, enter an exact time, or use the 3:35, 3:55, 4:15,
4:50, and 5:10 boundary shortcuts, then choose **Apply simulated time**. The
selected point continues ticking normally. This panel is a rehearsal helper;
the Apps Script adapter has no remote clock or reset actions.

## 2. Register and assign a route

In Window A:

1. Enter `Jordan` and a test mobile number, then choose **Create my event
   pass**. Point out that the raffle number appears immediately and nothing is
   sent to the phone.
2. Select **In person**. Point out that the app asks for the wristband color
   the attendee was physically given. Select **Blue**. In a second rehearsal,
   choose **Online** to show the simpler **Select a color** instruction.
3. Check the Guardian Angel handoff box and choose **Complete Phase 1 &
   continue**. The same attendee identity opens directly in the Phase 2 hub;
   there is no second attendee sign-in or intermediate completion page. The
   Overall Organizer roster now shows the in-person/online status.
4. Point out the two-stop route in the hub:

   - Session 1, 3:35–3:55: Can You Draw Heaven?
   - Session 2, 3:55–4:15: Bible Bowl

Suggested explanation: “The color is assigned once at entry. The attendee
continues directly into one hub and does not scan or sign in separately at
every booth.”

## 3. Show the before-session state

In Window C, choose **Show waiting lobby**. Within the next clock sync, Window
A updates without changing or reloading its URL.

Point out:

- Jordan's name and raffle number remain visible at the top;
- the Blue wristband and full two-stop route are visible;
- the waiting lobby keeps every booth locked and says it will open without a refresh;
- the page names the first booth before the session starts; and
- the countdown is shared from the event schedule.

Refresh Window A while it is in the lobby. It should return as Jordan instead
of showing registration again. In Window C, use the **3:35** shortcut and
choose **Apply simulated time**. Show that the lobby unlocks the first booth on
every connected screen. Jordan remains signed in until the name menu at the
top-right is used to log out—or until an organizer deliberately clears all
event data.

Choosing **Use live CDT clock** returns all Node-backed screens to actual
synchronized Chicago time.

## 4. Let the booth leader control Session 1

In Window C, move the timeline to **3:45:00 PM** and choose **Apply simulated
time**. From the organizer directory in Window B, open **Draw Heaven** and
unlock it with `demo`. The page should show that Blue wristbands are scheduled
there in Session 1. The fixed control names the next screen attendees will see;
choose **Next →** once to open the drawing activity.

Within the next refresh, the attendee activity shows the leader's selected
screen. Point out the Session 1 label, the 3:35–3:55 time, the
20-minute-session countdown, and the sticky name/raffle banner. Continue with
**Next →** to demonstrate that attendees cannot advance ahead of the leader.
At the final screen, the attendee chooses **Finish booth →**. The completion
is saved and the app returns to the schedule. The finished booth is visibly
marked complete but cannot be reopened, which prompts Jordan to leave the room
and prepare for the next stop.

Suggested explanation: “The schedule decides which booth Jordan sees. The
leader for that booth decides which instruction the group sees.”

## 5. Rotate into Session 2

In Window C, apply **4:05:00 PM**. Window A and the matching booth-leader
screen rotate together. The shared clock ticks forward from the chosen anchor;
the two session windows remain 3:35–3:55 and 3:55–4:15.

For Blue, the current booth changes to Bible Bowl. Its leader page is:

```text
http://localhost:3000/phase2-staff/trivia.html
```

Advance the booth activity and save its final Done tap. The clock changes the
active booth, but it does not mark a visit complete. After the second saved
tap, the hub reveals **Continue to Phase 3** even though Session 2 is still
active. Every booth portal has booth-specific controls and content.

Before completing one booth, enter a time exactly 15 seconds before that
session boundary—for example **3:54:45** or **4:14:45**—and apply it. Point
out the short finish warning on the attendee screen, then save the visit. This
checks the time-critical state without waiting through a 20-minute session.

The complete routing matrix is:

| Wristband | Session 1 | Session 2 |
|---|---|---|
| Blue | Draw Heaven | Bible Bowl |
| Red | Bible Bowl | Draw Heaven |
| Orange | Art Therapy | The Heaven Booth |
| Green | New Song | Art Therapy |
| Yellow | The Heaven Booth | New Song |

## 6. Show the message and optional extra booth

Keep the shared clock on Session 2 after both completion taps are saved.
Choose **Continue to Phase 3**. Jordan's name and raffle number remain at the
top.

Tick one or more next-step cards and choose **Save & finish**. Demonstrate that
no rating, email, comment, or follow-up questionnaire appears. To exercise the
empty path instead, use **No thanks, finish**. Both actions persist Phase 3
completion.

Use the **4:15** boundary shortcut and choose **Apply simulated time** in
Window C. Regular booth access closes, and every attendee screen says:
**The message is being delivered. I hope you get blessed today.** The screen
counts down to 4:50 PM and does not offer a completed booth again.

Next, use the **4:50** shortcut and apply it. A flashy chooser asks **Want to
explore one more booth?** Jordan sees only booths not already completed and a
separate **Connections** choice. Select an unvisited booth and show that it
opens as Session 3 for the 4:50–5:10 window. Its booth leader controls the
same attendee flow from the Session 3 tab. After Jordan taps **Finish booth
→**, the completion is saved and the schedule offers Connections. Applying
the **5:10** shortcut sends any remaining attendee to Connections as well.

Suggested explanation: “We already know whose raffle record this is, so the
last phase is deliberately just tick and go. The same shared clock holds every
screen on the message, then opens one optional new booth or Connections at the
same moment.”

## 7. Show the staff result

In Window C, wait for the organizer dashboard to refresh. Show:

- the registered attendee's in-person/online status and confirmed color;
- only the booth check-ins the attendee explicitly tapped; and
- the selected Phase 3 option roster; and
- Jordan's optional extra-booth or Connections choice.

The organizer can still confirm a next-step conversation in person. That is a
staff workflow after the attendee's simple submission, not another attendee
question.

## Useful variations

### Recover on a second device

Open the Phase 2 hub in a separate private window. It asks once for Jordan's
registration name and mobile number, then restores the same raffle and Blue
route. This demonstrates cross-device recovery without creating a second
attendee.

### Try another color

Reset the demo and register a new attendee with Red, Orange, Green, or Yellow.
Use points inside the same shared Session 1 and Session 2 timeline regions to
verify all route assignments.

### Show the 4:15 fallback with an unmarked visit

With a fresh attendee, leave at least one booth untapped and apply the **4:15**
boundary in the organizer dashboard so the shared clock enters the message
state.

The missed visit remains unmarked and every attendee screen shows the message.
At 4:50, that missed booth can appear among the attendee's optional choices.
The app never converts elapsed time into a completed visit.

### Choose Connections instead of an extra booth

At 4:50, choose **Connections** from the optional-booth chooser. The attendee
goes directly to Connections and cannot later switch to an extra booth. This
keeps the one-choice rule clear and avoids double room assignments.

### Show optional fallback pages

The direct `phase2-booths/booth-*.html` pages and the Art Therapy/New Song
kiosks remain available for compatibility or staff assistance. They are not
the default timed journey and should be described as fallbacks, not as links
every attendee must open.

### Inspect just one page

The localhost-only `?preview=before|1|2|message|extra|connections` query remains
useful for an isolated page check. It is frozen and browser-local, so use the
shared organizer clock for this multi-window rehearsal. Once the organizer has
chosen a shared time, that Node-controlled time takes precedence.

## Questions to be ready for

- **Does this work offline?** No. The timer can continue from its last sync,
  but sign-in, leader updates, check-ins, and submissions need the backend.
- **Can a leader control only their booth?** The data endpoint and page are
  booth-scoped, but all staff pages currently share one organizer key. Anyone
  with that key can open another booth or the overall dashboard.
- **Is name plus phone secure login?** No. It is lightweight mock record
  recovery rather than strong authentication, and no message is sent to prove
  control of the number. The raffle is display-only and cannot be used to log
  in.
- **What if the event date changes?** Update the regular-session, message,
  extra-session, and event-end constants together in
  `web/shared/booths-config.js`; the current July 18, 2026 Nashville date is an
  assumption copied into the mock.
- **When does Phase 3 become available?** As soon as both regular booth taps
  are saved while the regular schedule is active. At 4:15 the message takes
  over all attendee screens. Opening
  the Phase 3 URL too early returns the attendee to the hub using the same
  client-side eligibility check.
- **What happens after the regular booths?** From 4:15–4:50 all attendee
  screens show the message notice. At 4:50, an attendee chooses one unvisited
  booth or Connections. The extra booth closes at 5:10 and then routes to
  Connections.
- **Can this clock change real time?** No. The shared timeline is a Node-service
  rehearsal override; **Use live CDT clock** removes it and resumes actual
  Chicago time. It can coordinate all same-origin pages locally or on Render,
  but it is not resilient show-control infrastructure. Apps Script pages have
  no remote clock control and continue to use synchronized real time.
- **Is this ready for live attendee data?** Not yet. Confirm credentials,
  access roles, privacy/retention, device testing, venue Wi-Fi, and a manual
  fallback first.
