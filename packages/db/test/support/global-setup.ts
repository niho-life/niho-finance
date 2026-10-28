import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { describeDatabaseUrl } from "../../src/env";
import { seedDatabase } from "../../src/seed";
import { resolveTestDatabase } from "./database";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function databaseName(url: string): string {
  const { database } = describeDatabaseUrl(url);
  if (!/^[a-z0-9_]+$/.test(database))
    throw new Error(`Unexpected test database name "${database}"`);
  return database;
}

/**
 * Drops and recreates the test database, applies the migrations with `prisma migrate deploy`,
 * copies it (migrated, still empty) to the empty test database, then seeds the test database.
 * The teardown drops the empty test database.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const database = resolveTestDatabase();
  if (!database) {
    console.warn("[test:db] DATABASE_URL is not set: database tests are skipped.");
    return undefined;
  }
  const name = databaseName(database.testUrl);
  const emptyName = databaseName(database.emptyUrl);
  const { host, port } = describeDatabaseUrl(database.testUrl);

  const admin = new PrismaClient({ datasourceUrl: database.mainUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${emptyName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: database.testUrl },
      stdio: "pipe",
    });
    // Nothing is connected to the migrated test database yet, so it can serve as a template.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${emptyName}" TEMPLATE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const prisma = new PrismaClient({ datasourceUrl: database.testUrl });
  try {
    await seedDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `[test:db] ${name} at ${host}:${port}: recreated, migrated and seeded; ${emptyName}: migrated only.`,
  );

  return async () => {
    const teardown = new PrismaClient({ datasourceUrl: database.mainUrl });
    try {
      await teardown.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${emptyName}" WITH (FORCE)`);
    } finally {
      await teardown.$disconnect();
    }
  };
}
