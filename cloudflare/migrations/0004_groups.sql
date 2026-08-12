CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL,
   created INTEGER NOT NULL DEFAULT (unixepoch()), modified INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL,
   is_owner INTEGER NOT NULL DEFAULT 0, joined INTEGER NOT NULL DEFAULT (unixepoch()),
   PRIMARY KEY (group_id, user_id));
CREATE TABLE group_join_hashes (hash TEXT PRIMARY KEY, group_id TEXT NOT NULL,
   mode TEXT NOT NULL DEFAULT 'PERMANENT', created INTEGER NOT NULL DEFAULT (unixepoch()), expires INTEGER);
CREATE INDEX idx_group_members_user ON group_members(user_id);
CREATE INDEX idx_group_join_hashes_group ON group_join_hashes(group_id);
