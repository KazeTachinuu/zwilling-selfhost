/**
 * Dependency-free helpers shared by every resolver slice.
 *
 * Lives in its own module so the slices (box/account/photos, ../groups) can
 * import `requireUser` and the resolver types WITHOUT importing ./index, which
 * imports the slices back. That cycle used to work only by accident of import
 * order; keeping the shared surface here breaks it for good.
 */

import type { GraphQLResolveInfo } from "graphql";
import { GraphQLError } from "graphql";
import type { GraphQLContext, UserRow } from "../types";

export type ResolverFn = (
  parent: unknown,
  args: Record<string, unknown>,
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) => unknown;

export type ResolverSlice = Record<string, Record<string, ResolverFn>>;

export function authError(message = "Authentication required"): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "AUTHENTICATION_FAILED" } });
}

/** Return the authenticated user or throw AUTHENTICATION_FAILED. */
export function requireUser(ctx: GraphQLContext): UserRow {
  if (!ctx.user) throw authError();
  return ctx.user;
}
