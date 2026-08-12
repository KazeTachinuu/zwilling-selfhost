/**
 * Family GROUP domain: flat, trust-based sharing. Members of a group share their
 * inventory (via `memberScope`). Roles are owner|member but permissions are
 * near-identical; there is deliberately NO kick operation.
 *
 * `memberScope(env, userId)` is the sharing primitive imported by box.ts and
 * photos.ts: it returns the set of user ids whose rows the caller may read/edit,
 * = self UNION every member of every group the caller belongs to. When the user
 * is in no group it collapses to `[userId]`, preserving pre-group behavior.
 */

import type { Env } from "./types";
import type { ResolverSlice } from "./resolvers/index";
import { requireUser } from "./resolvers/index";
import { first, all, run } from "./db";
import { GraphQLError } from "graphql";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Random hex string of at least `bytes*2` chars (16+ chars for 8+ bytes). */
function randomHash(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Distinct user ids sharing inventory with `userId`: self UNION all members of
 * every group `userId` is in. Always includes `userId` (even with no groups).
 */
export async function memberScope(env: Env, userId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    env,
    "SELECT DISTINCT gm2.user_id FROM group_members gm1 " +
      "JOIN group_members gm2 ON gm1.group_id=gm2.group_id WHERE gm1.user_id=?",
    userId,
  );
  const ids = new Set<string>([userId]);
  for (const r of rows) ids.add(r.user_id);
  return [...ids];
}

/** True if `userId` is a member of `groupId`. */
async function isMember(env: Env, groupId: string, userId: string): Promise<boolean> {
  const row = await first(
    env,
    "SELECT 1 FROM group_members WHERE group_id=? AND user_id=?",
    groupId,
    userId,
  );
  return !!row;
}

/** Reuse or create a PERMANENT join hash for a group. Returns the hash. */
export async function permanentJoinHash(env: Env, groupId: string): Promise<string> {
  const existing = await first<{ hash: string }>(
    env,
    "SELECT hash FROM group_join_hashes WHERE group_id=? AND mode='PERMANENT' AND expires IS NULL LIMIT 1",
    groupId,
  );
  if (existing) return existing.hash;
  const hash = randomHash();
  await run(
    env,
    "INSERT INTO group_join_hashes (hash,group_id,mode,expires) VALUES (?,?,'PERMANENT',NULL)",
    hash,
    groupId,
  );
  return hash;
}

export const groupsResolvers: ResolverSlice = {
  Query: {
    groupJoinHash: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const groupId = args.groupId as string;
      const mode = (args.mode as string) ?? "PERMANENT";
      if (!(await isMember(ctx.env, groupId, user.id))) {
        throw new GraphQLError("Not a member", { extensions: { code: "FORBIDDEN" } });
      }
      if (mode === "TEMPORARY") {
        const hash = randomHash();
        await run(
          ctx.env,
          "INSERT INTO group_join_hashes (hash,group_id,mode,expires) VALUES (?,?,'TEMPORARY',?)",
          hash,
          groupId,
          nowSec() + 7 * 86400,
        );
        return { groupId, hash };
      }
      return { groupId, hash: await permanentJoinHash(ctx.env, groupId) };
    },
  },

  Mutation: {
    groupCreate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const groupId = crypto.randomUUID();
      await run(
        ctx.env,
        "INSERT INTO groups (id,name,owner_id) VALUES (?,?,?)",
        groupId,
        args.name,
        user.id,
      );
      await run(
        ctx.env,
        "INSERT INTO group_members (group_id,user_id,is_owner) VALUES (?,?,1)",
        groupId,
        user.id,
      );
      return { success: true, groupId };
    },

    groupJoin: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const hash = args.hash as string;
      const row = await first<{ group_id: string; expires: number | null }>(
        ctx.env,
        "SELECT group_id, expires FROM group_join_hashes WHERE hash=?",
        hash,
      );
      if (!row || (row.expires != null && row.expires < nowSec())) {
        return { success: false };
      }
      await run(
        ctx.env,
        "INSERT OR IGNORE INTO group_members (group_id,user_id,is_owner) VALUES (?,?,0)",
        row.group_id,
        user.id,
      );
      return { success: true };
    },

    groupLeave: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const groupId = args.groupId as string;
      const membership = await first<{ is_owner: number }>(
        ctx.env,
        "SELECT is_owner FROM group_members WHERE group_id=? AND user_id=?",
        groupId,
        user.id,
      );
      if (!membership)
        throw new GraphQLError("Not a member", { extensions: { code: "FORBIDDEN" } });

      await run(
        ctx.env,
        "DELETE FROM group_members WHERE group_id=? AND user_id=?",
        groupId,
        user.id,
      );

      if (membership.is_owner === 1) {
        const next = await first<{ user_id: string }>(
          ctx.env,
          "SELECT user_id FROM group_members WHERE group_id=? ORDER BY joined ASC, user_id ASC LIMIT 1",
          groupId,
        );
        if (next) {
          await run(
            ctx.env,
            "UPDATE group_members SET is_owner=1 WHERE group_id=? AND user_id=?",
            groupId,
            next.user_id,
          );
          await run(
            ctx.env,
            "UPDATE groups SET owner_id=?, modified=unixepoch() WHERE id=?",
            next.user_id,
            groupId,
          );
        } else {
          await run(ctx.env, "DELETE FROM group_join_hashes WHERE group_id=?", groupId);
          await run(ctx.env, "DELETE FROM groups WHERE id=?", groupId);
        }
      }
      return { success: true };
    },

    groupModify: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const groupId = args.groupId as string;
      // IDOR-safe no-op (mirrors freshandsaveModify / box.ts writes): a caller who
      // is not a member cannot mutate the group, and gets success:false rather
      // than an error (never leaks whether the group exists).
      if (!(await isMember(ctx.env, groupId, user.id))) {
        return { success: false };
      }
      const change = (args.change as { name?: string }) ?? {};
      if (change.name == null) return { success: true };
      await run(
        ctx.env,
        "UPDATE groups SET name=?, modified=unixepoch() WHERE id=?",
        change.name,
        groupId,
      );
      return { success: true };
    },
  },
};
