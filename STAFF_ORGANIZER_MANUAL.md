# Staff and Booth Organizer Guide

## The Perfect Summer Day: Experience Heaven

This guide explains the current event app in practical terms: where staff begin, how the shared clock works, what each booth leader controls, and what attendees see. The current build is scheduled for **July 18, 2026, from 3:10–4:00 PM CDT**. If the event date or times change, update the app before deployment.

Staff begin at:

```text
https://YOUR-RENDER-SITE/organizer/
```

Choose **Overall Organizer** or the booth you are leading, then enter the shared organizer key. Do not give the staff link or key to attendees.

## 1. Schedule and wristband routes

All shared schedule, countdown, and route times use Nashville/Chicago time (CDT), even when a phone is set to Eastern time.

| Time | What happens |
|---|---|
| 3:10–3:30 PM | Session 1 |
| 3:30–3:50 PM | Session 2 |
| 3:50–4:00 PM | Booths are closed; attendees finish their next-step selections and wait |
| 4:00 PM | The main message begins on every attendee screen |

| Wristband | Session 1 | Session 2 |
|---|---|---|
| Blue | Draw Heaven | Bible Bowl |
| Red | Bible Bowl | Draw Heaven |
| Orange | Art Therapy | The Heaven Booth |
| Green | New Song | Art Therapy |
| Yellow | The Heaven Booth | New Song |

## 2. How the attendee experience works

1. The attendee registers with their **name and mobile number**, receives a raffle number, and a Guardian Angel confirms their wristband color. The raffle number is displayed for reference; it is not used to log in.
2. Their wristband determines the two-booth route above. Only the booth scheduled for the current time can open.
3. Refreshing the phone restores the attendee's login and saved position. On a new device, they open the attendee link or QR code and use the same name and phone number. **Log out** signs them out of that device; signing in again with the same details resumes their saved record.
4. Inside a booth, attendees follow the leader's current screen. They cannot click ahead.
5. On the final booth screen, the attendee must tap **Finish booth →**. The next booth remains locked until its scheduled session.
6. After Session 2, attendees make their quick next-step selections and wait for the 4:00 PM message.

**Late arrivals:** with at least five minutes remaining, an attendee enters the current assigned booth near the leader's current stage; Draw Heaven may first require its confirmation steps in order. With less than five minutes left in Session 1, the attendee waits for Session 2. With less than five minutes left in Session 2, the app directs them to an organizer for catch-up. A missed booth is never marked complete automatically.

## 3. Overall Organizer

### What the dashboard shows

Keep the Overall Organizer dashboard open during registration and the event. It refreshes automatically and shows:

- registrations, confirmed wristbands, raffle entries, and the count for each wristband color;
- the booth where every wristband group should currently be;
- expandable attendee rosters with raffle number, arrival status, and booth progress;
- check-in totals for each booth; and
- next-step selections, with **Confirm** available after staff speak with an attendee.

Bible Bowl rankings appear only in the Bible Bowl portal. New Song vote results appear only in the New Song portal.

### Rehearsal clock

The timeline can simulate any point from 3:10 to 4:00 PM. Drag the slider, enter an exact time, or use the 3:10, 3:30, 3:50, and 4:00 shortcuts. A selection does not affect anyone until you choose **Apply simulated time**.

**Show waiting lobby** starts shortly before Session 1. Use simulation for rehearsals only; all connected attendee and staff screens follow the same simulated point.

### Real event clock

Before guests enter, choose **Use live CDT clock**. Confirm the button is selected, the dashboard says **Live clock · CDT**, and the displayed time matches Nashville/Chicago time. During the live event, do not use simulated-time controls.

At 3:30 the app changes every route to Session 2. At 3:50 booth access closes. At 4:00 every attendee page announces that the main message is beginning.

### Clearing rehearsal data

Use **Clear all attendee data** only when intentionally starting over. It permanently removes registrations, wristbands, raffle numbering, booth visits, quiz scores, song votes, next-step selections, and booth run history. It also resets booth presentation state and sends connected attendee phones back to registration. It does not change the selected clock mode. If Google Sheets is connected, its managed event-data rows clear on the next successful sync, so download or copy anything that must be retained first.

