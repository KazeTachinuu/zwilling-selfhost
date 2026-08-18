import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// The vitest pool types `env` as `Cloudflare.Env`. Augment it with the
// migrations binding injected by vitest.config.ts so tests are typed.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
