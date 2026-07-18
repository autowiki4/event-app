# Connect the Node app directly to Google Sheets

The current event app exports from the Node/Render service directly through
the Google Sheets API. **Apps Script is no longer part of the export path.**
Keep `web/shared/config.js` on the same-origin Node API:

```js
API_BASE_URL: "/api",
```

The Node JSON database remains the source of truth. The Sheet is a live,
best-effort mirror containing attendee names, phone numbers, In person/Online
status, raffle numbers, selected colors, booth visits, optional extra-booth or
Connections choices, Draw Heaven confirmations, and Phase 3 selections.
Restrict its access and decide retention/deletion ownership before using real
attendee data.

## Access required

You need a Google account that can:

- create or select a Google Cloud project;
- enable the Google Sheets API;
- create a dedicated service account and download one JSON key; and
- share the destination spreadsheet with that service account as **Editor**.

The service account does not need a Google Cloud project role, Workspace Admin
role, domain-wide delegation, Admin SDK, Meet API, Drive API, OAuth consent
screen, or Apps Script deployment. Direct access comes from sharing only the
chosen spreadsheet with the service account's `client_email`.

## Set up the live export

### 1. Create or choose the spreadsheet

Create a blank spreadsheet and give it a restricted-access name such as
`Event Operations Data`. Copy the spreadsheet ID from its URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

Copy only the value between `/d/` and `/edit`, not the whole URL.

### 2. Enable the Sheets API

In [Google Cloud Console](https://console.cloud.google.com/), select the project
that will own the service account. Open **APIs & Services → Library**, find
**Google Sheets API**, and enable it.

### 3. Create a dedicated service account and JSON key

Open **IAM & Admin → Service Accounts**, create a service account such as
`event-app-sheets-export`, and skip optional project-role assignment. Open the
new account, choose **Keys → Add key → Create new key → JSON**, and download the
file.

The JSON key is a credential. Do not paste it into GitHub, browser code, a
public URL, Slack, or this repository. Store the original securely and delete
or rotate the key after the event according to the team's retention plan.
Leave the downloaded file outside this repository (for example in Downloads)
and inspect `git status --short` before committing; Google's default key
filename is project-specific and cannot be safely covered by one narrow ignore
pattern.

### 4. Share the exact spreadsheet

Open the downloaded JSON locally, copy its `client_email`, then share the
destination spreadsheet with that address as **Editor**. Sharing a folder or
granting the service account a broad project role is unnecessary.

### 5. Encode the JSON for Render

On macOS, this copies the entire JSON file as one-line base64, which avoids
multiline private-key formatting problems in an environment variable:

```bash
openssl base64 -A -in "/path/to/service-account-key.json" | pbcopy
```

Replace the example path with the downloaded key's actual path. Do not run the
command from a shared terminal recording or paste its output anywhere except
the secret Render environment variable.

### 6. Configure Render

On the same Render web service that runs `demo-server/server.js`, add:

```text
EVENT_APP_GOOGLE_SHEET_ID=the-id-between-/d/-and-/edit
EVENT_APP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=the-base64-value-from-step-5
```

Optional tuning values can stay at their defaults:

```text
EVENT_APP_SHEETS_EXPORT_DEBOUNCE_MS=3000
EVENT_APP_SHEETS_EXPORT_TIMEOUT_MS=10000
```

Delete the retired Apps Script variables if they still exist:

```text
EVENT_APP_SHEETS_EXPORT_URL
EVENT_APP_SHEETS_EXPORT_KEY
```

Choose **Save and deploy**. Clearing Render's build cache is not required for
an environment-variable change. The frontend URL and `API_BASE_URL` do not
change.

### 7. Verify the connection

Open **Staff portal → Overall Organizer**. The **Google Sheets export** card
should change from **Not connected** to **Ready** or **Up to date**. Choose
**Sync now**, then confirm the spreadsheet has these app-managed tabs:

- `Live_Attendees`
- `Live_BoothResults`
- `Live_SignUps`
- `Live_TriviaAnswers`
- `Live_HeavenConfirmations`
- `Live_SongVotes`
- `Live_ExportMeta`

Register one throwaway attendee, choose In person or Online, assign a color,
and select one Phase 3 option. To verify the extended flow, use simulated time
at 4:50 and choose an unvisited extra booth or Connections. After the short
debounce, confirm the corresponding rows update. Keep
manual notes on separate tabs: each successful sync fully replaces values in
the seven `Live_*` tabs.

`Live_TriviaAnswers` and `Live_SongVotes` intentionally remain header-only.
Bible Bowl rankings and New Song tallies stay in their protected booth-leader
portals.

After the direct exporter reaches **Up to date**, retire the old Apps Script
writer: open **Apps Script → Deploy → Manage deployments**, archive/delete the
old Web App deployment, and remove its `EXPORT_KEY` Script Property. This
prevents an unused public endpoint or a second writer from remaining active.

## Synchronization and reset behavior

- Node saves the persistent JSON database before queuing a Sheet update. A
  Google outage never changes a successful attendee save into an error.
- Bursts are coalesced, access tokens are cached, and the newest complete
  snapshot retries automatically after a failed delivery.
- Missing `Live_*` tabs are created automatically. All seven replacements,
  stale-row clearing, and required grid expansion happen in one atomic Sheets
  API batch, so a rejected request leaves the prior Sheet snapshot intact.
- The protected organizer status never exposes the spreadsheet ID,
  service-account email/key, or Google access token.
- **Clear all attendee data** resets Node first. The next successful sync keeps
  the `Live_*` headers, clears their old data rows, and updates
  `Live_ExportMeta` with the reset marker and zero row counts.
- Unrelated spreadsheet tabs are never changed.

The reset does **not** create a CSV, duplicate spreadsheet, or historical
archive. If rehearsal/event history must be retained, download the relevant
tabs as CSV, make a copy of the spreadsheet, or connect a new shared
spreadsheet **before** clearing attendee data. After clearing, wait until the
organizer card says **Up to date** before treating the Sheet as empty.

## Troubleshooting

- **Not connected** — confirm both required Render variables exist on the same
  web service and choose **Save and deploy**.
- **Apps Script variables are no longer used** — remove the old URL/key and add
  the new Sheet ID and base64 service-account JSON variables.
- **Access was denied** — confirm the Google Sheets API is enabled in the
  service account's project and share the exact spreadsheet with its
  `client_email` as **Editor**.
- **Spreadsheet was not found** — use only the ID between `/d/` and `/edit`,
  then check sharing again.
- **Authentication failed** — recreate or re-encode the JSON key and replace
  the Render secret; never edit the private-key text by hand.
- **No live tabs yet** — choose **Sync now** and inspect the sanitized error in
  Overall Organizer.
- **Old rows remain after reset** — the empty replacement is queued or failing;
  do not manually delete rows until the organizer export status is **Up to
  date**.
- **Key creation or sharing is blocked** — an organization policy may prohibit
  service-account keys or sharing with that address. Use a project and Sheet
  where those actions are allowed, or ask the Workspace/Cloud administrator
  for the approved equivalent; do not work around the policy in code.

## Legacy `Code.gs` adapter

`Code.gs` remains in this repository only for compatibility testing of an
older, limited attendee/staff backend. Pointing `API_BASE_URL` at its `/exec`
URL is not the current deployment: it lacks the Node shared clock, full reset,
and specialized leader-paced booth controllers. Its retired Node snapshot
import route is not needed for the direct Sheets API export and should not be
deployed as a second writer.

See `SHEET_SCHEMA.md` for the exact `Live_*` columns and the separate legacy
adapter schemas.
