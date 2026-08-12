// Vitest setup file: apply D1 migrations into the isolated test database before
// the suite runs. `applyD1Migrations` records applied migrations, so this is
// idempotent across files. Migrations include 0002_seed_zwilling.sql, so the 21
// presets are present; smoke.test.ts additionally exercises the JS seedPresets()
// routine to prove its idempotency.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
