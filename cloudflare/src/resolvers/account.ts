/**
 * ACCOUNT domain: profile, settings, shopping lists, addresses, groups,
 * notifications/devices, and the admin-reset password model. Ported 1:1 from
 * backend-py/app.py. All fields are user-scoped and gated with `requireUser`,
 * except the public password-reset endpoints (`requestPasswordReset`,
 * `authPasswordReset`) which, matching the reference, always report success and
 * never leak account existence.
 */

import type { ResolverSlice } from "./index";
import { requireUser } from "./index";
import { first, all, run, sha256b64 } from "../db";
import { permanentJoinHash } from "../groups";
import type { Env, UserRow } from "../types";

// ── deterministic JSON (sorted keys), for opaque cache-key hashes ────────────
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// ── groups ─────────────────────────────────────────────────────────────────
interface GroupRow {
  group_id: string;
  name: string;
}
interface GroupMemberRow {
  user_id: string;
  is_owner: number;
  name: string | null;
  email: string;
}

async function buildGroups(env: Env, user: UserRow): Promise<Record<string, unknown>[]> {
  const groups = await all<GroupRow>(
    env,
    "SELECT g.id AS group_id, g.name AS name FROM groups g " +
      "JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=? ORDER BY g.created",
    user.id,
  );
  const out: Record<string, unknown>[] = [];
  for (const g of groups) {
    const memberRows = await all<GroupMemberRow>(
      env,
      "SELECT gm.user_id AS user_id, gm.is_owner AS is_owner, u.name AS name, u.email AS email " +
        "FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY gm.joined",
      g.group_id,
    );
    const members = memberRows.map((m) => ({
      userId: m.user_id,
      owner: m.is_owner === 1,
      name: (m.name && m.name.trim()) || m.email.split("@")[0],
      photo: [] as unknown[],
    }));
    out.push({
      groupId: g.group_id,
      name: g.name,
      joinHash: await permanentJoinHash(env, g.group_id),
      members,
    });
  }
  return out;
}

// ── profile ──────────────────────────────────────────────────────────────────
async function buildProfile(env: Env, user: UserRow): Promise<Record<string, unknown>> {
  const nm = (user.name || "").trim();
  const parts = nm ? nm.split(/\s+/) : [""];
  const first_ = parts[0];
  const last = parts.slice(1).join(" ");
  const fs = await first<{ c: number; m: number }>(
    env,
    "SELECT count(*) c, coalesce(max(modified),0) m FROM freshandsave_items WHERE owner_id=? AND state!='REMOVED'",
    user.id,
  );
  const fg = await first<{ c: number; m: number }>(
    env,
    "SELECT count(*) c, coalesce(max(created),0) m FROM foodgroups WHERE owner_id=?",
    user.id,
  );
  return {
    customerId: user.id,
    customerNumber: user.id,
    email: user.email,
    firstName: first_ || user.email.split("@")[0],
    lastName: last || "",
    birthday: null,
    gender: null,
    secondName: null,
    jobTitle: null,
    phoneHome: null,
    phoneBusiness: null,
    phoneMobile: null,
    preferredLocale: user.locale,
    salutation: null,
    title: null,
    visitId: null,
    countryCode: null,
    sfccContactId: null,
    houseHoldPeople: null,
    // The app gates a blocking "enable notifications" onboarding screen on these:
    // a NULL consent date makes ShouldAskForMarketingPushConsent always fire, and on
    // devices where FCM can't complete (e.g. GrapheneOS) that screen never dismisses.
    // Reporting a recent, non-null consent date collapses the gate so the app opens
    // straight to the inventory. Push is a v2 feature; this is not marketing tracking.
    marketingPushNotificationConsent: true,
    marketingPushNotificationConsentDate: new Date().toISOString(),
    inventoryPushNotificationConsent: true,
    inventoryPushNotificationConsentDate: new Date().toISOString(),
    addresses: [],
    subscribedNewsletter: false,
    name: user.name,
    freshandsaveHash: await sha256b64(`fs|${user.id}|${fs?.c ?? 0}|${fs?.m ?? 0}`),
    foodgroupHash: await sha256b64(`fg|${user.id}|${fg?.c ?? 0}|${fg?.m ?? 0}`),
    shoppinglistHash: await sha256b64(`sl|${user.id}`),
    groups: await buildGroups(env, user),
  };
}

// ── shopping lists ────────────────────────────────────────────────────────────
interface ShoppingListRow {
  cloud_id: string;
  owner_id: string;
  name: string;
  position: number;
  state: string;
  categories_json: string;
}

