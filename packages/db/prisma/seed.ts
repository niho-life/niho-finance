// `npm run db:seed` (prisma db seed). Seeds an empty database with fictional data; a seeded one is left
// as is, except that a book seeded before the statements (S5) gets the sample rules and statement lines.
import { createPrismaClient } from "../src/client";
import { describeDatabaseUrl, requireDatabaseUrl } from "../src/env";
import { seedDatabase } from "../src/seed";

const databaseUrl = requireDatabaseUrl();
const { host, port, database } = describeDatabaseUrl(databaseUrl);
const prisma = createPrismaClient({ databaseUrl });
try {
  const result = await seedDatabase(prisma);
  console.log(
    result.seeded
      ? `Seeded ${database} at ${host}:${port}: fiscal year 1 with ${result.entryCount} entries.`
      : result.statementsAdded
        ? `${database} at ${host}:${port} already has a company; added the sample rules and statement lines.`
        : `${database} at ${host}:${port} already has a company; seed skipped.`,
  );
} finally {
  await prisma.$disconnect();
}
