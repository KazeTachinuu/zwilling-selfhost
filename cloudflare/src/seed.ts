/**
 * Seed routine for the 21 ZWILLING preset food groups (+ localized names and
 * shelf-life days). Idempotent via INSERT ... ON CONFLICT, so it is safe to run
 * repeatedly. Single source of truth is src/shelf_life.json.
 *
 * Runnable:
 *   - in tests: `await seedPresets(env)` after migrations are applied.
 *   - on deploy: migrations/0002_seed_zwilling.sql applies the same rows via
 *     `wrangler d1 migrations apply DB`. This routine and that SQL are generated
 *     from the same JSON, so they stay in agreement.
 */

import shelfLife from "./shelf_life.json";
import type { Env } from "./types";

interface ShelfLifeGroup {
  cloudId: string;
  section?: string | null;
  iconName?: string | null;
  position?: number;
  names?: Record<string, string>;
  shelfLifeDays?: Record<string, number>;
}
interface ShelfLifeFile {
  count: number;
  groups: ShelfLifeGroup[];
}

/** Upsert all preset food groups. Returns the number of groups seeded. */
export async function seedPresets(env: Env): Promise<number> {
  const data = shelfLife as unknown as ShelfLifeFile;
  const stmts: D1PreparedStatement[] = [];

  const fgSql = env.DB.prepare(
    "INSERT INTO foodgroups (cloud_id,bucket,owner_id,section,icon_name,position) " +
      "VALUES (?,'ZWILLING',NULL,?,?,?) ON CONFLICT(cloud_id) DO UPDATE SET " +
      "section=excluded.section, icon_name=excluded.icon_name, position=excluded.position",
  );
  const nameSql = env.DB.prepare(
    "INSERT INTO foodgroup_names (foodgroup_id,locale,name) VALUES (?,?,?) " +
      "ON CONFLICT(foodgroup_id,locale) DO UPDATE SET name=excluded.name",
  );
  const storableSql = env.DB.prepare(
    "INSERT INTO foodgroup_storable (foodgroup_id,location,icon,days) VALUES (?,?,?,?) " +
      "ON CONFLICT(foodgroup_id,location) DO UPDATE SET icon=excluded.icon, days=excluded.days",
  );

  for (const g of data.groups) {
    stmts.push(fgSql.bind(g.cloudId, g.section ?? null, g.iconName ?? null, g.position ?? 0));
    for (const [locale, name] of Object.entries(g.names ?? {})) {
      stmts.push(nameSql.bind(g.cloudId, locale, name));
    }
    for (const [location, days] of Object.entries(g.shelfLifeDays ?? {})) {
      stmts.push(storableSql.bind(g.cloudId, location, location, days));
    }
  }

  // A single D1 batch runs atomically and counts as one round trip.
  await env.DB.batch(stmts);
  return data.groups.length;
}
