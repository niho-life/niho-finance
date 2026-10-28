import path from "node:path";
import { defineConfig } from "prisma/config";
import { assertNihoFinanceDatabase, loadRootEnv } from "./src/env";

// With a config file Prisma does not read `.env` itself: apply the repository root `.env`.
loadRootEnv();

// Commands that connect to the database must never run against another project's database.
const DATABASE_COMMANDS = new Set(["migrate", "db", "studio"]);
const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (command && DATABASE_COMMANDS.has(command) && process.env.DATABASE_URL) {
  assertNihoFinanceDatabase(process.env.DATABASE_URL);
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
});