## 4. Rules for every booth leader

- Open and unlock the booth portal before the group arrives. Confirm the active session, wristband color, and countdown.
- In Draw Heaven, Bible Bowl, Art Therapy, and New Song, the fixed control at the bottom tells you what **Next →** will show. One tap updates eligible attendee phones, normally within 2–5 seconds.
- When you need to pause, simply do not tap Next; attendee phones stay on the current screen.
- In those four session-based booths, a wrong-session control says **Switch to Session 1/2**. Switch first, review the next action, and then tap Next.
- Watch the automatic 10-minute, 5-minute, and final-15-second warnings. Reach the final screen early enough for attendees to tap **Finish booth →**.
- Avoid repeated taps while an update is saving. Use one primary operator per booth.

## 5. Booth-by-booth guide

### Draw Heaven (Can You Draw Heaven? in the staff directory)

**Groups:** Blue in Session 1; Red in Session 2.

Use **Next →** for this sequence:

1. Open the drawing prompt. Attendees draw their idea of Heaven, tap that their drawing is complete, and choose to see the biblical description.
2. Reveal the complete Revelation 21:10–11 KJV passage with the confetti transition.
3. Show the New Jerusalem size-comparison image. Attendees can enlarge it and respond to the follow-up.
4. Show the final reflection and transition.
5. Show the five-program information preview. This does not submit an attendee's next-step selections.
6. Release **Finish booth →**.

The leader portal shows each attendee's raffle number and confirmation progress for drawing, description, size, reflection, and program preview. **Archive/Save run & start another** preserves that run and opens a fresh welcome screen for the selected session.

### Bible Bowl

**Groups:** Red in Session 1; Blue in Session 2.

1. Keep attendees on the welcome screen until the speaker is ready, then tap **Next →** to show Question 1.
2. Each attendee chooses one answer. It locks, and they wait for the speaker.
3. Tap Next to reveal the correct answer on every phone.
4. Tap Next again to open the following question. Repeat the question/reveal rhythm; attendees cannot advance themselves.
5. After Question 15—or, after a reveal, by choosing **End game early and show results**—show the final results. Attendees see their score and the session's top three, then tap **Finish booth →**.

The booth-private leaderboard shows rank, attendee, raffle number, and score. Session 1, Session 2, and restarted runs remain separate. Restart only after the group has finished; the archived leaderboard remains available.

### Art Therapy

**Groups:** Orange in Session 1; Green in Session 2.

Tap **Next →** through the guided presentation:

1. What is art therapy?
2. Why is art therapy important?
3. The heart-and-mind image.
4. What does the Bible say about the heart?
5. Proverbs 4:23.
6. Philippians 4:7.
7. Now it is your turn: lead the physical art activity.
8. “I'm finished—now what?” and the closing reflection.
9. Release **Finish booth →**.

The app does not collect artwork, written reflections, ratings, or comments. The leader portal shows assigned attendees and saved completions. Archive/restart preserves the selected run and does not change the other session.

### The Heaven Booth

**Groups:** Yellow in Session 1; Orange in Session 2.

This portal has fixed **Back** and **Next** controls, direct screen selection, and **Restart at welcome**. It does not include a free-text announcement field.

The ordered flow is:

1. Welcome: **The Heaven Booth**.
2. Four picture screens, one at a time: mustard seed/tree, yeast/dough, hidden treasure, and fishing net. Ask, “What do you see?”
3. Ask whether the four pictures are related.
4. Reveal that they all describe the Kingdom of Heaven.
5. Show the four NIV passage screens: Matthew 13:31–32, 13:33, 13:44, and 13:47–48.
6. Show **Thank you**, which releases **Finish booth →**.

Back and Next publish immediately. Tapping a screen in the list also publishes it immediately. This booth uses one shared presentation rather than separate session tabs or archived runs, and its check-in count is combined. Use **Restart at welcome** only when deliberately resetting the presentation.

