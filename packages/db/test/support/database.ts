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
  /** Migrated but not seeded (the setup wizard starts from nothing): the test database + `_empty`. */
  emptyUrl: string;
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export function deriveTestDatabaseUrl(mainUrl: string): string {
  return withDatabaseName(mainUrl, `${describeDatabaseUrl(mainUrl).database}_test`);
}

export function deriveEmptyDatabaseUrl(testUrl: string): string {
  return withDatabaseName(testUrl, `${describeDatabaseUrl(testUrl).database}_empty`);
}

/** `null` when `DATABASE_URL` is not set (database tests are then skipped). */
export function resolveTestDatabase(): TestDatabase | null {
  const mainUrl = optionalDatabaseUrl();
  if (!mainUrl) return null;
  const testUrl = process.env.TEST_DATABASE_URL ?? deriveTestDatabaseUrl(mainUrl);
  const emptyUrl = deriveEmptyDatabaseUrl(testUrl);
  assertNihoFinanceDatabase(testUrl);
  assertNihoFinanceDatabase(emptyUrl);
  const main = describeDatabaseUrl(mainUrl);
  for (const url of [testUrl, emptyUrl]) {
    const test = describeDatabaseUrl(url);
    if (main.host === test.host && main.port === test.port && main.database === test.database) {
      throw new Error(
        "The test databases must differ from DATABASE_URL: they are dropped on every run.",
      );
    }
  }
  return { mainUrl, testUrl, emptyUrl };
}

/** True inside database test workers (set by vitest.db.config.ts). */
export const hasTestDatabase = Boolean(process.env.NIHO_FINANCE_MAIN_DATABASE_URL);
