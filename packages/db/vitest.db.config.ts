import { defineConfig } from "vitest/config";
// Explicit extensions: Vite's native config loader (its future default) needs them.
import { resolveTestDatabase } from "./test/support/database.ts";

// `npm run test:db`: a throwaway database `<DATABASE_URL db>_test` is recreated, migrated and seeded
// by the global setup, and `<…>_test_empty` and `<…>_test_restore` are recreated and migrated only
// (the setup wizard tests start from an empty book; the backup test restores into the other one).
// Without DATABASE_URL every database test is skipped.
const database = resolveTestDatabase();

export default defineConfig({
  test: {
    include: ["test/**/*.db.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: database
      ? {
          DATABASE_URL: database.testUrl,
          NIHO_FINANCE_MAIN_DATABASE_URL: database.mainUrl,
          NIHO_FINANCE_EMPTY_DATABASE_URL: database.emptyUrl,
          NIHO_FINANCE_RESTORE_DATABASE_URL: database.restoreUrl,
        }
      : {},
  },
});
