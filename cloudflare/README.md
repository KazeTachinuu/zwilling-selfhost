# ZWILLING Food Organizer, Cloudflare Worker backend

A self-hosted GraphQL backend for the ZWILLING Food Organizer app, running
entirely on the Cloudflare **free tier**: a Worker (graphql-yoga), D1 (SQLite)
for relational data, and R2 for photos. No Node builtins; all crypto uses the
Web Crypto global.

- Deploy from zero: **[DEPLOY.md](./DEPLOY.md)**.
- Leaving Cloudflare later: **[DEPLOY.md > Migration-off runbook](./DEPLOY.md#migration-off-runbook)**.

## Endpoints

| Method   | Path        | Purpose                                             |
| -------- | ----------- | --------------------------------------------------- |
| `GET`    | `/health`   | Liveness JSON + seeded preset count (21 groups).    |
| `POST`   | `/graphql`  | The GraphQL API (graphql-yoga).                     |
| `PUT`    | `/media/*`  | Authorized photo upload (signed short-lived token). |
| `GET`    | `/media/*`  | Serve a photo object from R2.                       |

## Security posture

Defense-in-depth lives in code; the Cloudflare dashboard (WAF, rate-limit rules,
TLS) sits on top. See [DEPLOY.md](./DEPLOY.md) for the dashboard half.

- **Login rate-limiting + backoff.** Failures are tracked in the D1
  `login_attempts` table keyed by `username|ip`. After 5 failures a lockout
  starts at 30s and doubles per further failure, capped at 1h; stale streaks
  (older than 15 min) reset. A successful login clears the record.
- **No user enumeration.** Every login failure, whether the account is unknown,
  the password is wrong, or the key is locked out, returns the same generic
  `Invalid credentials` error with code `AUTHENTICATION_FAILED`. New-account and
  wrong-password paths both run a full PBKDF2 derive, so timing does not leak
  existence either.
- **Closed registration in production.** With `ALLOW_REGISTRATION` unset/false,
  an unknown username is rejected (never auto-provisioned). Provision family
  accounts out-of-band with `bun run admin:create-user` (below).
- **No first-login account takeover.** A pre-provisioned account row with a NULL
  password is **not** claimable by whoever logs in first: with
  `ALLOW_FIRST_LOGIN_PROVISION` unset/false (the default), such a login is
  rejected as `Invalid credentials` and the password is never set. Admins set
  passwords out-of-band via `bun run admin:create-user`. Set the flag to `true`
  only to restore the legacy "first login sets the password" convenience.
- **GraphQL hardening (graphql-armor).** Introspection is disabled and
  `Did you mean ...` field suggestions are blocked (unless `DEV=true`). Query
  **batching is off**. Every operation is bounded by graphql-armor limiters:
  **max aliases (15)**, **max directives (10)**, **max depth (15)**, **max tokens
  (2000)** and a **cost limit (5000)**, defanging alias/directive-overloading and
  other amplification DoS. Thresholds are not leaked in error messages.
- **POST + JSON only.** In production the `/graphql` endpoint accepts only `POST`
  with `Content-Type: application/json` (405 for other methods, 415 for other
  content types), and the **GraphiQL IDE / landing page are disabled**, removing
  the GET / form-encoded CSRF surface. `DEV=true` re-enables GraphiQL locally.
- **Per-owner isolation (IDOR-safe).** Every read and write resolver is scoped by
  `owner_id` taken from the authenticated JWT, so one account can never read or
  modify another account's items, containers, or storages. Cross-owner reads
  return `null`; cross-owner writes return `success:false`. Item/container/storage
  ids are unguessable UUIDs, but ownership, not obscurity, is the control.
- **JWT is HMAC-only.** `verifyToken` ignores the token header `alg` and always
  HMAC-verifies with `JWT_SECRET`, so an `alg:none` or wrong-secret token, or a
  tampered payload, resolves to guest, never to the impersonated user.
- **Capability-URL photos.** Photo upload and serving use signed capability URLs,
  not public buckets. `requestUploadUrl` returns a short-lived (15 min) `PUT`
  URL whose `token` is an HMAC over `{ owner, usedFor, cloudId, ext, contentType,
  exp }`; the R2 object key embeds the owner id (`<usedFor>/<owner>/<cloudId>.<ext>`),
  so a photo cannot be written or read into another owner's namespace. R2 is
  never exposed directly; all objects flow through `/media/*` on the Worker.
- **Parameterized SQL only.** Every D1 query binds values with `?`/`.bind(...)`;
  no string interpolation, so injection payloads land as literal data.
- **CORS default-deny.** No `Access-Control-Allow-Origin` is emitted unless the
  request Origin is explicitly listed in `CORS_ORIGIN`. The native app sends no
  Origin, so CORS never applies to it.
- **Security headers** on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, a strict `Content-Security-Policy` (`default-src
  'none'`), `Referrer-Policy: no-referrer`, HSTS, and `Cross-Origin-Resource-Policy`.
- **Production secret guard.** The Worker **refuses to serve** (503) if
  `JWT_SECRET` is unset or the dev default while `DEV` is not `true`. Set a real
  secret with `wrangler secret put JWT_SECRET`.
- **PBKDF2 cost.** PBKDF2-HMAC-SHA-256, 100k iterations, 32-byte key, 16-byte
  random salt. The first derive per isolate logs its measured time (observe it
  in `wrangler tail`); it measures ~2-4ms, well inside the free-tier ~10ms
  CPU/request budget.
- **D1 subrequest budget.** List resolvers batch (a fixed handful of queries
  assembled in JS via `IN (...)`, never one query per row), staying under the
  free-tier 50-subrequest cap.

### Seed data

`0002_seed_zwilling.sql` idempotently seeds the **21 ZWILLING preset food groups**,
each with **localized names across 15 locales** (`cs, de, en, es, fr, hu, it, ja,
ko, nl, pl, pt, sk, tr, zh`) and per-location shelf-life (storable) days. It is
generated from `src/shelf_life.json` and mirrors `seedPresets()` in `src/seed.ts`,
so tests, deploys, and the app agree. `/health` reports the live group count.

### Environment variables

| Var                  | Default (prod)                  | Meaning                                                                 |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `JWT_SECRET`         | dev placeholder (guard blocks)  | HS256 signing secret. **Override with `wrangler secret put`.**         |
| `JWT_TTL`            | `7776000` (90 days)             | Token lifetime in seconds.                                             |
| `CORS_ORIGIN`        | `""` (deny all)                 | Comma-separated browser Origin allow-list. `*` allows any.            |
| `ALLOW_REGISTRATION` | `false`                         | `true` auto-provisions unknown usernames (open registration).         |
| `ALLOW_FIRST_LOGIN_PROVISION` | `false`                | `true` lets the first login to a NULL-password account set its password. Leave `false` to prevent account takeover. |
| `DEV`                | `false`                         | `true` re-enables introspection, field hints, GraphiQL, and GET/non-JSON `/graphql`. **Never true in prod.**|
| `MEDIA_BASE_URL`     | `https://your-backend.example.com` | Base URL used to build photo/upload URLs.                            |

Production defaults are secure. For local `wrangler dev`, copy `.dev.vars.example`
to `.dev.vars` (gitignored) to set `DEV=true` and a local secret.

## Admin: create / reset family accounts (no email)

Registration is closed in production, so accounts are provisioned by an admin.
`scripts/admin-user.mjs` computes a PBKDF2 hash byte-compatible with the Worker
and upserts the `users` row via `wrangler d1 execute`. Create and reset are the
same command (it overwrites the password on conflict):

```bash
# against the deployed database
bun run admin:create-user -- alice@family.test 'a strong passphrase' --remote

# against the local dev database (default)
bun run admin:create-user -- alice@family.test 'a strong passphrase' --local

# just print the SQL, touch nothing
bun scripts/admin-user.mjs alice@family.test 'a strong passphrase' --print
```

## Development

```bash
bun install
bun test               # vitest (runs against the fully hardened path)
bun run typecheck
cp .dev.vars.example .dev.vars   # then edit
bun run dev            # wrangler dev
```

The test suite (`tests/`) runs with a non-default secret and `DEV=false`, so it
exercises the hardened path: introspection off, suggestions stripped, depth/cost
limits, and live login rate-limiting.
