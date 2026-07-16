# Sheet schema

Reference for the five tabs `Code.gs` creates automatically — you don't
need to make any of these by hand. For how to actually deploy `Code.gs`
and get this Sheet up and running, see `README.md` in this same folder.

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

## SignUps
| id | attendeeId | phone | name | optionId | optionTitle | email | stars | comment | submittedAt | confirmedInPerson | confirmedBy | confirmedAt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

- One row per option an attendee selected in Phase 3.
- `confirmedInPerson` starts `false` — the organizer dashboard flips it to `true` once staff actually talk to that person at the relevant table.

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

The `Attendees` tab already *is* that file — File > Download > CSV in
Google Sheets gives you name + phone + raffle number for everyone,
any time, with no extra step.
