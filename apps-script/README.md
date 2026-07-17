# Connecting the Node app to a live Google Sheet

The recommended setup keeps the full event app on the same-origin Node/Render
`/api` backend and uses this Apps Script only as a protected export sink. That
preserves the shared timer, protected reset, and leader-paced Bible Bowl, Draw
Heaven, Art Therapy, and New Song workflows while giving operations a live Sheet containing
attendees, results, and Phase 3 selections.

The Node JSON database remains the source of truth. Apps Script receives a
debounced full snapshot and replaces seven `Live_*` tabs. Do **not** point
`web/shared/config.js` at Apps Script for this arrangement.

## Access required

You need a Google account that can:

- create and edit a Google Sheet;
- open **Extensions → Apps Script** for that Sheet; and
- deploy the script as a Web App that the Render server can reach.

This export does not require Google Admin SDK, Google Meet API, domain-wide
delegation, or a service-account key. If your Workspace policy does not allow a
Web App to be reached without an interactive Google login, ask the Workspace
administrator for an approved deployment path before enabling the export.

## Set up the Sheet export

### 1. Create the Sheet

Create a blank spreadsheet at [sheets.google.com](https://sheets.google.com).
Choose a clear restricted-access name, such as `Event Operations Data`.

### 2. Add the script

Open **Extensions → Apps Script**. Delete the placeholder function, copy the
entire contents of this repository's `apps-script/Code.gs`, paste it into the
editor, and save.

### 3. Create a separate export secret

Generate a long random value in a password manager. In Apps Script, open
**Project Settings → Script Properties** and add:

```text
Property: EXPORT_KEY
Value:    your-long-random-export-secret
```

`EXPORT_KEY` is only for the Node-to-Sheet export. Do not reuse the organizer
key and do not put either secret in a URL or any file under `web/`.

### 4. Deploy the Web App

Choose **Deploy → New deployment → Web app** and set:

- **Execute as:** Me
- **Who has access:** Anyone

Authorize the script when Google prompts, then copy the Web App URL ending in
`/exec`. The export endpoint itself still rejects requests without the matching
`EXPORT_KEY`.

### 5. Configure Render

Add these environment variables to the same Render service that runs the Node
app:

```text
EVENT_APP_SHEETS_EXPORT_URL=https://script.google.com/macros/s/YOUR_ID/exec
EVENT_APP_SHEETS_EXPORT_KEY=the-same-value-as-EXPORT_KEY
```

Optional tuning:

```text
EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS=3000
EVENT_APP_SHEETS_EXPORT_TIMEOUT_MS=10000
```

Keep this frontend configuration unchanged:

```js
API_BASE_URL: "/api",
```

Redeploy or restart the Render service after setting the environment variables.

### 6. Verify it

Open **Staff portal → Overall Organizer**. The **Google Sheets export** card
should change from **Not connected** to **Ready** or **Up to date**. Choose
**Sync now**, then open the Sheet and confirm these tabs exist:

- `Live_Attendees`
- `Live_BoothResults`
- `Live_SignUps`
- `Live_TriviaAnswers`
- `Live_HeavenConfirmations`
- `Live_SongVotes`
- `Live_ExportMeta`

Register one throwaway attendee, assign a wristband, and choose a Phase 3
option. After the short debounce, the corresponding rows should update without
refreshing the Sheet.

## How synchronization behaves

- Node saves the local/persistent JSON database first. A Sheet failure never
  changes a successful attendee or staff response into an error.
- Bursts are coalesced and only the newest pending complete snapshot is sent.
- The exporter retries failed delivery and the protected dashboard displays a
  sanitized status; it never displays the Web App URL or export secret.
- Full replacement prevents duplicate rows and removes stale selections after
  an attendee changes their Phase 3 choices.
- `Live_ExportMeta.generatedAt` is written last and is the commit marker for a
  complete snapshot. If an import fails between tabs, the export card reports
  an error and that marker does not advance; wait for the automatic retry or
  choose **Retry now** before treating the tabs as one consistent snapshot.
- Free-text Story answers and Art reflections are intentionally omitted from
  `Live_BoothResults.extraData`; only allowlisted operational metadata is
  mirrored.
- **No thanks, finish** creates no `Live_SignUps` row, but the attendee still
  has `phase3CompletedAt` in `Live_Attendees`.
- **Clear all attendee data** is a deletion boundary. The next successful sync
  clears the exported data rows as well.

The Sheet is a live operational mirror, not an immutable backup. Before using
real attendee data, decide who may access names, phone numbers, raffle numbers,
activity results, and selections, and define retention/deletion ownership.

## Updating `Code.gs`

Saving a script edit does not update an existing Web App deployment. Use:

1. **Deploy → Manage deployments**
2. Select the pencil/edit icon
3. Choose **New version**
4. Choose **Deploy**

The `/exec` URL stays the same.

## Troubleshooting

- **Not connected** — one or both Render environment variables are absent.
- **Needs attention** — open the status card, verify the Render URL ends in
  `/exec`, confirm `EXPORT_KEY` matches exactly, and ensure the Web App is
  reachable by the Render service.
- **Unknown action** — deploy a new Apps Script version containing the current
  `Code.gs`.
- **No live tabs yet** — choose **Sync now** after connecting; the tabs are
  created on the first successful import.
- **Old rows remain after a reset** — the Sheet delivery failed or is still
  queued. Do not delete individual rows as a substitute for checking the
  protected export status.
- **Organization blocks “Anyone” deployments** — the webhook cannot work until
  Workspace administrators approve a non-interactive route. A future direct
  Sheets API/service-account integration is the alternative, but it requires a
  Cloud project, the Sheets API, credential management, and sharing the Sheet
  with that service account.

## Legacy Apps Script backend mode

`Code.gs` still includes the older attendee and staff API actions for
compatibility testing. Pointing `API_BASE_URL` directly at its `/exec` URL is
not the recommended current deployment: that mode lacks the Node shared clock,
full reset, and specialized leader-paced run controllers. Use the export-sink
setup above for the full experience.

See `SHEET_SCHEMA.md` for the exact export columns and the separate legacy tab
schemas.
