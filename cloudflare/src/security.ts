/**
 * Security layer for the Worker.
 * ==============================
 *
 * Everything here is defense-in-depth that lives in code (the Cloudflare
 * dashboard adds WAF / rate-limit rules on top, see DEPLOY.md). It covers:
 *
 *   - Environment posture helpers (isDev, allowRegistration) and the hard guard
 *     that refuses to run in production with the dev-default JWT secret.
 *   - CORS: default-deny. The native app sends no Origin (CORS never applies to
 *     it); browsers only get an Access-Control-Allow-Origin when their Origin is
 *     explicitly allow-listed via the CORS_ORIGIN var.
 *   - Security response headers (nosniff, no-frame, strict CSP for a JSON API,
 *     HSTS, ...).
 *   - GraphQL validation rules: query depth limit and a query cost/complexity
 *     limit. Introspection is disabled and "Did you mean ..." field suggestions
 *     are stripped unless DEV is set.
 *   - Login rate-limiting + exponential backoff, backed by the D1
 *     `login_attempts` table and keyed by (username|ip).
 */

import { GraphQLError, NoSchemaIntrospectionCustomRule } from "graphql";
import type { Plugin } from "graphql-yoga";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxDirectivesPlugin } from "@escape.tech/graphql-armor-max-directives";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxTokensPlugin } from "@escape.tech/graphql-armor-max-tokens";
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { blockFieldSuggestionsPlugin } from "@escape.tech/graphql-armor-block-field-suggestions";
import type { Env } from "./types";
import { first, run } from "./db";

// The value shipped in wrangler.jsonc for local development. Production MUST
// override it with `wrangler secret put JWT_SECRET`.
export const DEV_DEFAULT_SECRET = "zwilling-selfhosted-dev-secret";

// ── environment posture ──────────────────────────────────────────────────────
/** DEV loosens developer-hostile protections (introspection, suggestions). */
export function isDev(env: Env): boolean {
  return env.DEV === "true" || env.DEV === "1";
}

/** Open registration: an unknown username auto-provisions an account. */
export function allowRegistration(env: Env): boolean {
  return env.ALLOW_REGISTRATION === "true" || env.ALLOW_REGISTRATION === "1";
}

/**
 * First-login provisioning: when a pre-provisioned account row exists with a
 * NULL password_hash, the FIRST login sets that password. Default OFF: leaving
 * it off closes an account-takeover window where whoever logs in first claims
 * an unclaimed account. Admins set passwords out-of-band via
 * `npm run admin:create-user`. Set "true" only for the legacy convenience flow.
 */
export function allowFirstLoginProvision(env: Env): boolean {
  return env.ALLOW_FIRST_LOGIN_PROVISION === "true" || env.ALLOW_FIRST_LOGIN_PROVISION === "1";
}

/** True when the running secret is the well-known dev default. */
export function jwtSecretIsInsecure(env: Env): boolean {
  return !env.JWT_SECRET || env.JWT_SECRET === DEV_DEFAULT_SECRET;
}

/**
 * Hard guard: refuse to serve if the dev-default JWT secret is used outside DEV.
 * Returns a 503 Response to short-circuit fetch(), or null when safe to proceed.
 */
export function productionSecretGuard(env: Env, headers: Record<string, string>): Response | null {
  if (isDev(env)) return null;
  if (jwtSecretIsInsecure(env)) {
    return new Response(
      JSON.stringify({
        error: "server_misconfigured",
        message:
          "Refusing to start: JWT_SECRET is unset or the dev default. Set a strong secret with `wrangler secret put JWT_SECRET`.",
      }),
      { status: 503, headers: { "Content-Type": "application/json", ...headers } },
    );
  }
  return null;
}

// ── security response headers ────────────────────────────────────────────────
/** Headers applied to every response the Worker emits. */
export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // JSON API: the response body is never a document, so lock everything down.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

// ── CORS (default-deny) ───────────────────────────────────────────────────────
/**
 * Build CORS headers for a request. Default-deny: unless the request carries an
 * Origin that is explicitly allow-listed in CORS_ORIGIN, no
 * Access-Control-Allow-Origin is emitted (the browser then blocks the response).
 * The native app sends no Origin, so it is unaffected.
 */
export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");
  if (!origin) return headers; // non-browser client (native app): nothing to add

  const allowed = (env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  // Origin present but not allow-listed -> omit ACAO; the browser blocks it.
  return headers;
}

// ── yoga security plugins (graphql-armor) ────────────────────────────────────
// A single, consistent set of query-shape limiters, all from graphql-armor:
// exactly one limiter per dimension (aliases, directives, depth, tokens, cost).
const MAX_QUERY_DEPTH = 15; // deepest legit shipped op nests ~6 levels
const MAX_ALIASES = 15; // blocks alias-overloading DoS (graphql-cop flagged 100+)
const MAX_DIRECTIVES = 10; // blocks directive-overloading DoS
const MAX_TOKENS = 2000; // largest legit shipped op is well under this
const MAX_QUERY_COST = 5000; // objectCost=scalarCost=1, depthCostFactor=1 -> ~field count