interface SlEntry {
  cloudId: string;
  position: number;
  name: string;
  value: string;
  unit: string;
  state: string;
}
interface SlCategory {
  cloudId: string;
  position: number;
  name: string | null;
  entries: SlEntry[];
}

function normSlCategories(categories: unknown): SlCategory[] {
  const out: SlCategory[] = [];
  const cats = (categories as Record<string, unknown>[]) ?? [];
  cats.forEach((cat, ci) => {
    const entries: SlEntry[] = [];
    const rawEntries = (cat.entries as Record<string, unknown>[]) ?? [];
    rawEntries.forEach((e, ei) => {
      entries.push({
        cloudId: crypto.randomUUID(),
        position: (e.position as number) ?? ei,
        name: (e.name as string) || "",
        value: (e.value as string) || "",
        unit: (e.unit as string) || "",
        state: (e.state as string) || "OK",
      });
    });
    out.push({
      cloudId: crypto.randomUUID(),
      position: (cat.position as number) ?? ci,
      name: (cat.name as string) ?? null,
      entries,
    });
  });
  return out;
}

async function mapShoppinglist(row: ShoppingListRow): Promise<Record<string, unknown>> {
  const cats = JSON.parse(row.categories_json || "[]");
  const hash = await sha256b64(`${row.name}|${row.position}|${row.state}|${stableStringify(cats)}`);
  return {
    cloudId: row.cloud_id,
    position: row.position,
    name: row.name,
    state: row.state,
    owner: row.owner_id,
    categories: cats,
    hash,
  };
}

// ── addresses ─────────────────────────────────────────────────────────────────
function mapAddress(row: { id: string; json: string }): Record<string, unknown> {
  const a = JSON.parse(row.json || "{}");
  a.id = row.id;
  return a;
}

// ── settings helper ───────────────────────────────────────────────────────────
async function settingSet(env: Env, ownerId: string, type: unknown, key: string, value: unknown) {
  await run(
    env,
    "INSERT INTO settings (owner_id,type,key,value) VALUES (?,?,?,?) " +
      "ON CONFLICT(owner_id,type,key) DO UPDATE SET value=excluded.value",
    ownerId,
    (type as string) || "GENERAL",
    key,
    value != null ? value : "",
  );
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
}

