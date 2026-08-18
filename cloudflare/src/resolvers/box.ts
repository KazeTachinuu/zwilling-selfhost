/**
 * BOX domain: the NFC containers, freshandsave inventory items, storages, and
 * custom food groups. Ported 1:1 from backend-py/app.py. Every field is
 * user-scoped and gated with `requireUser`; every query/mutation constrains rows
 * by `owner_id` so one user can never read or mutate another's data.
 */

import { GraphQLError } from "graphql";
import { all, first, loadFoodgroupById, run, sha256b64 } from "../db";
import { memberScope } from "../groups";
import type { Env } from "../types";
import { deletePhoto } from "./photos";
import type { ResolverFn, ResolverSlice } from "./shared";
import { requireUser } from "./shared";

const ALLOWED_LOCATIONS = new Set(["cupboard", "freezer", "fridge", "zerodegreezone"]);

/** Parameterized "?,?,.." placeholder list for an IN clause. */
function inClause(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

const CONTAINER_OPTIONS = [
  { type: "FRESHANDSAVE", sizes: ["S", "M", "L", "XL"] },
  { type: "DRYSTORAGE", sizes: ["S", "M", "L"] },
];

const ORDER: Record<string, string> = {
  CREATION_ASC: "created ASC",
  CREATION_DESC: "created DESC",
  NAME_ASC: "name COLLATE NOCASE ASC",
  NAME_DESC: "name COLLATE NOCASE DESC",
  FREQUENCY_ASC: "modified ASC",
  FREQUENCY_DESC: "modified DESC",
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ── row shapes ────────────────────────────────────────────────────────────────
interface ItemRow {
  cloud_id: string;
  owner_id: string;
  name: string;
  description: string | null;
  foodgroup_id: string | null;
  storageplace: string | null;
  storage_id: string | null;
  container_id: string | null;
  container_json: string | null;
  sealed: number;
  fill_level: string | null;
  type: string | null;
  created: number;
  expire: unknown;
  modified: number;
  state: string;
}
interface ContainerRow {
  container_id: string;
  type: string;
  size: string;
  storage_type: string;
  amount_of_grams: number | null;
  variant: string | null;
  year: string | null;
  code: string | null;
}
interface StorageRow {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  state: string;
}

// ── mappers ───────────────────────────────────────────────────────────────────
function itemHash(row: ItemRow): Promise<string> {
  return sha256b64(`${row.cloud_id}|${row.modified}|${row.state}|${row.name}`);
}

async function mapItem(env: Env, row: ItemRow): Promise<Record<string, unknown>> {
  const storage = row.storage_id
    ? await first<{ name: string }>(env, "SELECT name FROM storages WHERE id=?", row.storage_id)
    : null;
  return {
    cloudId: row.cloud_id,
    name: row.name,
    description: row.description,
    created: row.created,
    expire: row.expire,
    modified: row.modified,
    storageplace: row.storageplace,
    sealed: !!row.sealed,
    owner: row.owner_id,
    hash: await itemHash(row),
    state: row.state,
    type: row.type,
    storageCloudId: row.storage_id,
    storageName: storage ? storage.name : null,
    fillLevel: row.fill_level,
    _foodgroupId: row.foodgroup_id,
    _containerId: row.container_id,
    _containerJson: row.container_json,
    _ownerId: row.owner_id,
  };
}

function mapContainer(row: ContainerRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    containerId: row.container_id,
    type: row.type,
    size: row.size,
    storageType: row.storage_type,
    amountOfGrams: row.amount_of_grams,
    variant: row.variant,
    year: row.year,
    code: row.code,
  };
}

function mapStorage(row: StorageRow): Record<string, unknown> {
  return { id: row.id, name: row.name, type: row.type, owner: row.owner_id };
}

async function listItems(
  env: Env,
  owners: string[],
  order: string,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  let sql = `SELECT * FROM freshandsave_items WHERE owner_id IN (${inClause(
    owners,
  )}) AND state!='REMOVED' ORDER BY ${ORDER[order] ?? "created DESC"}`;
  const args: unknown[] = [...owners];
  if (limit != null) {
    sql += " LIMIT ?";
    args.push(limit);
  }
  const rows = await all<ItemRow>(env, sql, ...args);
  return Promise.all(rows.map((r) => mapItem(env, r)));
}

async function listingHash(items: Record<string, unknown>[]): Promise<string> {
  return sha256b64(items.map((i) => i.hash as string).join("|"));
}

/** Faithful port of Python's dict.get(key, default): present-but-null keeps null. */
function pick<T>(obj: Record<string, unknown> | undefined, key: string, fallback: T): unknown {
  if (obj && Object.hasOwn(obj, key)) return obj[key];
  return fallback;
}

// ── slice ─────────────────────────────────────────────────────────────────────
export const boxResolvers: ResolverSlice = {
  Query: {
    freshandsaveList: async (_p, _args, ctx) => {
      const user = requireUser(ctx);
      const scope = await memberScope(ctx.env, user.id);
      const items = await listItems(ctx.env, scope, "CREATION_DESC");
      return { hash: await listingHash(items), items };
    },

    freshandsaveRecents: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const order = (args.order as string) ?? "CREATION_DESC";
      const limit = args.limit != null ? Number(args.limit) : 20;
      const scope = await memberScope(ctx.env, user.id);
      const items = await listItems(ctx.env, scope, order, limit);
      return { hash: await listingHash(items), items };
    },

    freshandsave: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const scope = await memberScope(ctx.env, user.id);
      const row = await first<ItemRow>(
        ctx.env,
        `SELECT * FROM freshandsave_items WHERE cloud_id=? AND owner_id IN (${inClause(scope)})`,
        args.cloudId,
        ...scope,
      );
      return row ? mapItem(ctx.env, row) : null;
    },

    freshandsaveListStorage: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const states: string[] = [];
      if (args.showActive !== false) states.push("ACTIVE");
      if (args.showInactive === true) states.push("INACTIVE");
      const use = states.length ? states : ["ACTIVE"];
      const ph = use.map(() => "?").join(",");
      const scope = await memberScope(ctx.env, user.id);
      const rows = await all<StorageRow>(
        ctx.env,
        `SELECT * FROM storages WHERE owner_id IN (${inClause(
          scope,
        )}) AND state IN (${ph}) ORDER BY created`,
        ...scope,
        ...use,
      );
      return rows.map(mapStorage);
    },

    containerGet: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      return mapContainer(
        await first<ContainerRow>(
          ctx.env,
          "SELECT * FROM nfc_containers WHERE container_id=? AND owner_id=?",
          args.containerId,
          user.id,
        ),
      );
    },

    containerList: async (_p, _args, ctx) => {
      const user = requireUser(ctx);
      const rows = await all<ContainerRow>(
        ctx.env,
        "SELECT * FROM nfc_containers WHERE owner_id=? ORDER BY created",
        user.id,
      );
      return { containers: rows.map(mapContainer), options: CONTAINER_OPTIONS };
    },
  },

  Mutation: {
    foodgroupCreate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cid = crypto.randomUUID();
      await run(
        ctx.env,
        "INSERT INTO foodgroups (cloud_id,bucket,owner_id,section,icon_name,position) VALUES (?,?,?,?,?,?)",
        cid,
        "CUSTOM",
        user.id,
        args.section ?? null,
        args.iconName ?? null,
        args.position ?? 0,
      );
      await run(
        ctx.env,
        "INSERT INTO foodgroup_names (foodgroup_id,locale,name) VALUES (?,?,?)",
        cid,
        user.locale || "en",
        args.name,
      );
      const storable =
        (args.storable as { location?: string; icon?: string; days?: number }[]) ?? [];
      for (const s of storable) {
        if (s?.location && ALLOWED_LOCATIONS.has(s.location)) {
          await run(
            ctx.env,
            "INSERT INTO foodgroup_storable (foodgroup_id,location,icon,days) VALUES (?,?,?,?)",
            cid,
            s.location,
            s.icon || s.location,
            s.days,
          );
        }
      }
      return { cloudId: cid };
    },

    freshandsaveCreate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cid = crypto.randomUUID();
      const created = nowSec();
      // Expire is a client-supplied string stored verbatim (no normalization).
      const expire = args.expire ?? null;
      const containerJson = args.container ? JSON.stringify(args.container) : null;

      // Family-scoped, exactly like freshandsaveModify: a shared box/storage/group
      // owned by any member of the caller's group may be attached, not just their
      // own. Anything outside the scope silently drops to null.
      const scope = await memberScope(ctx.env, user.id);

      let contId: string | null = null;
      if (args.containerId) {
        const c = await first(
          ctx.env,
          `SELECT container_id FROM nfc_containers WHERE container_id=? AND owner_id IN (${inClause(scope)})`,
          args.containerId,
          ...scope,
        );
        contId = c ? (args.containerId as string) : null;
      }
      let storageId: string | null = null;
      if (args.storageCloudId) {
        const s = await first<{ id: string }>(
          ctx.env,
          `SELECT id FROM storages WHERE id=? AND owner_id IN (${inClause(scope)})`,
          args.storageCloudId,
          ...scope,
        );
        storageId = s ? s.id : null;
      }
      let fgId: string | null = null;
      if (args.foodgroupId) {
        // Only a ZWILLING preset or a CUSTOM group owned within the caller's
        // family may be attached — otherwise a user could reference (and read
        // via FreshAndSave.foodgroup) another tenant's custom group by UUID.
        const f = await first<{ cloud_id: string }>(
          ctx.env,
          `SELECT cloud_id FROM foodgroups WHERE cloud_id=? AND (bucket='ZWILLING' OR owner_id IN (${inClause(scope)}))`,
          args.foodgroupId,
          ...scope,
        );
        fgId = f ? f.cloud_id : null;
      }
      await run(
        ctx.env,
        "INSERT INTO freshandsave_items (cloud_id,owner_id,name,description,foodgroup_id,storageplace," +
          "storage_id,container_id,container_json,sealed,fill_level,type,created,expire,modified,state) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OK')",
        cid,
        user.id,
        args.name,
        args.description ?? null,
        fgId,
        args.storageplace ?? null,
        storageId,
        contId,
        containerJson,
        args.sealed ? 1 : 0,
        args.fillLevel ?? null,
        args.type ?? null,
        created,
        expire,
        created,
      );
      return { cloudId: cid };
    },

    freshandsaveModify: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cloudId = args.cloudId as string;
      const scope = await memberScope(ctx.env, user.id);
      const row = await first<ItemRow>(
        ctx.env,
        `SELECT * FROM freshandsave_items WHERE cloud_id=? AND owner_id IN (${inClause(scope)})`,
        cloudId,
        ...scope,
      );
      if (!row) return { success: false };
      const c = (args.change as Record<string, unknown>) ?? {};
      const sets: string[] = [];
      const vals: unknown[] = [];
      const st = (col: string, v: unknown) => {
        sets.push(`${col}=?`);
        vals.push(v);
      };
      const has = (k: string) => Object.hasOwn(c, k);

      if (has("name")) st("name", c.name);
      if (has("description")) st("description", c.description);
      if (has("storageplace")) st("storageplace", c.storageplace);
      if (c.removeStorageplace) st("storageplace", null);
      if (has("expire")) st("expire", c.expire); // stored verbatim
      if (has("foodgroupId")) {
        // Same scope guard as freshandsaveCreate: only a ZWILLING preset or a
        // group-owned custom foodgroup may be attached, else another tenant's
        // custom foodgroup could be referenced (and read back via .foodgroup).
        let fgId: string | null = null;
        if (c.foodgroupId) {
          const f = await first<{ cloud_id: string }>(
            ctx.env,
            `SELECT cloud_id FROM foodgroups WHERE cloud_id=? AND (bucket='ZWILLING' OR owner_id IN (${inClause(scope)}))`,
            c.foodgroupId,
            ...scope,
          );
          fgId = f ? f.cloud_id : null;
        }
        st("foodgroup_id", fgId);
      }
      if (has("sealed")) st("sealed", c.sealed ? 1 : 0);
      if (has("state")) st("state", c.state);
      if (has("storageCloudId")) {
        let sid: string | null = null;
        if (c.storageCloudId) {
          const s = await first<{ id: string }>(
            ctx.env,
            `SELECT id FROM storages WHERE id=? AND owner_id IN (${inClause(scope)})`,
            c.storageCloudId,
            ...scope,
          );
          sid = s ? s.id : null;
        }
        st("storage_id", sid);
      }
      if (has("fillLevel")) st("fill_level", c.fillLevel);
      if (has("type")) st("type", c.type);
      if (has("container")) st("container_json", c.container ? JSON.stringify(c.container) : null);
      if (has("containerId")) {
        let cid2: string | null = null;
        if (c.containerId) {
          const cc = await first<{ container_id: string }>(
            ctx.env,
            `SELECT container_id FROM nfc_containers WHERE container_id=? AND owner_id IN (${inClause(
              scope,
            )})`,
            c.containerId,
            ...scope,
          );
          cid2 = cc ? cc.container_id : null;
        }
        st("container_id", cid2);
      }
      if (c.removeContainer) {
        st("container_id", null);
        st("container_json", null);
      }
      if (c.clearPhoto) {
        await deletePhoto(ctx.env, [row.owner_id], "FRESHANDSAVE", cloudId);
      }
      st("modified", nowSec());
      await run(
        ctx.env,
        `UPDATE freshandsave_items SET ${sets.join(", ")} WHERE cloud_id=? AND owner_id=?`,
        ...vals,
        cloudId,
        row.owner_id,
      );
      return { success: true };
    },

    freshandsaveDuplicate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cloudId = args.cloudId as string;
      const scope = await memberScope(ctx.env, user.id);
      const row = await first(
        ctx.env,
        `SELECT cloud_id FROM freshandsave_items WHERE cloud_id=? AND owner_id IN (${inClause(scope)})`,
        cloudId,
        ...scope,
      );
      if (!row) throw new GraphQLError("Not found", { extensions: { code: "NOT_FOUND" } });
      const newId = crypto.randomUUID();
      const ts = nowSec();
      await run(
        ctx.env,
        "INSERT INTO freshandsave_items (cloud_id,owner_id,name,description,foodgroup_id,storageplace,storage_id," +
          "container_id,container_json,sealed,fill_level,type,created,expire,modified,state) " +
          "SELECT ?,owner_id,name,description,foodgroup_id,storageplace,storage_id,container_id,container_json," +
          `sealed,fill_level,type,?,expire,?,state FROM freshandsave_items WHERE cloud_id=? AND owner_id IN (${inClause(
            scope,
          )})`,
        newId,
        ts,
        ts,
        cloudId,
        ...scope,
      );
      return { cloudId: newId };
    },

    freshandsaveAddStorage: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const sid = crypto.randomUUID();
      await run(
        ctx.env,
        "INSERT INTO storages (id,owner_id,name,type,state) VALUES (?,?,?,'CUSTOM','ACTIVE')",
        sid,
        user.id,
        args.name,
      );
      const s = await first<StorageRow>(ctx.env, "SELECT * FROM storages WHERE id=?", sid);
      return s ? mapStorage(s) : null;
    },

    freshandsaveModifyStorage: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const cloudId = args.cloudId as string;
      const scope = await memberScope(ctx.env, user.id);
      const exists = await first<{ owner_id: string }>(
        ctx.env,
        `SELECT owner_id FROM storages WHERE id=? AND owner_id IN (${inClause(scope)})`,
        cloudId,
        ...scope,
      );
      if (!exists) throw new GraphQLError("Not found", { extensions: { code: "NOT_FOUND" } });
      await run(
        ctx.env,
        "UPDATE storages SET name=?, state=coalesce(?,state) WHERE id=? AND owner_id=?",
        args.name,
        args.state ?? null,
        cloudId,
        exists.owner_id,
      );
      const s = await first<StorageRow>(ctx.env, "SELECT * FROM storages WHERE id=?", cloudId);
      return s ? mapStorage(s) : null;
    },

    freshandsaveRemoveStorage: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const scope = await memberScope(ctx.env, user.id);
      const res = await run(
        ctx.env,
        `DELETE FROM storages WHERE id=? AND owner_id IN (${inClause(scope)})`,
        args.cloudId,
        ...scope,
      );
      return { success: (res.meta?.changes ?? 0) > 0 };
    },

    containerSave: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const info = (args.info as Record<string, unknown>) ?? {};
      await run(
        ctx.env,
        "INSERT INTO nfc_containers (container_id,owner_id,type,size,storage_type,amount_of_grams,variant,year,code) " +
          "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(container_id,owner_id) DO UPDATE SET type=excluded.type," +
          "size=excluded.size,storage_type=excluded.storage_type,amount_of_grams=excluded.amount_of_grams," +
          "variant=excluded.variant,year=excluded.year,code=excluded.code",
        args.containerId,
        user.id,
        args.containerType,
        args.size,
        args.storageType,
        info.amountOfGrams ?? null,
        info.variant ?? null,
        info.year ?? null,
        info.code ?? null,
      );
      return { success: true };
    },

    containerUpdate: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const info = args.info as Record<string, unknown> | undefined;
      const ex = await first<ContainerRow>(
        ctx.env,
        "SELECT * FROM nfc_containers WHERE container_id=? AND owner_id=?",
        args.containerId,
        user.id,
      );
      if (!ex) return { success: false };
      await run(
        ctx.env,
        "UPDATE nfc_containers SET type=coalesce(?,type),size=coalesce(?,size),storage_type=coalesce(?,storage_type)," +
          "amount_of_grams=?,variant=?,year=?,code=? WHERE container_id=? AND owner_id=?",
        args.containerType ?? null,
        args.size ?? null,
        args.storageType ?? null,
        pick(info, "amountOfGrams", ex.amount_of_grams),
        pick(info, "variant", ex.variant),
        pick(info, "year", ex.year),
        pick(info, "code", ex.code),
        args.containerId,
        user.id,
      );
      return { success: true };
    },

    containerRemove: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const res = await run(
        ctx.env,
        "DELETE FROM nfc_containers WHERE container_id=? AND owner_id=?",
        args.containerId,
        user.id,
      );
      return { success: (res.meta?.changes ?? 0) > 0 };
    },
  },

  FreshAndSave: {
    foodgroup: (item, args, ctx) => {
      const it = item as { _foodgroupId?: string | null };
      if (!it._foodgroupId) return null;
      const locale = (args.locale as string) ?? ctx.user?.locale ?? "en";
      return loadFoodgroupById(ctx.env, it._foodgroupId, locale);
    },

    container: (item) => {
      const it = item as { _containerJson?: string | null };
      if (!it._containerJson) return null;
      try {
        return JSON.parse(it._containerJson);
      } catch {
        return null;
      }
    },

    vessel: async (item, _a, ctx) => {
      const it = item as {
        _containerId?: string | null;
        _containerJson?: string | null;
        _ownerId?: string;
      };
      if (it._containerId && it._ownerId) {
        const row = await first<ContainerRow>(
          ctx.env,
          "SELECT * FROM nfc_containers WHERE container_id=? AND owner_id=?",
          it._containerId,
          it._ownerId,
        );
        if (row) return { __typename: "NfcContainer", ...mapContainer(row) };
      }
      if (it._containerJson) {
        try {
          return { __typename: "Container", ...JSON.parse(it._containerJson) };
        } catch {
          return null;
        }
      }
      return null;
    },
  } as Record<string, ResolverFn>,
};
