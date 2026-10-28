import { PrismaClient } from "@prisma/client";
import { requireDatabaseUrl } from "./env";

export interface CreatePrismaClientOptions {
  /** Defaults to `DATABASE_URL` (checked to be a niho-finance database). */
  databaseUrl?: string;
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({ datasourceUrl: options.databaseUrl ?? requireDatabaseUrl() });
}

const globalForPrisma = globalThis as typeof globalThis & { __nihoFinancePrisma?: PrismaClient };

/** One shared client per process (Next.js dev reloads modules; the client must not multiply). */
export function getPrismaClient(): PrismaClient {
  globalForPrisma.__nihoFinancePrisma ??= createPrismaClient();
  return globalForPrisma.__nihoFinancePrisma;
}
