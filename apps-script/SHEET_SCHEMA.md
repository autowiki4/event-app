# Sheet schema

Reference for the six standalone-backend tabs `Code.gs` creates automatically
— you don't need to make any of these by hand. For how to actually deploy
`Code.gs` and get this Sheet up and running, see `README.md` in this same
folder. A separate set of `Live_*` tabs used by the optional Node/Render export
is documented below.

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
  the attendee's three-booth route. Older rows are left intact and receive an
  empty value until staff reconfirm a color.
- `phase3CompletedAt`: the first time the attendee clicks either Phase 3 finish
  action. It is recorded even when they choose no options and is not changed by
  later edits to their selections.

## BoothCheckins
| id | attendeeId | phone | name | boothId | boothName | checkedInBy | checkedInAt | rating | note | extraData |
|---|---|---|---|---|---|---|---|---|---|---|

- One row per booth visit.
- `checkedInBy`: `"self"` (attendee's own phone) or `"staff-kiosk"`.
- `extraData`: JSON string, shape depends on the booth (e.g. `{"score":300}` for trivia, `{"votedFor":"Way Maker"}` for the song booth, `{"answers":{...}}` for the story booth).
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
- `message`: optional booth-leader text, limited to 500 characters.
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

## Optional Node/Render live export

When the event app continues using the Node/Render backend, it can mirror a
complete read-only snapshot into this bound spreadsheet by posting to:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec/importNodeSnapshot
```

Add a separate `EXPORT_KEY` value under **Apps Script → Project Settings →
Script Properties**, then configure the same secret only on the Node/Render
service. This is intentionally not the `ORGANIZER_KEY`, and it must never be
placed in browser JavaScript or a public URL.

The payload is:

```json
{
  "exportKey": "server-only secret",
  "snapshot": {
    "generatedAt": "2026-07-18T20:15:00.000Z",
    "dataResetAt": "initial",
    "tabs": {
      "Attendees": { "headers": [], "rows": [] },
      "BoothResults": { "headers": [], "rows": [] },
      "SignUps": { "headers": [], "rows": [] },
      "TriviaAnswers": { "headers": [], "rows": [] },
      "HeavenConfirmations": { "headers": [], "rows": [] },
      "SongVotes": { "headers": [], "rows": [] },
      "ExportMeta": { "headers": [], "rows": [] }
    }
  }
}
```

Every `headers` array must exactly match the corresponding schema below, in
the same order. Every row is an array with exactly the same number of cells.
The importer rejects missing, renamed, reordered, or additional tabs and
columns. It validates the whole snapshot and holds one script lock across all
seven replacements. Each tab's complete new matrix is bulk-written before its
stale trailing rows or obsolete extra columns are cleared, so a failed write
cannot blank that tab's last good export. A failure on a later tab can
temporarily leave earlier tabs on the new generation and later tabs on the old
one. `Live_ExportMeta` is written last: its `generatedAt` value is the commit
marker for a complete snapshot and does not advance after an earlier failure.
Wait for the protected export card to recover before treating all tabs as one
consistent snapshot. Removing a selection or resetting Node data still removes
stale Sheet rows after a successful retry. Formula-like strings are stored as
text.

Logical payload names are written to isolated physical tabs so this export
cannot collide with the tabs used when Apps Script itself is the app backend:

| Payload tab | Physical Sheet tab |
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

### Live_BoothResults

| id | attendeeId | name | phone | raffleNumber | wristbandColor | boothId | boothName | checkedInBy | checkedInAt | sessionNumber | runId | runNumber | score | correctCount | answeredCount | totalQuestions | votedFor | featuredWinner | extraData |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

`extraData` contains only allowlisted operational metadata. Attendee-entered
Story answers and Art reflections stay out of the Sheet mirror.

### Live_SignUps

| id | attendeeId | name | phone | raffleNumber | wristbandColor | optionId | optionTitle | submittedAt | confirmedInPerson | confirmedBy | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|---|---|

### Live_TriviaAnswers

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | questionId | questionNumber | answerIndex | isCorrect | answeredAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Live_HeavenConfirmations

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | action | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|

### Live_SongVotes

| id | attendeeId | name | raffleNumber | wristbandColor | sessionNumber | runId | runNumber | songTitle | votedAt | updatedAt |
|---|---|---|---|---|---|---|---|---|---|---|

### Live_ExportMeta

| key | value |
|---|---|

`Live_ExportMeta` records the snapshot schema version, `generatedAt`,
`dataResetAt`, and each data tab's row count. It is written last and its
`generatedAt` is the complete-snapshot commit marker. Array/object fields in
the other tabs are serialized JSON text rather than nested Sheet values.
