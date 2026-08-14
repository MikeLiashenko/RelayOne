# RelayOne — Backend Foundation

The API, auth, database, realtime and storage foundation for RelayOne. This is
a **first foundation**, not a production-hardened system (see _Security_).

## Stack

- **Node + TypeScript** (CommonJS, run with `tsx`, built with `tsc`)
- **PostgreSQL** via **Drizzle ORM** (postgres.js driver)
- **Express** REST API · **ws** WebSocket realtime
- **Zod** request validation
- **Vitest** tests running against in-process **PGlite** (no external DB needed)

## Layout

```
src/
  config/      validated environment (env.ts)
  db/          schema.ts, client, migrate + seed
  shared/      errors, DTO types, row→DTO serializers
  validation/  zod schemas + parse helper
  auth/        hashing, sessions, middleware, authService (register/login)
  storage/     provider-independent object storage (local provider)
  realtime/    WebSocket gateway, hub, event contracts
  services/    user / chat / message / attachment / notification
  api/         express app + routers + middleware
  server.ts    composition root (http + ws)
drizzle/       generated SQL migrations
test/          vitest suites (PGlite)
```

## Local development

1. **Database** — start Postgres (Docker):

   ```bash
   docker compose up -d
   ```

   > No Docker? Point `DATABASE_URL` at any Postgres 14+ instance.

2. **Env** — copy the template and adjust if needed:

   ```bash
   cp .env.example .env
   ```

   `.env` is git-ignored; never commit real secrets.

3. **Install, migrate, seed, run:**

   ```bash
   npm install
   npm run db:generate   # generate SQL migrations from the schema
   npm run db:migrate    # apply them to DATABASE_URL
   npm run db:seed       # dev-only: a few clearly-marked test users + chats
   npm run dev           # API on :4000, WebSocket on :4000/ws
   ```

The static frontend (served on `:4321`) talks to this API at
`http://localhost:4000` — override with `window.RELAYONE_API_BASE`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the API + realtime with hot reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:generate` | Generate SQL migrations from the schema |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run db:seed` | Seed dev-only test data (refuses in production) |
| `npm test` | Run the Vitest suite on in-process PGlite |

## API surface

`/api/auth` (register/login start · verify · register/complete · resend · logout),
`/api/users` (`/me`, `/username-available`, `/:id`), `/api/profiles/:username`,
`/api/chats` (list/create/read · messages · read receipts),
`/api/messages/:id` (edit/delete/reactions), `/api/attachments`,
`/api/notifications`. All responses use `{ data }` or
`{ error: { code, message } }`.

## Realtime (`/ws`)

Authenticated WebSocket. Server pushes `message.new/edited/deleted`,
`message.reaction`, `typing`, `presence`, `read`, `notification`. Clients send
`typing`, `read`, `ping`. Voice/video (**RelayOne Calls**) is intentionally not
here yet — the gateway is isolated so it can be added as new event types.

## Security (baseline only)

Implemented: input validation everywhere, hashed session tokens + salted/hashed
verification codes (never plaintext), auth-guarded endpoints, membership
authorization on chats/messages, auth rate-limiting, path-traversal-safe local
storage, secrets kept server-side. **Not yet production-secure** — notably:
account-enumeration on login is not mitigated, local file serving is open in
dev, and the rate limiter is in-memory (single instance).
