/**
 * Shared types. `Env` mirrors the bindings/vars declared in wrangler.jsonc.
 * `GraphQLContext` is the object every resolver receives as its 3rd argument.
 */

export interface Env {
  /** D1 (SQLite) relational store. */
  DB: D1Database;
  /** R2 bucket for photo bytes. */
  BUCKET: R2Bucket;
  /** HS256 signing secret. Override in prod via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /** Token lifetime in seconds (string var). Defaults to 30 days if unset. */
  JWT_TTL?: string;
  /**
   * Comma-separated CORS allow-list (browser Origins). Default-deny: empty means
   * no browser cross-origin access. The native app sends no Origin and is
   * unaffected. "*" allows any origin (not recommended).
   */
  CORS_ORIGIN?: string;
  /** Public base URL that photo/upload URLs are built on. Defaults to the prod host. */
  MEDIA_BASE_URL?: string;
  /** "true" loosens dev-hostile protections (GraphQL introspection, field hints). */
  DEV?: string;
  /** "true" lets an unknown username auto-provision an account (open registration). */
  ALLOW_REGISTRATION?: string;
  /**
   * "true" lets the FIRST login to a pre-provisioned (NULL-password) account set
   * that account's password. Default "false": leaving it off closes an
   * account-takeover window (whoever logs in first would otherwise claim the
   * account). Admins set passwords out-of-band via `npm run admin:create-user`.
   */
  ALLOW_FIRST_LOGIN_PROVISION?: string;
  /**
   * Google service-account JSON (as a string), used to authenticate FCM push.
   * Worker SECRET — set via `wrangler secret put FCM_SERVICE_ACCOUNT`. Unset =
   * push disabled (the daily reminder cron is a no-op).
   */
  FCM_SERVICE_ACCOUNT?: string;
  /** Firebase project id for the FCM HTTP v1 endpoint. Unset = push disabled. */
  FCM_PROJECT_ID?: string;
}

/** A row from the `users` table (subset used across resolvers). */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  locale: string;
  created: number;
  modified: number;
}

/**
 * Resolver context. `env` reaches every binding (env.DB, env.BUCKET, vars).
 * `user` is the authenticated user row, or null for guests. Domain resolvers
 * call `requireUser(ctx)` (see resolvers/index.ts) to gate user-scoped fields.
 */
export interface GraphQLContext {
  env: Env;
  user: UserRow | null;
  /** Client IP (CF-Connecting-IP), used to key login rate-limiting. */
  ip: string;
}
