# QR codes

Instead of static image files, the current QR codes are generated **inside the
app** at `web/organizer/qr-codes.html`. Open it in a browser (via the demo
server or a hosted URL) and it builds codes on the fly using whatever base URL
you type in (defaulting to wherever the page is running).

Requires an internet connection the first time it loads (it pulls a small
QR-drawing library from a CDN) — after that your browser typically caches
it.

Jump to **Current generator steps** below if you just want to inspect or print
the existing cards; the **Why this way** section explains the reasoning.

## Current generator vs. the five booth rooms

The generator implementation is intentionally unchanged for now. It currently
creates:

- **Entry QR** (Phase 1) → `phase1-entry/index.html`
- **Three original booth QRs** → Can You Draw Heaven?, Bible Bowl, and The
  Sower Live

The Phase 2 attendee design now has five separate room links:

- `phase2-booths/booth-heaven.html`
- `phase2-booths/booth-trivia.html`
- `phase2-booths/booth-story.html`
- `phase2-booths/booth-art.html`
- `phase2-booths/booth-newsong.html`

Each room has its own blank name + raffle login and welcomes the attendee to
that booth only. Art Therapy and New Song also retain their old kiosk pages as
optional staff fallbacks, but they now have attendee rooms too. Phase 3 remains
the separate `phase3-signup/index.html` link.

Updating the printable generator to represent all five room links—and deciding
whether Phase 3 also receives a printed code—is deliberately deferred until
the app is deployed and has a stable public URL. For local testing, open the
exact booth-room URLs directly and skip QR generation. The old
`phase2-booths/hub.html` route is only a compatibility notice and should not be
used as a new QR destination.

## Current generator steps (optional)

These steps are useful for testing the existing cards, but they are not the
final five-room production print plan:

1. Get the app running somewhere reachable — for the demo, that's `http://localhost:3000` (or your machine's LAN IP if scanning from a real phone on the same Wi-Fi, e.g. `http://192.168.1.42:3000`); for the real event, that's wherever you deploy it (see repo README for hosting options).
2. Open `organizer/qr-codes.html` on that same host.
3. Confirm/edit the base URL field, click **Regenerate codes**.
4. Print the page (`Cmd/Ctrl+P`—it's laid out to print cleanly, one card per
   code) only if you need the current set.
5. Re-print if the base URL changes later. Before the real event, first update
   and verify the deferred five-room QR plan against the final production URL.

## Why this way

An alternative would be a handful of pre-made PNG images checked into the
repo. That falls apart the moment the URL changes — a QR code baked in
during development would point at `localhost`, which is useless once this
is hosted somewhere real for the actual event. Generating them from the
live page instead means they encode whatever URL you're actually running on
without anyone needing to regenerate image files by hand. Waiting for the
stable deployment URL also avoids printing room codes that later point at the
wrong host or route.
