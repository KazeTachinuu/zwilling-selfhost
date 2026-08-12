# Deploy runbook

Everything here fits the Cloudflare **free tier**. The domain
`zwilling.example.com` is assumed to sit under the zone `example.com`,
already added to your Cloudflare account. Run all commands from this
`cloudflare/` directory.

Prerequisites: Node 20+, `npm install` done once.

---

## 1. Authenticate

```bash
npx wrangler login
```

## 2. Create the D1 database and apply migrations

```bash
npx wrangler d1 create zwilling
```

Copy the printed `database_id` into `wrangler.jsonc` (replace the placeholder
`00000000-0000-0000-0000-000000000000`). Then apply migrations to the remote DB
(the `DB` argument is the binding name):

```bash
npx wrangler d1 migrations apply DB --remote
```

This runs `0001_init.sql` (schema), `0002_seed_zwilling.sql` (the 21 ZWILLING
presets, with localized names across 15 locales and per-location shelf-life
days), and `0003_login_attempts.sql` (rate-limit state).

## 3. Create the R2 bucket

```bash
npx wrangler r2 bucket create zwilling-photos
```

The binding `BUCKET` in `wrangler.jsonc` already points at `zwilling-photos`.

## 4. Set the JWT secret (required)

The Worker **refuses to serve** in production while `JWT_SECRET` is unset or the
dev default. Set a strong random value; it is stored encrypted, not in the repo:

```bash
openssl rand -base64 48 | npx wrangler secret put JWT_SECRET
```

Leave `ALLOW_REGISTRATION`, `ALLOW_FIRST_LOGIN_PROVISION`, and `DEV` at their
secure defaults (`false`) in `wrangler.jsonc`. In particular keep
`ALLOW_FIRST_LOGIN_PROVISION=false`: with it off, a pre-provisioned row with a
NULL password can never be claimed by whoever logs in first. Always create
accounts **with** a password via `admin:create-user` (step 7); never leave a
NULL-password account in the `users` table.

## 5. Bind the custom domain

In `wrangler.jsonc`, add the route (this is a Workers **Custom Domain**: it
auto-creates a proxied DNS record and provisions the edge TLS certificate, all
free):

```jsonc
"routes": [
  { "pattern": "zwilling.example.com", "custom_domain": true }
]
```

## 6. Deploy

```bash
npx wrangler deploy
```

Verify:

```bash
curl https://zwilling.example.com/health
# {"status":"ok","service":"zwilling-food-organizer","seeded":21}
```

Watch the first login log the PBKDF2 derive time (confirming the ~10ms budget):

```bash
npx wrangler tail
# [auth] PBKDF2-SHA256 100000 iters derived in ~3ms (budget ~10ms CPU/req)
```

## 7. Provision the family accounts

Registration is closed in production. Create each account:

```bash
npm run admin:create-user -- alice@family.test 'a strong passphrase' --remote
npm run admin:create-user -- bob@family.test   'another passphrase'   --remote
```

Re-running the same command resets that account's password. Do this for every
family member; do not rely on any first-login provisioning path.

---

## Application-layer security posture

