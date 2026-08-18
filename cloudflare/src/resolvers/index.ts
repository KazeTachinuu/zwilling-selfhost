/**
 * Resolver architecture
 * =====================
 *
 * Resolvers are organized as DOMAIN SLICES. Each slice is a partial resolver
 * map (a plain object keyed by GraphQL type name, then field name) that this
 * index merges into one map handed to makeExecutableSchema.
 *
 * Add a slice to SLICES below. `mergeSlices` deep-merges at the type level, so
 * two slices may contribute fields to the same type (e.g. both add to `Query`)
 * without clobbering each other.
 *
 * Context: every resolver's 3rd arg is `GraphQLContext` = { env, user, ip }.
 *   - env.DB     -> D1Database (relational data)
 *   - env.BUCKET -> R2Bucket   (photo bytes)
 *   - env.JWT_SECRET / JWT_TTL / CORS_ORIGIN -> vars
 *   - user       -> authenticated UserRow, or null for guests
 *
 * Auth gating: foodgroupList(bucket: ZWILLING), introspection, and the pre-auth
 * account flows (authLogin/authQLogin/authRegister/password-reset) are public.
 * Every user-scoped field calls `requireUser(ctx)`, which throws a GraphQL error
 * carrying extensions.code = "AUTHENTICATION_FAILED" for guests. Fields with no
 * explicit resolver are handled by the generic "schema-valid empty" layer in
 * src/schema.ts and never error.
 */

import type { GraphQLError } from "graphql";
import { hashPassword, signToken, verifyPassword } from "../auth";
import { first, listCustomFoodgroups, listZwillingFoodgroups, localeForSite, run } from "../db";
import { groupsResolvers, memberScope } from "../groups";
import {
  allowFirstLoginProvision,
  allowRegistration,
  assertNotLockedOut,
  clearLoginAttempts,
  rateLimitKey,
  recordLoginFailure,
} from "../security";
import type { GraphQLContext, UserRow } from "../types";
import { accountResolvers } from "./account";
import { boxResolvers } from "./box";
import { photosResolvers } from "./photos";
import type { ResolverFn, ResolverSlice } from "./shared";
import { authError, requireUser } from "./shared";

export type { ResolverFn, ResolverSlice };
// Re-exported so existing importers of these from "./index" keep working.
export { authError, requireUser };

// ── shared login flow (per-account password, first-login-sets-password) ─────
interface LoginArgs {
  siteId: string;
  username: string;
  password: string;
  additionalFields?: { language?: string; preferredLocale?: string } | null;
}

// Single generic failure. Never distinguishes "no such user" from "wrong
// password" from "locked out", so a client cannot enumerate accounts.
function invalidCredentials(): GraphQLError {
  return authError("Invalid credentials");
}

// Exported for tests (tests/hardening.test.ts drives the first-login-provision
// branches directly with an overridden env flag).
export async function login(ctx: GraphQLContext, args: LoginArgs): Promise<{ token: string }> {
  const { env } = ctx;
  const email = args.username;
  const locale =
    args.additionalFields?.language ??
    args.additionalFields?.preferredLocale ??
    localeForSite(args.siteId);

  // Rate-limit keyed by (username|ip). Reject early if currently locked out.
  const key = rateLimitKey(email, ctx.ip);
  await assertNotLockedOut(env, key);

  const user = await first<UserRow>(env, "SELECT * FROM users WHERE email = ?", email);

  if (!user) {
    // Closed registration in production: an unknown username never provisions an
    // account. Count it as a failed attempt and return the generic error.
    if (!allowRegistration(env)) {
      await recordLoginFailure(env, key);
      throw invalidCredentials();
    }
    // Open registration (dev/self-host): the supplied password becomes the
    // account password on first sight.
    const id = crypto.randomUUID();
    const hash = await hashPassword(args.password);
    await run(
      env,
      "INSERT INTO users (id,email,password_hash,name,locale) VALUES (?,?,?,?,?)",
      id,
      email,
      hash,
      null,
      locale,
    );
    await clearLoginAttempts(env, key);
    return { token: await signToken(id, env) };
  }

  if (!user.password_hash) {
    // A pre-provisioned account row exists but has no password yet. The legacy
    // "first login sets the password" convenience lets WHOEVER logs in first
    // claim the account (account takeover). It is now gated behind
    // ALLOW_FIRST_LOGIN_PROVISION (default false): when off, treat the account
    // exactly like a failed login and NEVER set the password. Admins set
    // passwords out-of-band via `npm run admin:create-user`.
    if (!allowFirstLoginProvision(env)) {
      await recordLoginFailure(env, key);
      throw invalidCredentials();
    }
    const hash = await hashPassword(args.password);
    await run(
      env,
      "UPDATE users SET password_hash=?, modified=unixepoch() WHERE id=?",
      hash,
      user.id,
    );
    await clearLoginAttempts(env, key);
    return { token: await signToken(user.id, env) };
  }

  if (!(await verifyPassword(args.password, user.password_hash))) {
    await recordLoginFailure(env, key);
    throw invalidCredentials();
  }
  await clearLoginAttempts(env, key);
  return { token: await signToken(user.id, env) };
}

// ── CORE slice (implemented inline; smoke-test critical) ────────────────────
const coreResolvers: ResolverSlice = {
  Query: {
    // Public: 21 ZWILLING presets; user-scoped for the CUSTOM bucket.
    foodgroupList: async (_p, args, ctx) => {
      const locale = String(args.locale ?? "en");
      const bucket = String(args.bucket);
      if (bucket === "CUSTOM") {
        const user = requireUser(ctx);
        const scope = await memberScope(ctx.env, user.id);
        return listCustomFoodgroups(ctx.env, scope, locale);
      }
      return listZwillingFoodgroups(ctx.env, locale);
    },

    // Query-side login alias (mirrors the Mutation).
    authQLogin: (_p, args, ctx) => login(ctx, args as unknown as LoginArgs),

    // Self-hosted = closed, password-only accounts (provisioned via admin:create-user).
    // Return no social providers so the app's login screen hides the Google/Apple buttons
    // and shows email + password only. getLinkToSocialProvider/exchangeCode stay null.
    // ponytail: no OAuth server here; add real social login only if you ever open registration.
    getListOfAvailbleSocialLoginProviders: () => [],
  },

  Mutation: {
    // Pre-auth account flow. Public.
    authLogin: (_p, args, ctx) => login(ctx, args as unknown as LoginArgs),

    authRegister: async (_p, args, ctx) => {
      const a = args as unknown as LoginArgs & { firstName?: string; lastName?: string };
      const name = [a.firstName, a.lastName].filter(Boolean).join(" ") || null;
      const result = await login(ctx, a);
      if (name) {
        await run(
          ctx.env,
          "UPDATE users SET name=coalesce(name, ?), modified=unixepoch() WHERE email=?",
          name,
          a.username,
        );
      }
      return result;
    },
  },
};

// ── slice registry + merge ──────────────────────────────────────────────────
// Add new domain slices here. Order does not matter as long as two slices do
// not define the same type+field (last-wins if they do).
const SLICES: ResolverSlice[] = [
  coreResolvers,
  boxResolvers,
  accountResolvers,
  photosResolvers,
  groupsResolvers,
];

function mergeSlices(slices: ResolverSlice[]): ResolverSlice {
  const merged: ResolverSlice = {};
  for (const slice of slices) {
    for (const [typeName, fields] of Object.entries(slice)) {
      merged[typeName] = { ...(merged[typeName] ?? {}), ...fields };
    }
  }
  return merged;
}

export const resolvers = mergeSlices(SLICES);
