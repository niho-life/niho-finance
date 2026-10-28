import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
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
describe.skipIf(!hasTestDatabase)("backup export and restore", () => {
  let source: PrismaClient;
  let target: PrismaClient;
  let snapshot: BackupSnapshot;

  beforeAll(() => {
    source = testPrisma();
    target = restoreTestPrisma();
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
