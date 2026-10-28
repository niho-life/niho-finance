import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_TABLES,
  exportBackup,
  exportBackupSnapshot,
  restoreBackupSnapshot,
  trialBalancesForBackup,
  type BackupSnapshot,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { restoreTestPrisma, testPrisma } from "./support/prisma";

/** What the export files hold: the JSON text read back. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Export of the seeded test database, restored into the migrated-only restore database
 * (`<test db>_restore`, not shared with the setup wizard test). One test builds on the previous.
 */
/** An imported CSV kept as bytes (`import_batch.file_bytes`, S4): written as base64. */
const BYTES_BATCH_ID = "01JBACKUPBYTESTEST00000000";
const CSV_TEXT = "日付,金額\n2026-11-20,1000\n";

describe.skipIf(!hasTestDatabase)("backup export and restore", () => {
  let source: PrismaClient;
  let target: PrismaClient;
  let snapshot: BackupSnapshot;

  beforeAll(async () => {
    source = testPrisma();
    target = restoreTestPrisma();
    const wallet = await source.wallet.findFirstOrThrow({ orderBy: { id: "asc" } });
    await source.importBatch.create({
      data: {
        id: BYTES_BATCH_ID,
        walletId: wallet.id,
        source: "csv",
        originalName: "fictional.csv",
        fileBytes: Buffer.from(CSV_TEXT, "utf8"),
        executedBy: "tester@example.com",
      },
    });
  });

  // The test database is shared by the files: take the batch out again.
  afterAll(async () => {
    await source?.importBatch.deleteMany({ where: { id: BYTES_BATCH_ID } });
  });

  it("exports every table with JSON-safe values and the applied migration", async () => {
    const exported = await exportBackup(source, { now: new Date("2026-11-20T18:00:00.000Z") });
    snapshot = roundTrip(exported.snapshot);
    expect(snapshot.format).toBe("niho-finance-snapshot");
    expect(snapshot.exportedAt).toBe("2026-11-20T18:00:00.000Z");
    expect(snapshot.migration).toMatch(/^\d{14}_/);
    expect(Object.keys(snapshot.tables)).toEqual(BACKUP_TABLES.map((entry) => entry.table));
    const line = snapshot.tables.journal_line?.[0];
    expect(typeof line?.amount).toBe("string");
    expect(line).toHaveProperty("journal_entry_id");
    expect(snapshot.tables.company?.[0]?.founded_on).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(exported.trialBalances.length).toBe(await source.fiscalYear.count());
    expect(exported.extra).toBeUndefined();
    const batch = snapshot.tables.import_batch?.find((row) => row.id === BYTES_BATCH_ID);
    expect(batch?.file_bytes).toBe(Buffer.from(CSV_TEXT, "utf8").toString("base64"));
  });

  it("reads the extra source in the same view as the snapshot", async () => {
    const exported = await exportBackup(source, {
      extra: async (tx) => tx.journalEntry.count(),
    });
    expect(exported.extra).toBe(exported.snapshot.tables.journal_entry?.length);
  });

  it("restores into an empty database with the same rows and trial balances", async () => {
    const result = await restoreBackupSnapshot(target, snapshot);
    for (const { table, model } of BACKUP_TABLES) {
      const delegate = (target as unknown as Record<string, { count(): Promise<number> }>)[
        `${model.charAt(0).toLowerCase()}${model.slice(1)}`
      ];
      expect(result.tables[table], table).toBe(snapshot.tables[table]?.length);
      expect(await delegate?.count(), table).toBe(snapshot.tables[table]?.length);
    }
    expect(await target.auditLog.count()).toBe(await source.auditLog.count());
    const batch = await target.importBatch.findUniqueOrThrow({ where: { id: BYTES_BATCH_ID } });
    expect(Buffer.from(batch.fileBytes ?? new Uint8Array()).toString("utf8")).toBe(CSV_TEXT);
    expect(await target.journalEntry.count({ where: { status: "voided" } })).toBeGreaterThan(0);
    expect(await trialBalancesForBackup(target)).toEqual(
      roundTrip(await trialBalancesForBackup(source)),
    );
    // Every row and column comes back as it was (IDs, timestamps, voids and links included).
    const again = roundTrip(await exportBackupSnapshot(target));
    expect(again.tables).toEqual(snapshot.tables);
  });

  it("keeps the ledger guards in force on the restored book", async () => {
    const line = await target.journalLine.findFirstOrThrow();
    await expect(
      target.journalLine.update({ where: { id: line.id }, data: { description: "changed" } }),
    ).rejects.toThrow(/ledger guard/);
    const entry = await target.journalEntry.findFirstOrThrow({ where: { status: "posted" } });
    await expect(
      target.journalEntry.update({ where: { id: entry.id }, data: { description: "changed" } }),
    ).rejects.toThrow(/ledger guard/);
  });

  it("refuses to restore into a database that is not empty", async () => {
    await expect(restoreBackupSnapshot(target, snapshot)).rejects.toThrow(/空ではありません/);
    await expect(restoreBackupSnapshot(source, snapshot)).rejects.toThrow(/空ではありません/);
  });

  it("refuses a file that is not a snapshot or has columns the schema lacks", async () => {
    await expect(
      restoreBackupSnapshot(target, { ...snapshot, format: "other" } as unknown as BackupSnapshot),
    ).rejects.toThrow(/スナップショットではありません/);
    const extraColumn = roundTrip(snapshot);
    const company = extraColumn.tables.company?.[0];
    if (company) company.removed_column = "x";
    await expect(restoreBackupSnapshot(target, extraColumn)).rejects.toThrow(/removed_column/);
  });
});
