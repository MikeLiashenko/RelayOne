# RelayOne

A modern messenger — static frontend (no framework) + a TypeScript backend
(Express, WebSocket realtime, Drizzle/Postgres, object storage).

## Features

- **Auth** — passwordless email/phone OTP, sessions
- **Chats** — direct, **groups** and **channels**
- **Messaging** — replies with jump-to-original, reactions, edits, deletes,
  read receipts, typing & presence
- **RelayOne Calls** — 1:1 audio/video over WebRTC (WS signaling, STUN/TURN)
- **Files** — image/file attachments
- **Link previews** — rich unfurl cards (SSRF-hardened)
- **Saved Messages** — a private chat with yourself
- **Pinned messages** — with a dedicated pinned panel
- **Folders** — Personal / Groups / Favorites / custom, unread counters
- **Drafts**, **Profiles** (avatar upload, bio), **Themes** (dark/light/system + accent)

## Layout

```
app.html, index.html, login.html, register.html   # pages
scripts/           # frontend modules (ES modules, no bundler)
styles/            # design tokens + CSS
server/            # API, realtime, DB (Drizzle), storage — see server/README.md
```

## Run locally

**Backend** (`server/`):

```bash
cd server
cp .env.example .env      # DB_CLIENT=pglite works with zero setup
npm install
npm run dev               # API on :4000, WS on :4000/ws
```

**Frontend** (repo root) — any static server on port **4321** (matches CORS):

```bash
npx serve -l 4321 .
```

Then open http://localhost:4321/app

## Environment

See `server/.env.example`. Highlights: `DB_CLIENT=pglite` (zero-setup local DB),
`STUN_URLS` / `TURN_*` for calls, `STORAGE_*` for attachments.
