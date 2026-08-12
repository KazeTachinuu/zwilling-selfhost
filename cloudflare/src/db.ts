/**
 * D1 access helpers and domain mappers. All data reaches resolvers through
 * `ctx.env.DB` (a D1Database). Keep query counts low: D1 statements count toward
 * the Workers subrequest budget, so list endpoints batch (a handful of queries,
 * assembled in JS) rather than issuing one query per row.
 */

import type { Env } from "./types";

// ── generic helpers ─────────────────────────────────────────────────────────
export function first<T = Record<string, unknown>>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}

export async function all<T = Record<string, unknown>>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  const res = await env.DB.prepare(sql)
    .bind(...args)
    .all<T>();
  return res.results ?? [];
}

export function run(env: Env, sql: string, ...args: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}

/** SHA-256 -> base64 (matches the Python reference's sha256b64 hashing). */
export async function sha256b64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ── foodgroup domain ────────────────────────────────────────────────────────
interface FoodgroupRow {
  cloud_id: string;
  bucket: string;
  owner_id: string | null;
  section: string | null;
  icon_name: string | null;
  position: number;
  state: string | null;
}
interface NameRow {
  foodgroup_id: string;
  locale: string;
  name: string;
}
interface StorableRow {
  foodgroup_id: string;
  location: string;
  icon: string | null;
  days: number;
}

/** A FoodGroup shaped to the GraphQL `FoodGroup` type. */
export interface MappedFoodgroup {
  cloudId: string;
  state: string;
  owner: string;
  bucket: string;
  hash: string;
  name: string | null;
  section: string | null;
  iconName: string | null;
  icon: null;
  iconActive: null;
  iconAnimated: null;
  iconPreview: null;
  position: number;
  storable: { location: string; icon: string | null; days: number }[];
}

async function assembleFoodgroups(
  rows: FoodgroupRow[],
  names: NameRow[],
  storables: StorableRow[],
  locale: string,
): Promise<MappedFoodgroup[]> {
  const nameByGroup = new Map<string, Map<string, string>>();
  for (const n of names) {
    let m = nameByGroup.get(n.foodgroup_id);
    if (!m) nameByGroup.set(n.foodgroup_id, (m = new Map()));
    m.set(n.locale, n.name);
  }
  const storableByGroup = new Map<string, StorableRow[]>();
  for (const s of storables) {
    let arr = storableByGroup.get(s.foodgroup_id);
    if (!arr) storableByGroup.set(s.foodgroup_id, (arr = []));
    arr.push(s);
  }

  const out: MappedFoodgroup[] = [];
  for (const row of rows) {
    const locales = nameByGroup.get(row.cloud_id);
    const name =
      locales?.get(locale) ?? locales?.get("en") ?? locales?.values().next().value ?? null;
    const storable = (storableByGroup.get(row.cloud_id) ?? [])
      .sort((a, b) => a.location.localeCompare(b.location))
      .map((s) => ({ location: s.location, icon: s.icon, days: s.days }));
    const hash = await sha256b64(`${row.cloud_id}|${name}|${JSON.stringify(storable)}`);
    out.push({
      cloudId: row.cloud_id,
      state: row.state || "OK",
      owner: row.owner_id || "",
      bucket: row.bucket,
      hash,
      name,
      section: row.section,
      iconName: row.icon_name,
      icon: null,
      iconActive: null,
      iconAnimated: null,
      iconPreview: null,
      position: row.position,
      storable,
    });
  }
  return out;
}

/** Public: all 21 ZWILLING preset food groups, localized. 3 D1 queries total. */
export async function listZwillingFoodgroups(env: Env, locale: string): Promise<MappedFoodgroup[]> {
  const rows = await all<FoodgroupRow>(
    env,
    "SELECT * FROM foodgroups WHERE bucket='ZWILLING' ORDER BY position, cloud_id",
  );
  const ids = rows.map((r) => r.cloud_id);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const [names, storables] = await Promise.all([
    all<NameRow>(
      env,
      `SELECT foodgroup_id, locale, name FROM foodgroup_names WHERE foodgroup_id IN (${placeholders})`,
      ...ids,
    ),
    all<StorableRow>(
      env,
      `SELECT foodgroup_id, location, icon, days FROM foodgroup_storable WHERE foodgroup_id IN (${placeholders})`,
      ...ids,
    ),
  ]);
  return assembleFoodgroups(rows, names, storables, locale);
}

/** Group-scoped: CUSTOM food groups shared across the caller's member scope. */
export async function listCustomFoodgroups(
  env: Env,
  owners: string[],
  locale: string,
): Promise<MappedFoodgroup[]> {
  const ownerPlaceholders = owners.map(() => "?").join(",");
  const rows = await all<FoodgroupRow>(
    env,
    `SELECT * FROM foodgroups WHERE bucket='CUSTOM' AND owner_id IN (${ownerPlaceholders}) ORDER BY position, cloud_id`,
    ...owners,
  );
  const ids = rows.map((r) => r.cloud_id);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const [names, storables] = await Promise.all([
    all<NameRow>(
      env,
      `SELECT foodgroup_id, locale, name FROM foodgroup_names WHERE foodgroup_id IN (${placeholders})`,
      ...ids,
    ),
    all<StorableRow>(
      env,
      `SELECT foodgroup_id, location, icon, days FROM foodgroup_storable WHERE foodgroup_id IN (${placeholders})`,
      ...ids,
    ),
  ]);
  return assembleFoodgroups(rows, names, storables, locale);
}

/** Load a single food group by cloud id, localized. Used by FreshAndSave.foodgroup. */
export async function loadFoodgroupById(
  env: Env,
  cloudId: string,
  locale: string,
): Promise<MappedFoodgroup | null> {
  const row = await first<FoodgroupRow>(env, "SELECT * FROM foodgroups WHERE cloud_id=?", cloudId);
  if (!row) return null;
  const [names, storables] = await Promise.all([
    all<NameRow>(
      env,
      "SELECT foodgroup_id, locale, name FROM foodgroup_names WHERE foodgroup_id=?",
      cloudId,
    ),
    all<StorableRow>(
      env,
      "SELECT foodgroup_id, location, icon, days FROM foodgroup_storable WHERE foodgroup_id=?",
      cloudId,
    ),
  ]);
  return (await assembleFoodgroups([row], names, storables, locale))[0] ?? null;
}

// ── users ───────────────────────────────────────────────────────────────────
const SITE_LOCALE: Record<string, string> = { DE: "de", FR: "fr", IT: "it", ES: "es", BE: "nl" };

export function localeForSite(siteId: string): string {
  return SITE_LOCALE[siteId] ?? "en";
}