/** Refuse schema introspection unless DEV. */
function introspectionGuardPlugin(): Plugin {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(NoSchemaIntrospectionCustomRule);
    },
  };
}

/**
 * The graphql-yoga plugin set installed on the GraphQL endpoint. Bounds the
 * SHAPE of every operation (aliases, directives, depth, tokens, cost) to defang
 * DoS-style amplification, and (unless DEV) disables introspection and blocks
 * "Did you mean ..." field suggestions so a probing client learns nothing about
 * the schema. Error messages are generic (exposeLimits: false) so the exact
 * thresholds are not leaked.
 */
export function securityPlugins(env: Env): Plugin[] {
  const dev = isDev(env);
  const plugins: Plugin[] = [
    maxTokensPlugin({
      n: MAX_TOKENS,
      exposeLimits: false,
      errorMessage: "Query rejected: too many tokens.",
    }),
    maxAliasesPlugin({
      n: MAX_ALIASES,
      exposeLimits: false,
      errorMessage: "Query rejected: too many aliases.",
    }),
    maxDirectivesPlugin({
      n: MAX_DIRECTIVES,
      exposeLimits: false,
      errorMessage: "Query rejected: too many directives.",
    }),
    maxDepthPlugin({
      n: MAX_QUERY_DEPTH,
      ignoreIntrospection: true,
      exposeLimits: false,
      errorMessage: "Query rejected: exceeds maximum depth.",
    }),
    costLimitPlugin({
      maxCost: MAX_QUERY_COST,
      objectCost: 1,
      scalarCost: 1,
      depthCostFactor: 1,
      ignoreIntrospection: true,
      exposeLimits: false,
      errorMessage: "Query rejected: too complex.",
    }),
  ] as Plugin[];

  if (!dev) {
    plugins.push(introspectionGuardPlugin());
    plugins.push(blockFieldSuggestionsPlugin() as Plugin);
  }
  return plugins;
}

// ── login rate-limiting + backoff (D1-backed) ────────────────────────────────
const LOCK_THRESHOLD = 5; // failed attempts before the first lockout
const BASE_BACKOFF_SECONDS = 30; // lockout after threshold; doubles each further fail
const MAX_BACKOFF_SECONDS = 60 * 60; // cap at one hour
const ATTEMPT_WINDOW_SECONDS = 15 * 60; // stale failures older than this reset

interface AttemptRow {
  fails: number;
  first_fail: number;
  locked_until: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Normalized rate-limit key for a login attempt. */
export function rateLimitKey(username: string, ip: string): string {
  return `${(username || "").trim().toLowerCase()}|${ip || "unknown"}`;
}

/**
 * Throw a generic auth error if this key is currently locked out. Call before
 * touching the password. Never reveals whether the account exists.
 */
export async function assertNotLockedOut(env: Env, key: string): Promise<void> {
  const row = await first<AttemptRow>(
    env,
    "SELECT fails, first_fail, locked_until FROM login_attempts WHERE key=?",
    key,
  );
  if (row && row.locked_until > nowSec()) {
    throw new GraphQLError("Invalid credentials", {
      extensions: { code: "AUTHENTICATION_FAILED" },
    });
  }
}

/** Record a failed attempt and, past the threshold, set an exponential lockout. */
export async function recordLoginFailure(env: Env, key: string): Promise<void> {
  const now = nowSec();
  const existing = await first<AttemptRow>(
    env,
    "SELECT fails, first_fail, locked_until FROM login_attempts WHERE key=?",
    key,
  );

  // Reset a stale streak so honest users are not punished for old typos.
  const stale = existing && now - existing.first_fail > ATTEMPT_WINDOW_SECONDS;
  const fails = stale || !existing ? 1 : existing.fails + 1;
  const firstFail = stale || !existing ? now : existing.first_fail;

  let lockedUntil = 0;
  if (fails >= LOCK_THRESHOLD) {
    const backoff = Math.min(
      MAX_BACKOFF_SECONDS,
      BASE_BACKOFF_SECONDS * 2 ** (fails - LOCK_THRESHOLD),
    );
    lockedUntil = now + backoff;
  }

  await run(
    env,
    "INSERT INTO login_attempts (key, fails, first_fail, locked_until) VALUES (?,?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, first_fail=excluded.first_fail, " +
      "locked_until=excluded.locked_until",
    key,
    fails,
    firstFail,
    lockedUntil,
  );
}

/** Clear the attempt record on a successful login. */
export async function clearLoginAttempts(env: Env, key: string): Promise<void> {
  await run(env, "DELETE FROM login_attempts WHERE key=?", key);
}
