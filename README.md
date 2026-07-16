# SNDL Forex & Travels — site + admin backend

A small Node.js app with:

- **Public site** (`public/index.html`) — the marketing site with a live, view-only
  exchange-rates board (loaded from the backend, no editing controls at all).
- **Admin page** (`admin/index.html`) — a separate, unlinked page at `/admin` where
  the branch team logs in with a password to update the rates.
- **Backend** (`server.js`) — a plain Node.js server (no npm packages required)
  that stores the rates and the admin password on disk, and only lets an
  authenticated admin session change the rates.

Nobody but a logged-in admin can change the rates anymore — visitors to the
public site only ever see the current numbers.

## 1. Run it locally

You need [Node.js](https://nodejs.org) version 18 or newer. No `npm install`
is required — the server only uses Node's built-in modules.

```bash
cd sndl-forex-site
node server.js
```

You'll see something like:

```
============================================================
 First run: an admin account has been created.
 Temporary admin password (copy this now, it will not be shown again):
   sndl-7f3k9d-2ab13c
 Change it any time with: node scripts/set-admin-password.js
============================================================
SNDL Forex & Travels server running on http://localhost:3000
  Public site: http://localhost:3000/
  Admin page:  http://localhost:3000/admin
```

- Open **http://localhost:3000/** — the public site, with the rates board in
  view-only mode.
- Open **http://localhost:3000/admin** — log in with the password printed
  above, then edit currencies, buy/sell rates, and the date, and click
  **Save board**. The public site picks up the change immediately (it
  refreshes the board once a minute automatically, or on page reload).

That temporary password is only shown once, the first time the server ever
starts (it's saved, hashed, to `data/admin.json`). Change it whenever you like:

```bash
node scripts/set-admin-password.js "a-new-strong-password"
```

## 2. How the pieces fit together

```
sndl-forex-site/
├── server.js               ← the whole backend (no dependencies)
├── package.json
├── data/
│   ├── rates.json           ← current rates + date (created automatically)
│   └── admin.json           ← salted password hash (created automatically, git-ignored)
├── public/
│   └── index.html           ← public site, fetches GET /api/rates
├── admin/
│   └── index.html           ← admin login + editor, calls the API below
└── scripts/
    └── set-admin-password.js
```

**API the front-end pages use:**

| Method | Path           | Who can call it | What it does                          |
|--------|----------------|------------------|----------------------------------------|
| GET    | `/api/rates`   | anyone           | current rates + date                   |
| GET    | `/api/session` | anyone           | `{authenticated: true/false}`          |
| POST   | `/api/login`   | anyone           | checks password, sets a session cookie |
| POST   | `/api/logout`  | logged-in admin  | clears the session                     |
| PUT    | `/api/rates`   | logged-in admin  | replaces the rates + date              |

Sessions last 2 hours and are stored in server memory (an httpOnly cookie
holds only a random session id, never the password). Login attempts are
rate-limited to 5 tries per 10 minutes per IP address.

## 3. Editing site content

- **Contact details, address, phone, hours, services copy** — these are plain
  text in `public/index.html`; open it in any editor and search for the
  section you want to change (e.g. `id="contact"`).
- **Company history and team** — `public/about.html` (linked from the main
  nav as "About & Team") has two sections you'll want to fill in with real
  details before publishing:
  - `id="history"` — the founding story and a small timeline. Search for
    `[Year]` and `[City]` and replace them with your actual founding year,
    city, and milestones.
  - `id="team"` — one card per staff member. Search for `[Founder Name]`,
    `[Manager Name]`, `[Executive Name]`, `[Associate Name]` and their
    phone/email placeholders, and replace with your real team's details
    (add or remove cards as needed — each is a `<div class="ticket team-card">`
    block).
- **Logo** — already embedded as a base64 image in `public/index.html`,
  `public/about.html`, and `admin/index.html`, so there's nothing extra to
  host.

## 4. Deploying it somewhere real

This is a single Node process with no database, so it runs on almost any
Node-friendly host (a small VPS, Render, Railway, Fly.io, etc.):

1. Upload the whole `sndl-forex-site` folder to the server.
2. Set environment variables:
   - `PORT` — the port to listen on (many hosts set this for you).
   - `NODE_ENV=production` — this makes the session cookie `Secure`, so put
     the site behind HTTPS (most hosts / reverse proxies do this for you).
   - `ADMIN_PASSWORD` — optional; set this on the *very first* deploy to
     choose your own initial password instead of the random generated one.
3. Start it with `node server.js` (or `npm start`).
4. Make sure the `data/` folder persists across deploys/restarts — that's
   where the rates and the admin password hash live. On most hosts this
   means using a persistent disk/volume rather than an ephemeral filesystem.
5. Log in at `https://your-domain.com/admin` with the admin password.

### A note on security

This keeps things simple on purpose (no database, no external auth
provider), which is enough for a small business site with one shared admin
login. If you'd like stronger security later — separate accounts per staff
member, an audit log of who changed which rate, two-factor login, etc. —
that's a reasonable next step and would build on this same backend.
