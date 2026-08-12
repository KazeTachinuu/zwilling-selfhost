-- 0003_login_attempts.sql
-- Login rate-limiting + exponential backoff state. One row per (username|ip)
-- key. See src/security.ts. Rows are transient; a successful login deletes the
-- row and stale streaks reset on the next failure.

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  first_fail INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);
