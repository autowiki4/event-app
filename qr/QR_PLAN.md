# QR codes

Instead of static image files, QR codes are generated **inside the app** at
`web/organizer/qr-codes.html` — it builds a QR code on the fly for the entry
page and each self-service booth, using whatever base URL you type in
(defaults to wherever the page is currently running). Open it, adjust the
base URL if needed, and print.

Why this way instead of pre-made PNGs: the sandbox this was built in has no
internet access to a QR-generation library, and more importantly, a QR code
baked in now would point at `localhost` — useless once you deploy somewhere
real. Generating them from the actual page, on your own machine/browser
(which does have internet), means they always encode whatever URL you're
actually running on.

## What needs a code

- **Entry QR** (Phase 1) → `phase1-entry/index.html` — one copy, printed at the door.
- **Booth QRs** (self-service only) → one per booth: Can You Draw Heaven?, Bible Bowl, The Sower Live.
- **No code needed** for Art Therapy Table or The New Song in Nashville — those are staff-run kiosks; there's nothing for an attendee to scan.

## Steps

1. Get the app running somewhere reachable — for the demo, that's `http://localhost:3000` (or your machine's LAN IP if scanning from a real phone on the same Wi-Fi, e.g. `http://192.168.1.42:3000`); for the real event, that's wherever you deploy it (see repo README for hosting options).
2. Open `organizer/qr-codes.html` on that same host.
3. Confirm/edit the base URL field, click **Regenerate codes**.
4. Print the page (`Cmd/Ctrl+P` — it's laid out to print cleanly, one card per code).
5. Re-print if the base URL changes later (e.g. moving from a demo laptop to the real production URL).
