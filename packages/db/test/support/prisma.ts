import type { PrismaClient } from "@prisma/client";
import { afterAll } from "vitest";
import { createPrismaClient } from "../../src/client";
import { hasTestDatabase } from "./database";

let client: PrismaClient | undefined;
let emptyClient: PrismaClient | undefined;

/** The client for the test database (DATABASE_URL is the test database inside test workers). */
export function testPrisma(): PrismaClient {
  if (!hasTestDatabase) throw new Error("testPrisma() is only available in database tests");
  client ??= createPrismaClient();
  return client;
}

/**
 * The client for the empty test database (migrated, not seeded). One test file drives it from
 * nothing through the whole setup, so only that file may use it.
 */
export function emptyTestPrisma(): PrismaClient {
  const databaseUrl = process.env.NIHO_FINANCE_EMPTY_DATABASE_URL;
  if (!hasTestDatabase || !databaseUrl) {
    throw new Error("emptyTestPrisma() is only available in database tests");
  }
  emptyClient ??= createPrismaClient({ databaseUrl });
  return emptyClient;
}

afterAll(async () => {
  await client?.$disconnect();
  await emptyClient?.$disconnect();
  client = undefined;
  emptyClient = undefined;
});
