import type { Prisma } from "@prisma/client";
import type { Db } from "./audit";

export type Tx = Prisma.TransactionClient;

export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Runs `fn` in a transaction: a new one for a client, or the caller's when `db` already is a
 * transaction (so writes compose, e.g. the setup creating several wallets at once).
 */
export async function runInTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ("$transaction" in db) return db.$transaction(fn, TRANSACTION_OPTIONS);
  return fn(db);
}

/** Advisory lock keys (transaction-scoped) for settings writes that must not race. */
const LOCK_KEYS = {
  /** The single company row and the setup progress stored on it. */
  company: 7_301_001,
  /** Fiscal year creation (numbering of 第 n 期 and contiguous periods). */
  fiscalYears: 7_301_002,
  /** Standard data (tax categories, rules, segments, the chart). */
  standardData: 7_301_003,
  /** Bank API connections (one bank account belongs to one wallet, 19-bank-api §1.1). */
  bankLinks: 7_301_004,
} as const;

export type SettingsLock = keyof typeof LOCK_KEYS;

/** Takes a transaction-scoped advisory lock: concurrent writers of the same kind wait in turn. */
export async function lockSettings(tx: Tx, lock: SettingsLock): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_KEYS[lock]}::bigint)::text AS "locked"`;
}
