# Sheet schema

Reference for the six legacy standalone-backend tabs `Code.gs` creates and the
separate `Live_*` tabs written directly by the Node/Render service. For the
current service-account setup, see `README.md` in this folder. You do not need
to create any `Live_*` tab by hand.

## Attendees
| attendeeId | aliasIds | name | phone | raffleNumber | wristbandConfirmedAt | registeredAt | wristbandColor | phase3CompletedAt |
|---|---|---|---|---|---|---|---|---|

- `attendeeId`: UUID generated in the browser at Phase 1 (or by a kiosk if someone skips Phase 1).
- `aliasIds`: JSON array of older device/attendee IDs retained when staff
  securely pair and merge records. Old devices continue resolving to the
  canonical attendee.
- `phone`: digits only, no formatting.
- `raffleNumber`: assigned once, server-side, via a locked counter in the `Meta` tab.
  If a duplicate record is merged, the raffle number shown on the canonical
  entry record is preserved. The discarded number is never reused, so harmless
  gaps can appear in the sequence.
- `wristbandColor`: one of `blue`, `red`, `orange`, `green`, or `yellow`.
  It is written at the same time staff confirm the wristband and determines
  the attendee's two-booth route. Older rows are left intact and receive an
  empty value until staff reconfirm a color.
- `phase3CompletedAt`: the first time the attendee clicks either Phase 3 finish
  action. It is recorded even when they choose no options and is not changed by
  later edits to their selections.

## BoothCheckins
| id | attendeeId | phone | name | boothId | boothName | checkedInBy | checkedInAt | rating | note | extraData |
|---|---|---|---|---|---|---|---|---|---|---|