The dashboard steps below are the network half; the Worker enforces the rest in
code (full detail in [README.md > Security posture](./README.md#security-posture)):

- **GraphQL DoS limits (graphql-armor):** max aliases 15, max directives 10, max
  depth 15, max tokens 2000, cost limit 5000. Thresholds are not leaked in errors.
- **Introspection disabled** and field suggestions blocked (unless `DEV=true`);
  query **batching off**.
- **POST + `application/json` only** on `/graphql` (405 / 415 otherwise), and the
  **GraphiQL IDE / landing page are off** in production, removing the GET /
  form-encoded CSRF surface.
- **Login rate-limiting + exponential backoff** in D1 (`login_attempts`), generic
  `Invalid credentials` for every failure (no user enumeration), closed
  registration, and **no first-login takeover** (`ALLOW_FIRST_LOGIN_PROVISION`
  stays `false`).
- **PBKDF2-HMAC-SHA-256** (100k iterations, 32-byte key, 16-byte salt) for
  passwords, computed identically by the Worker and `admin-user.mjs`.
- **Per-owner isolation (IDOR-safe):** every resolver scoped by `owner_id`;
  **HMAC-only JWT** (no `alg:none` downgrade); **parameterized SQL** throughout.
- **Capability-URL photos:** short-lived HMAC-signed upload/serve URLs whose R2
  key embeds the owner; R2 is never exposed directly.
- **Security headers + strict CSP + HSTS** on every response, **CORS default-deny**,
  and a **production secret guard** (503 until a real `JWT_SECRET` is set).

---

## 8. Cloudflare dashboard hardening

Do these once in the dashboard for the `example.com` zone.

1. **Proxy (orange cloud).** DNS > Records: confirm the `zwilling` record is
   **Proxied** (orange cloud). A Workers Custom Domain sets this automatically;
   verify it.
2. **TLS Full (Strict).** SSL/TLS > Overview: set encryption mode to
   **Full (Strict)**. SSL/TLS > Edge Certificates: enable **Always Use HTTPS**
   and **Automatic HTTPS Rewrites** (HSTS is already sent by the Worker).
3. **Login rate-limit rule** (free tier includes one custom rate-limiting rule).
   Security > WAF > Rate limiting rules > Create:
   - **If** `Hostname eq zwilling.example.com and http.request.method eq "POST"
     and http.request.uri.path eq "/graphql"`
   - **Rate**: 20 requests per 1 minute, **per IP**.
   - **Action**: Block, for 1 minute (Managed Challenge also works).
   This is the coarse network-layer backstop; the D1-backed per-account backoff
   in the Worker is the fine-grained control.
4. **WAF managed rules** (free tier). Security > WAF > Managed rules: enable the
   **Cloudflare Free Managed Ruleset**. Optionally add a custom rule to block
   requests whose path is not one of `/graphql`, `/health`, `/media/*`.

---

## Migration-off runbook

Leaving Cloudflare is straightforward; nothing here is proprietary.

### D1 -> plain SQLite

D1 is SQLite. Export the whole database to a portable `.sql` dump and load it
into any SQLite:

```bash
npx wrangler d1 export zwilling --remote --output zwilling-export.sql
sqlite3 zwilling.db < zwilling-export.sql
```

`zwilling.db` is a standard SQLite file you can point a new backend at, or query
directly. (Add `--no-schema` / `--no-data` to export one half only.)

### R2 -> any S3-compatible store

R2 speaks the S3 API. Create an R2 API token (dashboard: R2 > Manage API Tokens),
then use any S3 client against the R2 endpoint:

```bash
export AWS_ACCESS_KEY_ID=<r2-access-key>
export AWS_SECRET_ACCESS_KEY=<r2-secret-key>
ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

# copy every photo out to a local folder (or to another S3 bucket)
aws s3 sync s3://zwilling-photos ./zwilling-photos --endpoint-url "$ENDPOINT"
```

Photo keys are `<usedFor>/<owner-id>/<cloudId>.<ext>`, matching the `r2_key`
column in the exported `photos` table, so the D1 dump and the object copy line up.

### Repoint the domain

Point `zwilling.example.com` at the new backend:

1. Remove the `routes` block from `wrangler.jsonc` and `npx wrangler deploy`
   (or delete the Worker), which releases the Custom Domain.
2. DNS > Records: add a normal record for `zwilling` (A/AAAA/CNAME) pointing at
   the new host. Keep it **Proxied** to retain Cloudflare TLS + WAF, or set it
   **DNS only** (grey cloud) to hand TLS to the new host.

DNS changes propagate in seconds because the zone is on Cloudflare. Roll back by
restoring the `routes` block and redeploying.
