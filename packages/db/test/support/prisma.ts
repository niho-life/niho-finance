import type { PrismaClient } from "@prisma/client";
import { afterAll } from "vitest";
import { createPrismaClient } from "../../src/client";
import { hasTestDatabase } from "./database";

let client: PrismaClient | undefined;

/** The client for the test database (DATABASE_URL is the test database inside test workers). */
export function testPrisma(): PrismaClient {
  if (!hasTestDatabase) throw new Error("testPrisma() is only available in database tests");
  client ??= createPrismaClient();
  return client;
}

afterAll(async () => {
  await client?.$disconnect();
  client = undefined;
});