- One row per booth visit.
- `checkedInBy`: `"self"` (attendee's own phone) or `"staff-kiosk"`.
- `extraData`: JSON string, shape depends on the booth (e.g. `{"score":300}` for trivia or `{"votedFor":"Victory"}` for the song booth).
- `rating` and `note` remain only for backward compatibility with older saved
  rows. The current attendee and Art kiosk screens do not ask for either.

## SongVotes
| id | attendeeId | name | songTitle | votedAt |
|---|---|---|---|---|

- One row per attendee, saved immediately when they tap a New Song choice.
- The row is updated instead of duplicated if a retry repeats the same vote.
- This separate tab lets the booth leader see the opening vote before the
  attendee finishes the full booth activity.

## SignUps
| id | attendeeId | phone | name | optionId | optionTitle | email | stars | comment | submittedAt | confirmedInPerson | confirmedBy | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

- One row per option an attendee selected in Phase 3.
- `confirmedInPerson` starts `false` — the organizer dashboard flips it to `true` once staff actually talk to that person at the relevant table.
- `email`, `stars`, and `comment` remain legacy compatibility columns. The
  current Phase 3 flow is checkbox-only and leaves them empty.

## BoothControls
| boothId | stepIndex | status | message | createdAt | updatedAt | version |
|---|---|---|---|---|---|---|

- One row per booth. The booth-leader portal updates this row; attendee screens
  read it without receiving the organizer key.
- `status`: `waiting`, `live`, `paused`, `wrap`, or `complete`.
- `stepIndex`: zero-based presentation step, limited to `0`–`50` by the API.
- `message`: legacy compatibility column. The current Heaven Booth portal does
  not accept or display free-text announcements and always writes this value
  as blank for that booth.
- `version`: starts at `1` on the first update and increments on every saved
  change so attendee screens can ignore stale responses.

## Meta
| key | value |
|---|---|

- Currently just `raffleCounter` — the last raffle number handed out.

## Exporting "the file with names and numbers"

In legacy Apps Script backend mode, use `Attendees`. With the recommended
Node/Render mirror, use `Live_Attendees`. **File → Download → CSV** in Google
Sheets gives you name, phone, raffle number, wristband, progress, and Phase 3
completion without another app export step.

## Direct Node/Render live export

The current Node/Render backend uses a dedicated service account and the
Google Sheets API. No Apps Script Web App URL or `EXPORT_KEY` is involved. The
server validates the fixed seven-tab schema below, reads spreadsheet metadata,
creates any missing managed tabs, and sends one atomic
`spreadsheets.batchUpdate`.

Each managed tab's complete matrix is written while stale trailing rows and
obsolete extra columns are cleared. The batch also grows undersized grids and
freezes each header row. Google validates the whole request before applying
it, so a rejected export leaves the previous Sheet snapshot intact. Every
string is sent as text rather than as a formula. The exporter retries the
newest complete snapshot and the protected Overall Organizer card reports its
sanitized status.

Removing a selection or clearing all attendee data removes stale Sheet rows on
the next successful sync. The seven `Live_*` tabs are app-managed; put manual
notes on unrelated tabs. Unrelated tabs are not changed.

Logical snapshot names are written to isolated physical tabs so this export
cannot collide with the tabs used when Apps Script itself is the app backend:

| Snapshot tab | Physical Sheet tab |
|---|---|
| `Attendees` | `Live_Attendees` |
| `BoothResults` | `Live_BoothResults` |
| `SignUps` | `Live_SignUps` |
| `TriviaAnswers` | `Live_TriviaAnswers` |
| `HeavenConfirmations` | `Live_HeavenConfirmations` |
| `SongVotes` | `Live_SongVotes` |
| `ExportMeta` | `Live_ExportMeta` |

### Live_Attendees

| attendeeId | aliasIds | name | phone | raffleNumber | wristbandColor | registeredAt | wristbandConfirmedAt | phase3CompletedAt | completedBoothIds | completedBoothCount | signupOptionIds |
|---|---|---|---|---|---|---|---|---|---|---|---|

The Node server creates an attendee immediately from the Phase 1 name and
phone form. The collected phone is included in `Live_Attendees` and joined
into the attendee's operational result and sign-up rows. The backend database
and attendee login continue to use digits-only phone values. For staff
readability, the service-account export displays ten-digit US numbers as
`(615) 555-0101` and legacy eleven-digit values beginning with `1` as
`+1 (615) 555-0101`. This display formatting is limited to the phone columns
in `Live_Attendees`, `Live_BoothResults`, and `Live_SignUps`.

### Live_BoothResults

| id | attendeeId | name | phone | raffleNumber | wristbandColor | boothId | boothName | checkedInBy | checkedInAt | sessionNumber | runId | runNumber | score | correctCount | answeredCount | totalQuestions | votedFor | featuredWinner | extraData |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

`extraData` contains only allowlisted non-activity operational metadata.
Attendee-entered Art reflections stay out of the Sheet
mirror. Bible Bowl score columns and New Song vote/result columns are blank;
those details remain in their respective protected booth portals.

### Live_SignUps

| id | attendeeId | name | phone | raffleNumber | wristbandColor | optionId | optionTitle | submittedAt | confirmedInPerson | confirmedBy | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|---|---|

### Live_TriviaAnswers

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | questionId | questionNumber | answerIndex | isCorrect | answeredAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

This compatibility tab is intentionally header-only. A full sync removes old
answer rows while preserving the stable Sheet schema.

### Live_HeavenConfirmations

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | action | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|

### Live_SongVotes

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | songTitle | votedAt | updatedAt |
|---|---|---|---|---|---|---|---|---|---|---|

This compatibility tab is intentionally header-only. New Song votes and the
winning result remain visible only in the New Song booth-leader portal.

### Live_ExportMeta

| key | value |
|---|---|

`Live_ExportMeta` records the snapshot schema version, `generatedAt`,
`dataResetAt`, and each data tab's row count. It is the final managed tab in the
atomic replacement. Array/object fields in the other tabs are serialized JSON
text rather than nested Sheet values.
