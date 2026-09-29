# Waiting Guest

Digital Waiting Guest system for Rixos Bab Al Bahr. Reception creates a Waiting Guest once; the system generates the Waiting Guest number and a unique QR code; Rooms Controller manages the live queue; the guest follows their room status on their QR page; Reception completes the record.

**Development build. All reservation and room data is mock. There is no Opera Cloud integration.**

## Run

Requires Node 22.13+ (uses built-in `node:sqlite`; one npm dependency, `qrcode-generator`).

```
npm install
npm start          # http://localhost:3000
npm test
```

On first start a database is created in `data/` and seeded with mock reservations (confirmation numbers `51840217` to `51840371`, arriving today) and mock rooms. Two dev users (`reception`, `controller`) are created with **random passwords printed to the console** and saved to `data/dev-credentials.txt` (git-ignored). Set `WG_DEV_PASSWORD` to use one shared dev password instead. Reset with `npm run seed`.

## Test the journey

1. Sign in as `reception`, search `51840217`, add associate/luggage tag, **Create Waiting Guest**. A WG number and QR appear.
2. Open the guest link (button on the success panel) on a phone or second tab.
3. Sign in as `controller` in another browser: the guest is in the queue. Assign a room, mark being prepared, mark ready. The guest page and Reception update live.
4. Back in Reception: search by name, confirmation or WG number, verify, **Complete**.

## Architecture

```
server/
  index.js            HTTP server, routing, static files, SSE, security headers
  waiting.js          Waiting Guest service: rules, transitions, history, metrics
  db.js               SQLite schema (users, sessions, reservations, rooms,
                      waiting_guests, status_history, counters)
  auth.js             scrypt passwords, hashed session tokens, HttpOnly cookies
  providers/          reservations.js and rooms.js: the ONLY readers of mock data
  guestContent.js     "While you wait" content (placeholders, see below)
public/               vanilla HTML/CSS/JS, same approach and design tokens as Room Guide
tests/                end-to-end API journey tests
```

- **One source of truth:** the `waiting_guests` row. Every write goes through `waiting.js`, logs to `status_history`, and emits a change event pushed to browsers over SSE (with polling fallback). Nothing is duplicated per screen.
- **Opera later:** implement the two provider interfaces against Opera and select them in `createApp`. Waiting Guest logic, routes and UI do not change.
- **Timestamps:** guest arrival, created, room assigned, preparation started, room ready, guest notified (QR updated), guest returned, completed. `GET /api/metrics` computes averages from real records only; nothing is fabricated.
- **Statuses:** Waiting, Room Assigned, Room Being Prepared, Room Ready, Guest Returned, Completed. Rooms Controller moves through Ready; Reception marks returned and completed. Ready requires an assigned room and an explicit action.

## Security

- QR links are `/waiting/<192-bit random token>`. No guest data or database ids in URLs.
- The guest API returns only name, WG number, confirmation, room type, dates and phase. Never phone, email, associate, luggage tag, preferences, remarks, room number or internal ids (covered by tests).
- Staff routes require a session and the right role. Login is rate limited, cookies are HttpOnly and SameSite=Strict, CSP and other headers are set, and cross-origin writes are rejected.
- No secrets in the repo. `.env` and the database are git-ignored.

## Content to replace

`server/guestContent.js` holds placeholder resort content (pools, beach, dining, activities, Wi-Fi, guest services, all-inclusive wording). No hours, policies or contacts are invented. The map link is the one used by Room Guide. Set `WG_HOTEL_WEBSITE` to enable the website button.

## Configuration

`PORT`, `WG_DB_FILE`, `WG_PUBLIC_URL` (base URL encoded in QR codes; set it to an address phones can reach), `WG_PREFIX`, `WG_PAD`, `WG_SESSION_HOURS`, `WG_HOTEL_WEBSITE`, `WG_DEV_PASSWORD`.

## Not built (by design)

WhatsApp, SMS, Opera Cloud, real hotel data, payments, production deployment.
