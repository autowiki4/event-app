# Deploying the production backend

This turns `Code.gs` into a live web address that the app can talk to,
backed by a real Google Sheet instead of the local demo server's
`db.json`. You only need a free Google account — no billing, no server to
rent, no command line required for this part.

Do this once you're happy with how the app behaves against the local demo
server (`../demo-server/README.md`) and are getting ready for the actual
event.

## What you'll end up with

- A Google Sheet that fills itself in as people use the app (attendees,
  booth check-ins, sign-ups) — see `SHEET_SCHEMA.md` for exactly what
  columns show up.
- A URL (looks like `https://script.google.com/macros/s/AKfycb.../exec`)
  that the app's pages call instead of `localhost`.

## Step-by-step

**1. Create the Sheet.**
Go to [sheets.google.com](https://sheets.google.com), create a new blank
spreadsheet. Name it whatever you like (e.g. "EventDB") — the name
doesn't matter to the code.

**2. Open the script editor.**
In the Sheet, click **Extensions → Apps Script**. A new tab opens with a
default file called `Code.gs` containing a placeholder `myFunction()`.

**3. Replace the placeholder code.**
Select everything in that editor (Ctrl/Cmd+A) and delete it. Open this
repo's `apps-script/Code.gs` file, copy its entire contents, and paste it
into the Apps Script editor.

**4. Save.**
Ctrl/Cmd+S, or the save icon. You can rename the project (top left, "Untitled
project") to something like "Event App Backend" if you want — optional.

**5. Deploy it as a Web App.**
Click **Deploy → New deployment**. If it asks for a deployment type,
click the gear icon and choose **Web app**. Then set:
- **Execute as:** Me (your Google account)
- **Who has access:** Anyone

Click **Deploy**.

**6. Authorize it.**
The first time, Google will ask you to authorize the script. This part
trips people up because of a scary-looking warning — here's exactly what
to click:
1. A popup asks you to choose an account — pick your Google account.
2. You'll see "Google hasn't verified this app." This is normal for a
   script you just wrote yourself — click **Advanced** (small text, bottom
   left), then click **Go to [your project name] (unsafe)**.
3. Click **Allow** on the permissions screen (it's asking to let the
   script read/write this specific spreadsheet — that's expected, it's
   how it stores attendee data).

**7. Copy the Web app URL.**
After deploying, a dialog shows a URL ending in `/exec`. Copy it — you'll
need it in the next step. (You can always find it again later under
**Deploy → Manage deployments**.)

**8. Point the app at it.**
Open `../web/shared/config.js` in this repo and change:

```js
API_BASE_URL: "/api",
```

to:

```js
API_BASE_URL: "https://script.google.com/macros/s/YOUR_ID_HERE/exec",
```

using the URL you copied. Save the file.

**9. Test it.**
Paste your URL with `/dashboardData` on the end into a browser address
bar, e.g.:

```
https://script.google.com/macros/s/YOUR_ID_HERE/exec/dashboardData
```

You should see plain JSON like `{"totals":{"registered":0,...}}`. If you
see that, it's working — go host `../web/` somewhere (see the main
`README.md`'s "Going from demo to the real event" section) and you're
live.

## Redeploying after you edit `Code.gs` again

Editing and saving the file in the Apps Script editor does **not**
automatically update the live URL — Apps Script deployments are
versioned. To push a change live:

1. **Deploy → Manage deployments.**
2. Click the pencil/edit icon on your existing deployment.
3. Under **Version**, choose **New version**.
4. Click **Deploy**.

The `/exec` URL stays the same — you don't need to update `config.js`
again after the first time, only redeploy a new version whenever you
change `Code.gs`.

## Troubleshooting

- **"Google hasn't verified this app"** — expected, see step 6. This
  warning appears because it's a script you own but haven't published for
  public verification; it's not a sign anything is wrong.
- **The test URL from step 9 shows an error page instead of JSON** — make
  sure you included the action name after `/exec` (e.g. `/dashboardData`,
  not just `/exec` by itself — hitting bare `/exec` will return an
  "unknown action" JSON error, which is actually a sign it's *working*,
  just missing the action name).
- **Changes you made aren't showing up** — you edited `Code.gs` but didn't
  create a **new version** under Manage deployments (see above). Apps
  Script won't auto-update a live deployment.
- **"Exception: You do not have permission to call..."** — usually means
  the authorization in step 6 didn't complete, or you're using a
  different Google account than the one that authorized it. Redo step 6.
- **Attendee data isn't showing up in the Sheet's visible tabs** — the
  tabs (`Attendees`, `BoothCheckins`, `SignUps`, `Meta`) are created
  automatically the first time each one is used, not when you first
  deploy. If you deployed and tested `/dashboardData` before anyone
  registered, you may only see some tabs at first — that's expected.
- **Want to see the raw data as it comes in?** Just open the Google Sheet
  itself in a browser tab and leave it there — new rows appear as
  attendees interact with the app, no refresh needed (Sheets auto-updates
  from script writes).

## See also

- `SHEET_SCHEMA.md` — exact column layout created in each tab.
- `../demo-server/README.md` — the local equivalent of this backend, used
  for development and rehearsal.
- `../README.md` — the full "going from demo to the real event" checklist
  this deployment is one step of.
