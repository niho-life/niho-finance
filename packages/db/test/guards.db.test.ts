/**
 * The DB triggers of migration `*_ledger_guards`, exercised with direct SQL / Prisma writes that
 * bypass the repository layer (as a buggy caller would).
 */
import type { FiscalYear, Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, postJournalEntry, toDbDate } from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

describe.skipIf(!hasTestDatabase)("ledger guards (DB triggers)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let guardYear: FiscalYear;
  let entryNo = 1_000;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    // A far-away year so the direct inserts below never touch the seeded year 1.
    guardYear = await createFiscalYear(prisma, {
      no: 90,
      startDate: "2035-04-01",
      endDate: "2036-03-31",
    });
  });

  function line(
    side: "debit" | "credit",
    code: string,
    amount: bigint,
  ): Prisma.JournalLineUncheckedCreateWithoutJournalEntryInput {
    return {
      id: newId(),
      lineNo: 0,
      side,
      accountId: refs.account(code),
      amount,
      taxCategoryCode: "na",
      taxAmount: 0n,
    };
  }

  /** Inserts an entry directly (no ledger validation) in one transaction. */
  async function insertEntry(
    lines: Prisma.JournalLineUncheckedCreateWithoutJournalEntryInput[],
    overrides: Partial<Prisma.JournalEntryUncheckedCreateInput> = {},
  ) {
    const id = newId();
    entryNo += 1;
    await prisma.journalEntry.create({
      data: {
        id,
        fiscalYearId: guardYear.id,
        no: entryNo,
        entryDate: toDbDate("2035-04-10"),
        description: "直接登録",
        kind: "normal",
        sourceKind: "manual",
        createdBy: "test",
        ...overrides,
        lines: { create: lines.map((l, index) => ({ ...l, lineNo: index + 1 })) },
      },
    });
    return id;
  }

  async function balancedEntry() {
    const id = await insertEntry([line("debit", "1100", 1_000n), line("credit", "3000", 1_000n)]);
    return prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  }

  describe("1. journal_line is append-only", () => {
    it("rejects UPDATE and DELETE of a line", async () => {
      const entry = await balancedEntry();
      const target = entry.lines[0]!;
      await expect(
        prisma.journalLine.update({ where: { id: target.id }, data: { amount: 2_000n } }),
      ).rejects.toThrow(/ledger guard: journal_line is append-only \(UPDATE/);
      await expect(prisma.journalLine.delete({ where: { id: target.id } })).rejects.toThrow(
        /ledger guard: journal_line is append-only \(DELETE/,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "journal_line" SET "description" = 'x' WHERE "id" = $1`,
          target.id,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it("rejects TRUNCATE", async () => {
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "journal_line" CASCADE`)).rejects.toThrow(
        /ledger guard: TRUNCATE on journal_line is not allowed/,
      );
    });

    it("rejects adding lines to an entry from an earlier transaction, even balanced ones", async () => {
      const entry = await balancedEntry();
      await expect(
        prisma.journalLine.createMany({
          data: [
            { ...line("debit", "1100", 500n), journalEntryId: entry.id, lineNo: 3 },
            { ...line("credit", "3000", 500n), journalEntryId: entry.id, lineNo: 4 },
          ],
        }),
      ).rejects.toThrow(/ledger guard: lines can only be added together with their entry/);
    });
  });

  describe("2. journal_entry is immutable except for voiding", () => {
    it("rejects DELETE and TRUNCATE", async () => {
      const entry = await balancedEntry();
      await expect(prisma.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
        /ledger guard: journal_entry .* cannot be deleted/,
      );
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "journal_entry" CASCADE`)).rejects.toThrow(
        /TRUNCATE on journal_entry/,
      );
    });

    it("rejects changing any other column", async () => {
      const entry = await balancedEntry();
      const changes: Prisma.JournalEntryUncheckedUpdateInput[] = [
        { description: "書き換え" },
        { entryDate: toDbDate("2035-04-11") },
        { no: 99_999 },
        { kind: "adjusting" },
        { createdBy: "someone-else" },
      ];
      for (const data of changes) {
        await expect(prisma.journalEntry.update({ where: { id: entry.id }, data })).rejects.toThrow(
          /ledger guard: journal_entry .* is immutable/,
        );
      }
    });

    it("allows posted → voided once, then only replaced_by_id may be set once", async () => {
      const entry = await balancedEntry();
      const replacement = await balancedEntry();
      await prisma.journalEntry.update({
        where: { id: entry.id },
        data: { status: "voided", voidedAt: new Date(), voidReason: "誤り" },
      });
      await expect(
        prisma.journalEntry.update({
          where: { id: entry.id },
          data: { status: "posted", voidedAt: null },
        }),
      ).rejects.toThrow(/status can only change from posted to voided/);
      await expect(
        prisma.journalEntry.update({ where: { id: entry.id }, data: { voidReason: "別の理由" } }),
      ).rejects.toThrow(/are set only when it is voided/);
      await prisma.journalEntry.update({
        where: { id: entry.id },
        data: { replacedById: replacement.id },
      });
      await expect(
        prisma.journalEntry.update({ where: { id: entry.id }, data: { replacedById: entry.id } }),
      ).rejects.toThrow(/replaced_by_id .* is already set/);
    });

    it("rejects an entry inserted as voided", async () => {
      await expect(
        insertEntry([line("debit", "1100", 1n), line("credit", "3000", 1n)], {
          status: "voided",
          voidedAt: new Date(),
          voidReason: "x",
        }),
      ).rejects.toThrow(/must be inserted as posted/);
    });
  });

  describe("3. audit_log is append-only", () => {
    it("rejects UPDATE, DELETE and TRUNCATE", async () => {
      const row = await prisma.auditLog.findFirstOrThrow();
      await expect(
        prisma.auditLog.update({ where: { id: row.id }, data: { reason: "改ざん" } }),
      ).rejects.toThrow(/ledger guard: audit_log is append-only \(UPDATE/);
      await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
        /audit_log is append-only \(DELETE/,
      );
      await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/audit_log is append-only/);
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "audit_log"`)).rejects.toThrow(
        /TRUNCATE on audit_log/,
      );
    });
  });

  describe("4. document files are never deleted or swapped", () => {
    it("rejects DELETE and changes of the stored file, allows status changes", async () => {
      const document = await prisma.document.create({
        data: {
          id: newId(),
          kind: "receipt",
          storageKey: `test/${newId()}.pdf`,
          sha256: "0".repeat(64),
          mime: "application/pdf",
          byteSize: 1_234,
          uploadedBy: "test",
          source: "upload",
        },
      });
      await prisma.document.update({
        where: { id: document.id },
        data: {
          status: "voided",
          voidedAt: new Date(),
          voidReason: "重複",
          partnerName: "架空商店",
        },
      });
      for (const data of [
        { sha256: "1".repeat(64) },
        { storageKey: "test/other.pdf" },
        { byteSize: 1 },
        { mime: "image/png" },
      ]) {
        await expect(prisma.document.update({ where: { id: document.id }, data })).rejects.toThrow(
          /ledger guard: storage_key, sha256, byte_size and mime of document .* cannot change/,
        );
      }
      await expect(prisma.document.delete({ where: { id: document.id } })).rejects.toThrow(
        /document .* cannot be deleted/,
      );
    });
  });

  describe("5. entries are balanced with 2+ lines at COMMIT", () => {
    it("rejects an unbalanced entry and keeps nothing", async () => {
      const id = newId();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.journalEntry.create({
            data: {
              id,
              fiscalYearId: guardYear.id,
              no: 5_001,
              entryDate: toDbDate("2035-04-10"),
              description: "貸借不一致",
              kind: "normal",
              sourceKind: "manual",
              createdBy: "test",
              lines: {
                create: [
                  { ...line("debit", "1100", 100n), lineNo: 1 },
                  { ...line("credit", "3000", 90n), lineNo: 2 },
                ],
              },
            },
          });
          // Still inside the transaction: the deferred check has not run yet.
          expect(await tx.journalLine.count({ where: { journalEntryId: id } })).toBe(2);
        }),
      ).rejects.toThrow(/ledger guard: journal_entry .* is unbalanced \(debit 100, credit 90\)/);
      expect(await prisma.journalEntry.findUnique({ where: { id } })).toBeNull();
    });

    it("rejects an entry with one line or none", async () => {
      await expect(insertEntry([line("debit", "1100", 100n)])).rejects.toThrow(
        /has 1 line\(s\); at least 2 are required/,
      );
      await expect(insertEntry([])).rejects.toThrow(/has 0 line\(s\); at least 2 are required/);
    });

    it("accepts a balanced entry with several lines", async () => {
      const id = await insertEntry([
        line("debit", "1100", 700n),
        line("debit", "1000", 300n),
        line("credit", "3000", 1_000n),
      ]);
      expect(await prisma.journalLine.count({ where: { journalEntryId: id } })).toBe(3);
    });
  });

  describe("CHECK constraints", () => {
    it("rejects non-positive amounts and tax above the amount", async () => {
      await expect(
        insertEntry([line("debit", "1100", 0n), line("credit", "3000", 0n)]),
      ).rejects.toThrow(/journal_line_amount_positive/);
      await expect(
        insertEntry([
          { ...line("debit", "5400", 100n), taxCategoryCode: "purchase_10", taxAmount: 101n },
          line("credit", "1100", 100n),
        ]),
      ).rejects.toThrow(/journal_line_tax_amount_range/);
    });

    it("rejects a reversal without its original and a tax-exclusive exempt year", async () => {
      await expect(
        insertEntry([line("debit", "1100", 1n), line("credit", "3000", 1n)], { kind: "reversal" }),
      ).rejects.toThrow(/journal_entry_reversal_link/);
      await expect(
        prisma.fiscalYear.update({
          where: { id: guardYear.id },
          data: { accountingMethod: "tax_exclusive" },
        }),
      ).rejects.toThrow(/fiscal_year_exempt_is_tax_inclusive/);
    });
  });

  it("the repository layer still posts normally next to the guards", async () => {
    const posted = await postJournalEntry(
      prisma,
      {
        fiscalYearId: guardYear.id,
        entryDate: "2035-05-01",
        description: "普通の登録",
        kind: "normal",
        sourceKind: "manual",
        lines: [
          {
            side: "debit",
            accountId: refs.account("1100"),
            amount: 10n,
            taxCategoryCode: "na",
            taxAmount: 0n,
          },
          {
            side: "credit",
            accountId: refs.account("3000"),
            amount: 10n,
            taxCategoryCode: "na",
            taxAmount: 0n,
          },
        ],
      },
      { actor: "test" },
    );
    expect(posted.status).toBe("posted");
  });
});
