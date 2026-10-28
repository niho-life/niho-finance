import {
  assertNihoFinanceDatabase,
  describeDatabaseUrl,
  optionalDatabaseUrl,
} from "../../src/env.ts";

export interface TestDatabase {
  /** The developer's / CI database (`DATABASE_URL`). Only read by the tests. */
  mainUrl: string;
  /** Recreated for every run: `TEST_DATABASE_URL`, or the main database name + `_test`. */
  testUrl: string;
}

export function deriveTestDatabaseUrl(mainUrl: string): string {
  const url = new URL(mainUrl);
  const { database } = describeDatabaseUrl(mainUrl);
  url.pathname = `/${database}_test`;
  return url.toString();
}

/** `null` when `DATABASE_URL` is not set (database tests are then skipped). */
export function resolveTestDatabase(): TestDatabase | null {
  const mainUrl = optionalDatabaseUrl();
  if (!mainUrl) return null;
  const testUrl = process.env.TEST_DATABASE_URL ?? deriveTestDatabaseUrl(mainUrl);
  assertNihoFinanceDatabase(testUrl);
  const main = describeDatabaseUrl(mainUrl);
  const test = describeDatabaseUrl(testUrl);
  if (main.host === test.host && main.port === test.port && main.database === test.database) {
    throw new Error("The test database must differ from DATABASE_URL: it is dropped on every run.");
  }
  return { mainUrl, testUrl };
}

/** True inside database test workers (set by vitest.db.config.ts). */
export const hasTestDatabase = Boolean(process.env.NIHO_FINANCE_MAIN_DATABASE_URL);
