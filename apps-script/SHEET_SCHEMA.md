# Sheet schema

Reference for the four tabs `Code.gs` creates automatically — you don't
need to make any of these by hand. For how to actually deploy `Code.gs`
and get this Sheet up and running, see `README.md` in this same folder.

## Attendees
| attendeeId | aliasIds | name | phone | raffleNumber | wristbandConfirmedAt | registeredAt |
|---|---|---|---|---|---|---|

- `attendeeId`: UUID generated in the browser at Phase 1 (or by a kiosk if someone skips Phase 1).
- `aliasIds`: JSON array of any other attendeeIds later linked to this same phone number.
- `phone`: digits only, no formatting.
- `raffleNumber`: assigned once, server-side, via a locked counter in the `Meta` tab.

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

## Meta
| key | value |
|---|---|

- Currently just `raffleCounter` — the last raffle number handed out.

## Exporting "the file with names and numbers"

The `Attendees` tab already *is* that file — File > Download > CSV in
Google Sheets gives you name + phone + raffle number for everyone,
any time, with no extra step.