// ── slice ─────────────────────────────────────────────────────────────────────
export const accountResolvers: ResolverSlice = {
  Query: {
    profile: async (_p, _args, ctx) => buildProfile(ctx.env, requireUser(ctx)),

    settings: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const t = (args.type as string) || "GENERAL";
      const rows = await all<{ key: string; value: string }>(
        ctx.env,
        "SELECT key,value FROM settings WHERE owner_id=? AND type=? ORDER BY key",
        user.id,
        t,
      );
      const settings = rows.map((r) => ({ key: r.key, value: r.value }));
      // Default isOnboardingCompleted=true unless the user stored a real value.
      // Without this a first login hits a blocking onboarding wall (no way past
      // it on devices where FCM can't complete). Merge, never duplicate.
      if (!settings.some((s) => s.key === "isOnboardingCompleted")) {
        settings.push({ key: "isOnboardingCompleted", value: "true" });
      }
      return { settings };
    },

    shoppinglists: async (_p, _args, ctx) => {
      const user = requireUser(ctx);
      const rows = await all<ShoppingListRow>(
        ctx.env,
        "SELECT * FROM shoppinglists WHERE owner_id=? AND state!='REMOVED' ORDER BY position, created",
        user.id,
      );
      return { entries: await Promise.all(rows.map(mapShoppinglist)) };
    },

    shoppinglistContent: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const row = await first<ShoppingListRow>(
        ctx.env,
        "SELECT * FROM shoppinglists WHERE cloud_id=? AND owner_id=?",
        args.cloudId,
        user.id,
      );
      return row ? mapShoppinglist(row) : null;
    },

    scheduledNotifications: (_p, _args, ctx) => {
      requireUser(ctx);
      const iso = nowIso();
      return { servertime: iso, usertime: iso, usertimezone: "UTC", notifications: [] };
    },

    profileAddressList: async (_p, _args, ctx) => {
      const user = requireUser(ctx);
      const rows = await all<{ id: string; json: string }>(
        ctx.env,
        "SELECT * FROM addresses WHERE owner_id=? ORDER BY created",
        user.id,
      );
      return rows.map(mapAddress);
    },
  },

  Mutation: {
    profileModify: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const fields = (args.fields as Record<string, unknown>) ?? {};
      let name: string | null = null;
      const fn = fields.firstName as string | undefined;
      const ln = fields.lastName as string | undefined;
      if (fn != null || ln != null) {
        name = [fn || "", ln || ""].filter(Boolean).join(" ").trim() || user.name;
      }
      const loc = (fields.preferredLocale as string) || user.locale;
      await run(
        ctx.env,
        "UPDATE users SET name=coalesce(?,name), locale=?, modified=unixepoch() WHERE id=?",
        name,
        loc,
        user.id,
      );
      const updated = await first<UserRow>(ctx.env, "SELECT * FROM users WHERE id=?", user.id);
      return buildProfile(ctx.env, updated ?? user);
    },

    settingSet: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      await settingSet(ctx.env, user.id, args.type, args.key as string, args.value ?? null);
      return { success: true };
    },

    settingUnset: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      await run(
        ctx.env,
        "DELETE FROM settings WHERE owner_id=? AND type=? AND key=?",
        user.id,
        (args.type as string) || "GENERAL",
        args.key,
      );
      return { success: true };
    },

    settingsSet: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const settings = (args.settings as Record<string, unknown>[]) ?? [];
      for (const s of settings) {
        await settingSet(ctx.env, user.id, s.type, s.key as string, s.value ?? null);
      }
      return { success: true };
    },

    settingsUnset: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const settings = (args.settings as Record<string, unknown>[]) ?? [];
      for (const s of settings) {
        await run(
          ctx.env,
          "DELETE FROM settings WHERE owner_id=? AND type=? AND key=?",
          user.id,
          (s.type as string) || "GENERAL",
          s.key,
        );
      }
      return { success: true };
    },

    shoppinglistCreateOrModify: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cats = normSlCategories(args.categories);
      const catsJson = JSON.stringify(cats);
      await run(
        ctx.env,
        "INSERT INTO shoppinglists (cloud_id,owner_id,name,position,state,categories_json) " +
          "VALUES (?,?,?,?,'OK',?) ON CONFLICT(cloud_id) DO UPDATE SET name=excluded.name, " +
          "position=excluded.position, categories_json=excluded.categories_json, modified=unixepoch()",
        args.cloudId,
        user.id,
        args.name,
        args.position ?? 0,
        catsJson,
      );
      const row = await first<ShoppingListRow>(
        ctx.env,
        "SELECT * FROM shoppinglists WHERE cloud_id=? AND owner_id=?",
        args.cloudId,
        user.id,
      );
      return row ? mapShoppinglist(row) : null;
    },

    notificationsAddDevice: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      await run(
        ctx.env,
        "INSERT INTO device_tokens (owner_id,type,token) VALUES (?,?,?) " +
          "ON CONFLICT(owner_id,type,token) DO NOTHING",
        user.id,
        args.type,
        args.token,
      );
      return { success: true };
    },

    notificationsRemoveDevice: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      await run(
        ctx.env,
        "DELETE FROM device_tokens WHERE owner_id=? AND type=? AND token=?",
        user.id,
        args.type,
        args.token,
      );
      return { success: true };
    },

    notificationsSendNotification: (_p, _args, ctx) => {
      requireUser(ctx);
      // Self-hosted: no push provider wired up; accept and report success.
      return { success: true };
    },

    // Per-food-item / group reminder preferences + times. The app keeps these in
    // local prefs and mirrors them here; persisting + reporting success stops the
    // in-app notification settings save from failing (and lets the cron use them later).
    notificationsSettingsSet: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      await settingSet(
        ctx.env,
        user.id,
        "GENERAL",
        "notificationSettings",
        JSON.stringify({
          fooditemOn: args.fooditemOn ?? [],
          groupOn: args.groupOn ?? [],
          notificationTimes: args.notificationTimes ?? [],
        }),
      );
      return { success: true };
    },

    requestPasswordReset: () => {
      // Public. Admin-reset model: always accept (never leak account existence).
      return { success: true };
    },

    authPasswordReset: () => {
      // Public. Self-hosted admin-reset model: accept and report success.
      return { result: "SUCCESS" };
    },

    profileAddressCreate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const aid = crypto.randomUUID();
      await run(
        ctx.env,
        "INSERT INTO addresses (id,owner_id,name,json) VALUES (?,?,?,?)",
        aid,
        user.id,
        args.name ?? null,
        JSON.stringify(args.address ?? {}),
      );
      const row = await first<{ id: string; json: string }>(
        ctx.env,
        "SELECT * FROM addresses WHERE id=?",
        aid,
      );
      return row ? mapAddress(row) : null;
    },
  },
};
