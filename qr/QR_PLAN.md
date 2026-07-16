# QR plan for the unified attendee flow

The timed experience no longer needs a different public QR at every booth.
Phase 1 assigns the wristband color and continues directly into one attendee
hub, which keeps the same identity through all three 20-minute sessions, Phase
3, and the final waiting/message screen.

`web/organizer/qr-codes.html` currently generates three cards from a base URL:

1. **Attendee entry · Start here** → `phase1-entry/index.html`
2. **Attendee booth schedule · Return link** → `phase2-booths/hub.html`
3. **Booth leaders · Staff only** → `phase2-staff/index.html`

It loads its QR-rendering library from a CDN, so the generator needs internet
access when the library is not already cached.

## Recommended placement

### Entry code

Print the Phase 1 code at registration. This is the normal attendee starting
point. After staff assign and confirm a wristband color, Phase 1 opens the
unified hub directly; the attendee does not need another scan or an
intermediate Phase 1 completion link.

### Return-to-schedule code

Place a small number at the help desk or central navigation signs. It is a
recovery path for someone who closed the tab or changed devices, not a code
that must be scanned at each booth. On a new device, the hub asks once for the
Phase 1 name and raffle number, then restores the correct color route. The
active route row can be reopened from the hub until its session ends, including
after that visit has been marked complete.

### Booth-leader code

Keep this card in staff materials rather than public attendee signage. It
opens the directory for the five booth portals; the leader still has to enter
the organizer key. The key is not embedded in the QR or URL.

All staff portals currently share one organizer key, so possession of that key
is broader than one booth. A final production plan should replace this with
appropriate roles or booth-specific credentials.

## Codes not needed in the normal flow

- **No five attendee booth codes:** the timer and wristband route choose the
  active booth inside `hub.html`.
- **No required Phase 3 code:** the hub reveals Phase 3 after all three
  attendee completion taps are saved, or at 4:10 PM even if some visits remain
  unmarked. Save and **No thanks** continue into the same **DON'T GO YET** or
  main-message screen. A separate Phase 3 recovery sign is optional.
- **No organizer key in a code:** credentials must never be placed in a URL.
- **No preview values:** `?preview=...` is only for local rehearsal. It
  propagates through the attendee journey for testing and should never be
  printed.

The direct `phase2-booths/booth-*.html` and kiosk pages remain optional
fallback tools. Do not print them as the primary attendee route unless the
event team deliberately switches to the fallback operating model.

## Generate and print

1. Deploy the `web/` folder to its final HTTPS public host.
2. Open `organizer/qr-codes.html` on that host.
3. Confirm the base URL uses the final public origin, not `localhost` or a
   temporary preview domain.
4. Choose **Regenerate codes**.
5. Scan every printed code with at least one iPhone and one Android phone.
6. Complete a full test: Phase 1 → direct hub continuation → three completion
   taps → reopen the active row → Phase 3 → early **DON'T GO YET** countdown →
   4:10 PM main message, plus the missed-tap fallback and staff directory
   authentication.
7. Print only after the URL and routes are frozen.

If the public origin changes, regenerate and reprint every card. A QR encodes
the literal URL and cannot follow a moved deployment unless the old host
redirects it.

## Event-day checklist

- Entry signage clearly says **Start here**.
- Return signage says it is for reopening the booth schedule, not selecting a
  booth.
- Staff QR material is not mixed into attendee signage.
- A manual route matrix is available if Wi-Fi or the backend fails.
- Staff know that the mock schedule currently assumes July 18, 2026 in
  Nashville and have confirmed the deployed schedule before doors open.
