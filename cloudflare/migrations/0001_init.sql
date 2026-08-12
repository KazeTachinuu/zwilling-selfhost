-- 0001_init.sql
-- Ported from backend-py/app.py DDL, adapted for Cloudflare D1 (SQLite).
-- D1 applies migrations statement-by-statement; keep one statement per block.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  name TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  modified INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS foodgroups (
  cloud_id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL CHECK (bucket IN ('ZWILLING','CUSTOM')),
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  section TEXT,
  icon_name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'OK',
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((bucket='ZWILLING' AND owner_id IS NULL) OR (bucket='CUSTOM' AND owner_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_foodgroups_owner ON foodgroups(owner_id);
CREATE INDEX IF NOT EXISTS idx_foodgroups_bucket ON foodgroups(bucket);

CREATE TABLE IF NOT EXISTS foodgroup_names (
  foodgroup_id TEXT NOT NULL REFERENCES foodgroups(cloud_id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (foodgroup_id, locale)
);

CREATE TABLE IF NOT EXISTS foodgroup_storable (
  foodgroup_id TEXT NOT NULL REFERENCES foodgroups(cloud_id) ON DELETE CASCADE,
  location TEXT NOT NULL CHECK (location IN ('cupboard','freezer','fridge','zerodegreezone')),
  icon TEXT,
  days INTEGER NOT NULL,
  PRIMARY KEY (foodgroup_id, location)
);

CREATE TABLE IF NOT EXISTS storages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CUSTOM' CHECK (type IN ('CUSTOM','PRESET')),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  created INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_storages_owner ON storages(owner_id);

CREATE TABLE IF NOT EXISTS nfc_containers (
  container_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  size TEXT NOT NULL,
  storage_type TEXT NOT NULL,
  amount_of_grams INTEGER,
  variant TEXT,
  year TEXT,
  code TEXT,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (container_id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_containers_owner ON nfc_containers(owner_id);

CREATE TABLE IF NOT EXISTS freshandsave_items (
  cloud_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  foodgroup_id TEXT REFERENCES foodgroups(cloud_id) ON DELETE SET NULL,
  storageplace TEXT CHECK (storageplace IS NULL OR storageplace IN
    ('CUPBOARD','FREEZER','FRESHZONE','FRIDGE','SHELF','ZERODEGREEZONE')),
  storage_id TEXT REFERENCES storages(id) ON DELETE SET NULL,
  container_id TEXT,
  container_json TEXT,
  sealed INTEGER NOT NULL DEFAULT 0,
  fill_level TEXT CHECK (fill_level IS NULL OR fill_level IN ('EMPTY','LOW','MEDIUM','FULL')),
  type TEXT,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  expire TEXT,
  modified INTEGER NOT NULL DEFAULT (unixepoch()),
  state TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','ARCHIVED','REMOVED')),
  FOREIGN KEY (container_id, owner_id) REFERENCES nfc_containers(container_id, owner_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_items_owner ON freshandsave_items(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_owner_state ON freshandsave_items(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_items_expire ON freshandsave_items(owner_id, expire);

CREATE TABLE IF NOT EXISTS settings (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'GENERAL',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner_id, type, key)
);

CREATE TABLE IF NOT EXISTS shoppinglists (
  cloud_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','ARCHIVED','REMOVED')),
  categories_json TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  modified INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_shoppinglists_owner ON shoppinglists(owner_id);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  json TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id);

CREATE TABLE IF NOT EXISTS device_tokens (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  token TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (owner_id, type, token)
);

-- New table (not in the Python reference): photo metadata. Bytes live in R2 under
-- r2_key; this row is the index. One photo per (owner, entity_type, entity_id).
CREATE TABLE IF NOT EXISTS photos (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (owner_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_photos_owner ON photos(owner_id);