### New Song

**Groups:** Green in Session 1; Yellow in Session 2.

1. Keep the welcome screen open until the room is ready, then tap **Next →** to open the 11-song poll.
2. Each attendee gets one saved vote. The booth leader can watch the private live graph while attendees wait.
3. Tap Next to close voting and show the most-voted song to leaders and attendees. At least one vote is required. Ties display all tied songs.
4. Give the room time to discuss or guess. Tap Next only when ready to reveal Revelation 14:3 KJV and its artwork.
5. Tap Next after the reflection to release **Finish booth →**.

Votes, results, attendee progress, and archived runs remain separate for each session. Restart after the group clears the booth so the saved run remains available.

## 6. Google Sheets export

The app database is the source of truth; Google Sheets is a live mirror. A Sheet error does not undo a successful registration or booth action.

### During the event

- Once unlocked, Overall Organizer shows **Not connected**, **Ready**, **Queued**, **Syncing**, **Up to date**, **Needs attention**, or **Unavailable**.
- **Sync now** or **Retry now** queues an immediate full-snapshot attempt; wait for **Up to date**. Failed attempts also retry automatically.
- Each successful sync replaces the managed `Live_*` tabs with the latest app state; it does not append permanent history.
- Phase 3 **Confirm** writes `TRUE`, `staff`, and the event time to `Live_SignUps` columns J–L.
- Phone numbers are exported in readable formatting. Bible Bowl answers/rankings and New Song votes remain private to their booth portals.
- Before clearing attendee data, download CSV files or copy the spreadsheet if a historical record is needed.

Managed tabs are `Live_Attendees`, `Live_BoothResults`, `Live_SignUps`, `Live_TriviaAnswers`, `Live_HeavenConfirmations`, `Live_SongVotes`, and `Live_ExportMeta`. The private trivia and song tabs remain header-only.

### One-time setup for the technical owner

1. Enable **Google Sheets API** in the Google Cloud project.
2. Create a service account and download its JSON key.
3. Share the destination Sheet with the JSON file's `client_email` as **Editor**.
4. Copy the spreadsheet ID from between `/d/` and `/edit` in its URL.
5. Base64-encode the complete JSON key and add these server-only Render variables:

```text
EVENT_APP_GOOGLE_SHEET_ID=your-spreadsheet-id
EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=your-base64-json

# Optional
EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS=3000
EVENT_APP_SHEETS_EXPORT_TIMEOUT_MS=10000
```

Remove the retired Apps Script variables if present, choose **Save and deploy**, then open Overall Organizer and choose **Sync now**. Apps Script and `Code.gs` are not used. Never put the JSON key in GitHub, Slack, or browser code.

## 7. Event-day checklist

1. Confirm Render is healthy, running one instance, and using its persistent disk.
2. Open Overall Organizer and select **Use live CDT clock**.
3. Confirm Google Sheets says **Up to date**, if export is enabled.
4. Have each booth leader unlock their portal and confirm Session 1's wristband color.
5. Leave attendees on the welcome/lobby screen until 3:10.
6. At 3:30, confirm every portal has switched to Session 2.
7. At 3:50, direct attendees to next-step selections and the waiting area.
8. At 4:00, confirm the main-message notice appears.

### Quick troubleshooting

- **Next did not change phones:** wait a few seconds, confirm you are controlling the live session, and use Refresh. If the button says Switch to Session, switch first and then tap Next.
- **An attendee cannot enter:** check their wristband, current time, and late-arrival status. Off-route rooms are intentionally locked.
- **An attendee refreshed:** their position should restore. On a new device, they sign in with the same name and phone number.
- **A staff refresh asks for the key again:** re-enter the organizer key; staff access is remembered only for the current page session.
- **The session ended before Finish booth:** ask Overall Organizer about catch-up; never mark it complete automatically.
- **Sheets needs attention:** the event app still works. Retry, then verify the Sheet ID, Sheets API, service-account sharing, and Render JSON variable.
