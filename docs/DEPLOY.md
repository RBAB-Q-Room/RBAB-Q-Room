# Deploying Waiting Guest on Google (step by step)

You need: a Google account (ideally a hotel one), and about 20 minutes. No coding.
The whole system lives in **one Google Sheet** (the database) plus **one Apps Script** (the app).

Everything you paste comes from the folder `dist/apps-script/` in this repository:

| File | What it is |
| --- | --- |
| `Code.gs` | the server (all the logic) |
| `Index.html` | the screens (Reception, Rooms Controller, Admin, Guest) |
| `appsscript.json` | settings (time zone Dubai, public web app) |

## 1. Create the Sheet and the script

1. Go to **sheets.google.com** and create a blank spreadsheet. Name it `Waiting Guest`.
2. Menu **Extensions → Apps Script**. A code editor opens.
3. On the left, turn on **Project Settings (gear) → "Show appsscript.json manifest file in editor"**.
4. Open `appsscript.json` in the editor, delete what is there, paste the contents of `dist/apps-script/appsscript.json`.
5. Open `Code.gs`, delete everything, paste the contents of `dist/apps-script/Code.gs`.
6. Click **+ next to Files → HTML**, name it exactly `Index` (Google adds `.html`), and paste the contents of `dist/apps-script/Index.html`.
7. Click the disk icon to **Save**.

## 2. Set up the database (once)

1. In the editor toolbar choose the function **`setup`** and click **Run**.
2. Google asks you to authorise: **Review permissions → choose your account → Advanced → Go to Waiting Guest (unsafe) → Allow**. This is normal for your own script.
3. Open **View → Logs** (or the Execution log). Copy the **admin username and password** it prints. It is shown **once**.
4. Go back to the Sheet: you will see new tabs (Users, Reservations, Rooms, WaitingGuests, and so on).

> Do not edit the tab names or the header row. You may edit the **Config**, **GuestContent** and **RoomTypes** tabs (see "Settings" below).

## 3. Check it works in Google's real environment

Run the function **`runSelfTest`**. It creates a temporary guest, walks it through the full journey, checks the guest page hides private data, then deletes everything it made. The log must end with `ALL CHECKS PASSED`. If any line says FAIL, send me that log.

## 4. Publish the web app

1. Click **Deploy → New deployment**. Type: **Web app**.
2. **Execute as: Me**. **Who has access: Anyone**.
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

That URL is the staff sign-in page. Guest QR links are the same URL plus `?t=...`, created automatically.

> After you change the code later, use **Deploy → Manage deployments → Edit → New version**, so the URL stays the same.

## 5. First sign-in

1. Open the Web app URL. Sign in as `admin` with the password from step 2.
2. Click **Password** (top bar) and change it.
3. **Users → Add a user**: create the Reception and Rooms Controller logins. The password is shown once, so copy it and give it to the person privately.
4. **Import rooms**: upload your rooms CSV (room number, room type, building, floor, housekeeping status).
5. **Import arrivals**: upload today's arrivals report from Opera saved as CSV. You see a preview first, and nothing is saved until you confirm.

## Every day

Import the day's arrivals (Admin → Import arrivals). Re-importing updates existing reservations by confirmation number, so importing again later in the day is safe. If a reservation is missing, Reception uses **Enter it manually**.

## Settings

Since version 1.0, admins change everything below inside the app (**Settings** and **Guest page** tabs); you do not need to open the Sheet.

### Stored in the Sheet

* **Config**: `wg_prefix` (the "WG" in WG-0001), `hotel_website_url` (turns on the website button for guests), `hotel_map_url`, `late_warn_minutes` / `late_alert_minutes` (when a waiting timer turns amber/red), `guest_welcome`.
* **GuestContent**: the cards guests see under "While you wait". Replace the placeholder text with the hotel's approved wording (pools, beach, restaurants, Wi-Fi, guest services). Set `placeholder` to blank once real. Set `active` to blank to hide a card. Columns `title`, `body`, `note` are English; `title_ar`, `body_ar`, `note_ar` (Arabic), `_ru` (Russian) and `_de` (German) hold the translations. A blank translation shows the English text.
* **Config**: `guest_welcome`, `guest_welcome_ar`, `guest_welcome_ru`, `guest_welcome_de` are the welcome line in each language.

## Languages

Reception picks the **Guest language** (English, Arabic, Russian or German) when creating a Waiting Guest. It is pre-selected from the reservation's nationality when the arrivals file has one (for example AE or Egypt gives Arabic, RU gives Russian, DE, AT or CH gives German), and Reception can always change it, also later with **Edit details**. The guest's QR page opens in that language, with Arabic shown right-to-left. Guests can switch language themselves at the top of their page, and their device remembers the choice. Staff screens stay in English.

The translations were written for this build. **Please have a native speaker of each language review them before guests see them.** The interface text is in `src/web/js/45-i18n.js`, and the resort card text is in the GuestContent tab.

## Updating an existing deployment (do this for version 1.0)

1. In the Apps Script editor, replace **all three files** with the new ones from `dist/apps-script/`: `Code.gs`, `Index` and `appsscript.json`. Replace the whole of `Code.gs`: if you added a `makeDatabase` function by hand earlier, it must go (it was callable by anyone; `setup` now creates the database itself).
2. Press **Ctrl+S**, choose **`setup`** and click **Run**. Google asks for permission again because the app now checks who is running editor-only functions (it needs to read your email address for that). Allow it. `setup` upgrades the sheet: new columns are added at the end and nothing is deleted.
3. Run **`runSelfTest`**. It must end with `ALL CHECKS PASSED`.
4. **Deploy → Manage deployments → pencil → Version: New version → Deploy.** Check that **Who has access** says **Anyone**, otherwise guests scanning the QR see a Google Drive error.
5. Sign in as admin. Open **Settings** and **Guest page** to replace placeholder text and add the hotel website.

If you forget step 2, the app upgrades the sheet by itself on the first request, but the permission prompt only appears when you run something in the editor.

## Keeping the sheet fast

Run **`installNightlyArchive`** once. Each night, completed and cancelled records older than 30 days (`archive_after_days`) move to an **Archive** tab. Export from Admin → Export before that if you need them elsewhere.

## Privacy and access

* The Sheet contains guest names, phone numbers and emails. **Do not share the Sheet** with anyone who should not see them. Staff only need the web app, not the Sheet.
* Guests see only their name, WG number, confirmation number, room type and dates. Never phone, email, staff notes or the room number.
* Guest links are long random codes that cannot be guessed. Anyone holding a link can see that one guest's page.

## Things to know (limits of this platform)

* **Updates are every few seconds**, not instant. Screens check a small counter every 4 to 8 seconds and refresh when it changes.
* **Speed**: each action takes about a second. Normal for Google Apps Script.
* **Google banner**: for accounts outside Google Workspace, Google may show a small grey "This application was created by another user" bar above the guest page. It cannot be removed on this platform. Options later: run it under a Google Workspace account, or embed the page on the hotel's own website.
* **Quotas**: Google limits total script run time per day and simultaneous users. It is fine for one hotel's front desk. If you see "busy" messages regularly, tell me and we move to a proper server.
* **Sign-in**: staff use usernames and passwords stored (hashed) in the Sheet, because guests must be able to open the page without any Google account.

## If something goes wrong

* **"Not configured" or a tab is missing**: run `setup` again. It is safe and never deletes data.
* **Locked out of admin**: in the editor run `createUserFromEditor('newadmin', 'Full Name', 'admin')` and read the log.
* **A guest link says "not valid"**: the guest record was archived or the link was copied wrongly. Reception can search the guest and show the QR again.
