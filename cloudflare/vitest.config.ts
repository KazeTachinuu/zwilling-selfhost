import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Read D1 migrations at config time and expose them to tests as a binding,
      // so a setup file can apply them into the isolated test database.
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Non-default secret so the production secret-guard is satisfied
            // WITHOUT enabling DEV: the suite therefore runs against the fully
            // hardened path (introspection off, field suggestions stripped,
            // depth/cost limits on, rate-limiting active).
            JWT_SECRET: "test-secret-not-the-dev-default-0123456789",
            // Tests create accounts via authLogin, so open registration is on
            // for the test env only (production defaults to closed).
            ALLOW_REGISTRATION: "true",
            DEV: "false",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
