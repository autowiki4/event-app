# QR codes

Instead of static image files, QR codes are generated **inside the app**
at `web/organizer/qr-codes.html` — open it in a browser (via the demo
server or your real hosted URL) and it builds a QR code on the fly for
the entry page and each self-service booth, using whatever base URL you
type in (defaults to wherever the page is currently running).

Requires an internet connection the first time it loads (it pulls a small
QR-drawing library from a CDN) — after that your browser typically caches
it.

Jump to **Steps** below if you just want to print codes right now; the
**Why this way** section explains the reasoning if you're curious.

## What needs a code

- **Entry QR** (Phase 1) → `phase1-entry/index.html` — one copy, printed at the door.
- **Booth QRs** (self-service only) → one per booth: Can You Draw Heaven?, Bible Bowl, The Sower Live.
- **No code needed** for Art Therapy Table or The New Song in Nashville — those are staff-run kiosks; there's nothing for an attendee to scan.

Phase 2 and Phase 3 now also have independent attendee links
(`phase2-booths/hub.html` and `phase3-signup/index.html`). For local testing,
open those URLs directly. Their deployment QR cards are intentionally deferred
until the app has a real public URL; the current generator remains unchanged.

## Steps

1. Get the app running somewhere reachable — for the demo, that's `http://localhost:3000` (or your machine's LAN IP if scanning from a real phone on the same Wi-Fi, e.g. `http://192.168.1.42:3000`); for the real event, that's wherever you deploy it (see repo README for hosting options).
2. Open `organizer/qr-codes.html` on that same host.
3. Confirm/edit the base URL field, click **Regenerate codes**.
4. Print the page (`Cmd/Ctrl+P` — it's laid out to print cleanly, one card per code).
5. Re-print if the base URL changes later (e.g. moving from a demo laptop to the real production URL).

## Why this way

An alternative would be a handful of pre-made PNG images checked into the
repo. That falls apart the moment the URL changes — a QR code baked in
during development would point at `localhost`, which is useless once this
is hosted somewhere real for the actual event. Generating them from the
live page instead means they always encode whatever URL you're actually
running on, demo or production, without anyone needing to regenerate
image files by hand.
