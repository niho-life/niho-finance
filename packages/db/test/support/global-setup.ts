import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { describeDatabaseUrl } from "../../src/env";
import { seedDatabase } from "../../src/seed";
import { resolveTestDatabase } from "./database";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Drops and recreates the test database, applies the migrations with `prisma migrate deploy`, seeds it. */
export default async function setup(): Promise<void> {
  const database = resolveTestDatabase();
  if (!database) {
    console.warn("[test:db] DATABASE_URL is not set: database tests are skipped.");
    return;
  }
  const { database: name, host, port } = describeDatabaseUrl(database.testUrl);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected test database name "${name}"`);

  const admin = new PrismaClient({ datasourceUrl: database.mainUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: database.testUrl },
    stdio: "pipe",
  });

  const prisma = new PrismaClient({ datasourceUrl: database.testUrl });
  try {
    await seedDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
  console.log(`[test:db] ${name} at ${host}:${port}: recreated, migrated and seeded.`);
}
