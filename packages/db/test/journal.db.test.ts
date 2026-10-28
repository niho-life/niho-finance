import {
  assertSequence,
  computeBalances,
  inclusiveTaxAmount,
  LedgerValidationError,
  type CalendarDate,
} from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  JournalEntryNotFoundError,
  loadStoredEntry,
  postJournalEntry,
  voidJournalEntry,
  type PostJournalEntryInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

describe.skipIf(!hasTestDatabase)("postJournalEntry / voidJournalEntry", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let year2: FiscalYear;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year2 = await createFiscalYear(prisma, {
      no: 2,
      startDate: "2027-04-01",
      endDate: "2028-03-31",
    });
  });

  function sale(
    amount: bigint,
    entryDate: CalendarDate,
    overrides: Partial<PostJournalEntryInput> = {},
  ): PostJournalEntryInput {
    return {
      entryDate,
      description: "月会費",
      kind: "normal",
      sourceKind: "manual",
      lines: [
        {
          side: "debit",
          accountId: refs.account("1100"),
          subAccountId: refs.subAccount("架空銀行 普通"),
          amount,
          taxCategoryCode: "na",
          taxAmount: 0n,
        },
        {
          side: "credit",
          accountId: refs.account("4010"),
          amount,
          taxCategoryCode: "sales_10",
          taxAmount: inclusiveTaxAmount(amount, 10),
          segmentId: refs.segment("kamakura"),
        },
      ],
      ...overrides,
    };
  }

  async function entryNumbers(fiscalYearId: string) {
    return prisma.journalEntry.findMany({ where: { fiscalYearId }, select: { no: true } });
  }

  it("posts an entry with the next number, its lines and an audit row", async () => {
    const posted = await postJournalEntry(prisma, sale(5_500n, "2027-04-01"), { actor });
    expect(posted).toMatchObject({
      fiscalYearId: year2.id,
      no: 1,
      status: "posted",
      kind: "normal",
      createdBy: actor,
    });
    expect(
      posted.lines.map((line) => [line.lineNo, line.side, line.amount, line.taxAmount]),
    ).toEqual([
      [1, "debit", 5_500n, 0n],
      [2, "credit", 5_500n, 500n],
    ]);
    const audit = await prisma.auditLog.findMany({ where: { entityId: posted.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor,
      action: "journal_entry.post",
      entity: "journal_entry",
    });
    expect(audit[0]?.after).toMatchObject({
      no: 1,
      lines: [{ amount: "5500" }, { amount: "5500", taxAmount: "500" }],
    });
  });

  it("rejects an invalid entry, keeps nothing and does not consume a number", async () => {
    const unbalanced = sale(1_000n, "2027-04-02");
    const broken = {
      ...unbalanced,
      lines: [unbalanced.lines[0]!, { ...unbalanced.lines[1]!, amount: 900n, taxAmount: 81n }],
    };
    const error = await postJournalEntry(prisma, broken, { actor }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).codes).toEqual(["UNBALANCED"]);

    const wrongSub = sale(1_000n, "2027-04-02");
    wrongSub.lines = [
      { ...wrongSub.lines[0]!, subAccountId: refs.subAccount("架空カード") },
      wrongSub.lines[1]!,
    ];
    await expect(postJournalEntry(prisma, wrongSub, { actor })).rejects.toThrow(
      /SUB_ACCOUNT_MISMATCH/,
    );

    const next = await postJournalEntry(prisma, sale(1_000n, "2027-04-02"), { actor });
    expect(next.no).toBe(2);
    const numbers = await entryNumbers(year2.id);
    expect(numbers).toHaveLength(2);
    expect(() => assertSequence(numbers)).not.toThrow();
  });

  it("voids with a reversal that takes the next number and cancels every amount", async () => {
    const original = await postJournalEntry(prisma, sale(3_300n, "2027-04-03"), { actor });
    const { voided, reversal } = await voidJournalEntry(prisma, original.id, {
      reason: "二重登録",
      actor,
    });

    expect(voided).toMatchObject({ id: original.id, status: "voided", voidReason: "二重登録" });
    expect(voided.voidedAt).toBeInstanceOf(Date);
    expect(reversal).toMatchObject({
      no: original.no + 1,
      kind: "reversal",
      reversalOfId: original.id,
      entryDate: "2027-04-03",
      status: "posted",
    });
    expect(reversal.lines.map((line) => line.side)).toEqual(["credit", "debit"]);

    const entries = [
      await loadStoredEntry(prisma, original.id),
      await loadStoredEntry(prisma, reversal.id),
    ];
    for (const groupBy of ["account", "subAccount", "segment"] as const) {
      for (const row of computeBalances(entries, { groupBy })) expect(row.net).toBe(0n);
    }

    const audit = await prisma.auditLog.findMany({
      where: { entityId: original.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual(["journal_entry.post", "journal_entry.void"]);
    expect(audit[1]).toMatchObject({
      reason: "二重登録",
      before: { status: "posted" },
      after: { status: "voided" },
    });
  });

  it("stores memo tags per line and carries them to the reversal", async () => {
    const tag = await prisma.memoTag.findFirstOrThrow({ where: { name: "設立" } });
    const input = sale(2_200n, "2027-04-05");
    const tagged = {
      ...input,
      lines: [{ ...input.lines[0]!, memoTagIds: [tag.id, tag.id] }, input.lines[1]!],
    };
    const posted = await postJournalEntry(prisma, tagged, { actor });
    expect(posted.lines.map((line) => line.memoTagIds)).toEqual([[tag.id], []]);
    const { reversal } = await voidJournalEntry(prisma, posted.id, { reason: "誤り", actor });
    expect(reversal.lines.map((line) => line.memoTagIds)).toEqual([[tag.id], []]);
  });

  it("refuses to void twice, to void a reversal and to void an unknown entry", async () => {
    const original = await postJournalEntry(prisma, sale(1_100n, "2027-04-04"), { actor });
    const { reversal } = await voidJournalEntry(prisma, original.id, { reason: "誤り", actor });
    await expect(voidJournalEntry(prisma, original.id, { reason: "誤り", actor })).rejects.toThrow(
      /ALREADY_VOIDED/,
    );
    await expect(voidJournalEntry(prisma, reversal.id, { reason: "誤り", actor })).rejects.toThrow(
      /CANNOT_REVERSE_REVERSAL/,
    );
    await expect(
      voidJournalEntry(prisma, "01UNKNOWNUNKNOWNUNKNOWN000", { reason: "誤り", actor }),
    ).rejects.toBeInstanceOf(JournalEntryNotFoundError);
    assertSequence(await entryNumbers(year2.id));
  });

  it("numbers concurrent postings without gaps or duplicates, even when some fail", async () => {
    const year3 = await createFiscalYear(prisma, {
      no: 3,
      startDate: "2028-04-01",
      endDate: "2029-03-31",
    });
    const batch = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postJournalEntry(prisma, sale(BigInt(1_000 + i), "2028-04-10"), { actor }),
      ),
    );
    expect(batch.map((entry) => entry.no).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    const mixed = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => {
        const input = sale(2_000n, "2028-04-11");
        // every third posting is unbalanced and must roll back its number
        return postJournalEntry(
          prisma,
          i % 3 === 0
            ? {
                ...input,
                lines: [input.lines[0]!, { ...input.lines[1]!, amount: 1_999n, taxAmount: 181n }],
              }
            : input,
          { actor },
        );
      }),
    );
    expect(mixed.filter((result) => result.status === "rejected")).toHaveLength(4);
    const numbers = await entryNumbers(year3.id);
    expect(numbers).toHaveLength(26);
    expect(() => assertSequence(numbers)).not.toThrow();
    expect(
      (await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year3.id } })).nextEntryNo,
    ).toBe(27);
  });

  it("rejects posting and voiding on or before the close, and in a closed year", async () => {
    const year4 = await createFiscalYear(prisma, {
      no: 4,
      startDate: "2029-04-01",
      endDate: "2030-03-31",
    });
    const april = await postJournalEntry(prisma, sale(4_400n, "2029-04-15"), { actor });
    await prisma.fiscalYear.update({
      where: { id: year4.id },
      data: { lockedThrough: new Date("2029-04-30T00:00:00Z") },
    });

    await expect(postJournalEntry(prisma, sale(1_000n, "2029-04-30"), { actor })).rejects.toThrow(
      /PERIOD_LOCKED/,
    );
    await expect(voidJournalEntry(prisma, april.id, { reason: "誤り", actor })).rejects.toThrow(
      /PERIOD_LOCKED/,
    );
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: april.id } })).status).toBe(
      "posted",
    );

    // A closed month is corrected on the first open date.
    const { voided, reversal } = await voidJournalEntry(prisma, april.id, {
      reason: "誤り",
      date: "2029-05-01",
      actor,
    });
    expect(voided.status).toBe("voided");
    expect(reversal.entryDate).toBe("2029-05-01");

    const year5 = await createFiscalYear(prisma, {
      no: 5,
      startDate: "2030-04-01",
      endDate: "2031-03-31",
      status: "closed",
    });
    await expect(postJournalEntry(prisma, sale(1_000n, "2030-04-01"), { actor })).rejects.toThrow(
      /FISCAL_YEAR_CLOSED/,
    );
    expect(await entryNumbers(year5.id)).toHaveLength(0);
    await expect(postJournalEntry(prisma, sale(1_000n, "2040-01-01"), { actor })).rejects.toThrow(
      /OUT_OF_FISCAL_YEAR/,
    );
  });
});
