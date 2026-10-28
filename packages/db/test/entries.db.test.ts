import { assertSequence, LedgerValidationError } from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  chainedEntryIds,
  correctJournalEntry,
  createTaxRateRule,
  getJournalEntryDetail,
  listJournalEntries,
  loadEntryFormOptions,
  loadEntryHistory,
  postSimpleEntry,
  postVoucherEntry,
  voidJournalEntryWithOpenDate,
  type SimpleEntryFormInput,
  type StoredJournalEntry,
  type VoucherEntryFormInput,
  type VoucherLineFormInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function ledgerErrors(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

/**
 * 収入 / 支出 / 振替 / 伝票, 取消 and 訂正 on the seeded book (11-transactions §1, §4–§6). Every test
 * works in fiscal years of its own, far from the seeded year 1 that other files check.
 */
describe.skipIf(!hasTestDatabase)("transactions (取引)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 41 期: exempt, tax-inclusive. */
  let exemptYear: FiscalYear;
  /** 第 42 期: 本則課税, tax-exclusive. */
  let exclusiveYear: FiscalYear;
  let wallet: (name: string) => string;
  let partnerId: string;
  let tagId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    exemptYear = await createFiscalYear(prisma, {
      no: 41,
      startDate: "2041-04-01",
      endDate: "2042-03-31",
    });
    exclusiveYear = await createFiscalYear(prisma, {
      no: 42,
      startDate: "2042-04-01",
      endDate: "2043-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    const wallets = new Map(
      (await prisma.wallet.findMany()).map((row) => [row.name, row.id] as const),
    );
    wallet = (name) => {
      const id = wallets.get(name);
      if (!id) throw new Error(`not seeded: wallet ${name}`);
      return id;
    };
    partnerId = (await prisma.partner.findFirstOrThrow({ where: { name: "架空クラウド株式会社" } }))
      .id;
    tagId = (await prisma.memoTag.findFirstOrThrow({ where: { name: "設立" } })).id;
  });

  const expense = (overrides: Record<string, unknown> = {}): SimpleEntryFormInput => ({
    type: "expense",
    entryDate: "2041-05-10",
    description: "クラウド利用料",
    counterpart: `wallet:${wallet("架空カード")}`,
    accountId: refs.account("5320"),
    amount: "1,100",
    taxCategoryCode: "purchase_10",
    segmentId: refs.segment("platform"),
    partnerId,
    memoTagIds: [tagId],
    ...overrides,
  });

  const debitLine = (overrides: Partial<VoucherLineFormInput> = {}): VoucherLineFormInput => ({
    side: "debit",
    accountId: refs.account("5330"),
    subAccountId: "",
    amount: "2,000",
    taxCategoryCode: "purchase_10",
    segmentId: refs.segment("corporate"),
    partnerId: "",
    description: "",
    ...overrides,
  });

  const creditLine = (overrides: Partial<VoucherLineFormInput> = {}): VoucherLineFormInput => ({
    side: "credit",
    accountId: refs.account("2110"),
    subAccountId: "",
    amount: "2000",
    taxCategoryCode: "na",
    segmentId: "",
    partnerId: "",
    description: "",
    ...overrides,
  });

  const voucher = (overrides: Record<string, unknown> = {}): VoucherEntryFormInput => ({
    kind: "normal",
    entryDate: "2041-07-01",
    description: "消耗品の未払",
    partnerId: "",
    memoTagIds: [],
    lines: [debitLine(), creditLine()],
    ...overrides,
  });

  async function linesOf(entryId: string) {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      include: { account: { select: { code: true } }, memoTags: true },
    });
    return lines.map((line) => [
      line.side,
      line.account.code,
      line.amount,
      line.taxCategoryCode,
      line.taxAmount,
    ]);
  }

  async function auditOf(entityId: string) {
    return prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, actor: true, before: true, after: true, reason: true },
    });
  }

  async function nextNo(year: FiscalYear): Promise<number> {
    return (await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year.id } })).nextEntryNo;
  }

  it("registers 収入・支出・振替・伝票 in a tax-inclusive year without tax lines", async () => {
    const paid = await postSimpleEntry(prisma, expense(), { actor });
    expect(paid).toMatchObject({
      fiscalYearId: exemptYear.id,
      no: 1,
      kind: "normal",
      sourceKind: "manual",
      status: "posted",
      createdBy: actor,
    });
    expect(await linesOf(paid.id)).toEqual([
      ["debit", "5320", 1_100n, "purchase_10", 100n],
      ["credit", "2100", 1_100n, "na", 0n],
    ]);
    expect(paid.lines[0]).toMatchObject({
      segmentId: refs.segment("platform"),
      partnerId,
      description: "クラウド利用料",
      memoTagIds: [tagId],
    });
    expect(paid.lines[1]).toMatchObject({
      subAccountId: refs.subAccount("架空カード"),
      memoTagIds: [tagId],
    });

    const sold = await postSimpleEntry(
      prisma,
      {
        type: "income",
        entryDate: "2041-05-20",
        description: "受託開発",
        counterpart: `account:${refs.account("1200")}`,
        accountId: refs.account("4040"),
        amount: "110000",
        taxCategoryCode: "sales_10",
        segmentId: refs.segment("contract"),
        partnerId,
        memoTagIds: [],
      },
      { actor },
    );
    expect(await linesOf(sold.id)).toEqual([
      ["debit", "1200", 110_000n, "na", 0n],
      ["credit", "4040", 110_000n, "sales_10", 10_000n],
    ]);
    expect(sold.lines.map((line) => line.partnerId)).toEqual([partnerId, partnerId]);

    const moved = await postSimpleEntry(
      prisma,
      {
        type: "transfer",
        entryDate: "2041-05-31",
        description: "振替",
        fromWalletId: wallet("架空銀行 普通"),
        toWalletId: wallet("現金"),
        amount: "30,000",
        fee: "440",
      },
      { actor },
    );
    expect(moved.kind).toBe("transfer");
    expect(await linesOf(moved.id)).toEqual([
      ["debit", "1000", 30_000n, "na", 0n],
      ["debit", "5400", 440n, "purchase_10", 40n],
      ["credit", "1100", 30_440n, "na", 0n],
    ]);
    // The bank has no default segment: the fee goes to 共通.
    expect(moved.lines[1]?.segmentId).toBe(refs.segment("corporate"));

    const adjusted = await postVoucherEntry(prisma, voucher({ kind: "adjusting" }), { actor });
    expect(adjusted.kind).toBe("adjusting");
    // Tax-inclusive year: 2,000 × 10 ÷ 110 = 181.8… → 181
    expect(await linesOf(adjusted.id)).toEqual([
      ["debit", "5330", 2_000n, "purchase_10", 181n],
      ["credit", "2110", 2_000n, "na", 0n],
    ]);
    expect([paid.no, sold.no, moved.no, adjusted.no]).toEqual([1, 2, 3, 4]);
    for (const entry of [paid, sold, moved, adjusted]) {
      expect((await auditOf(entry.id)).map((row) => [row.action, row.actor])).toEqual([
        ["journal_entry.post", actor],
      ]);
    }
  });

  it("adds 仮受・仮払消費税 in a tax-exclusive year; a 伝票 only gets its tax computed", async () => {
    const sold = await postSimpleEntry(
      prisma,
      {
        type: "income",
        entryDate: "2042-05-20",
        description: "月会費",
        counterpart: `wallet:${wallet("架空銀行 普通")}`,
        accountId: refs.account("4010"),
        amount: "11,000",
        taxCategoryCode: "sales_10",
        segmentId: refs.segment("kamakura"),
        partnerId: "",
        memoTagIds: [],
      },
      { actor },
    );
    expect(sold.fiscalYearId).toBe(exclusiveYear.id);
    expect(await linesOf(sold.id)).toEqual([
      ["debit", "1100", 11_000n, "na", 0n],
      ["credit", "4010", 10_000n, "sales_10", 1_000n],
      ["credit", "2310", 1_000n, "na", 0n],
    ]);
    const paid = await postSimpleEntry(
      prisma,
      expense({ entryDate: "2042-05-21", amount: "1000" }),
      { actor },
    );
    expect(await linesOf(paid.id)).toEqual([
      ["debit", "5320", 910n, "purchase_10", 90n],
      ["debit", "1400", 90n, "na", 0n],
      ["credit", "2100", 1_000n, "na", 0n],
    ]);
    const moved = await postSimpleEntry(
      prisma,
      {
        type: "transfer",
        entryDate: "2042-05-31",
        description: "振替",
        fromWalletId: wallet("架空銀行 普通"),
        toWalletId: wallet("現金"),
        amount: "10000",
        fee: "440",
      },
      { actor },
    );
    expect(await linesOf(moved.id)).toEqual([
      ["debit", "1000", 10_000n, "na", 0n],
      ["debit", "5400", 400n, "purchase_10", 40n],
      ["debit", "1400", 40n, "na", 0n],
      ["credit", "1100", 10_440n, "na", 0n],
    ]);
    // 伝票: rows are tax-exclusive (1,000 × 10 ÷ 100 = 100) and no 仮払 row is added.
    const written = await postVoucherEntry(
      prisma,
      voucher({
        entryDate: "2042-06-30",
        lines: [
          {
            side: "debit",
            accountId: refs.account("5330"),
            amount: "1,000",
            taxCategoryCode: "purchase_10",
            segmentId: refs.segment("corporate"),
          },
          { side: "debit", accountId: refs.account("1400"), amount: "100", taxCategoryCode: "na" },
          {
            side: "credit",
            accountId: refs.account("2110"),
            amount: "1,100",
            taxCategoryCode: "na",
          },
        ],
      }),
      { actor },
    );
    expect(await linesOf(written.id)).toEqual([
      ["debit", "5330", 1_000n, "purchase_10", 100n],
      ["debit", "1400", 100n, "na", 0n],
      ["credit", "2110", 1_100n, "na", 0n],
    ]);
  });

  it("rejects with the field of each problem and keeps nothing", async () => {
    const before = await nextNo(exemptYear);
    const lines = await prisma.journalLine.count();

    const noSegment = await rejectionOf(
      postSimpleEntry(prisma, expense({ segmentId: "" }), { actor }),
    );
    expect(ledgerErrors(noSegment)).toEqual([{ code: "SEGMENT_REQUIRED", field: "segmentId" }]);
    // A form without rows: the message drops the ledger's 「1 行目（5320）の」.
    expect((noSegment as LedgerValidationError).errors[0]?.message).toBe(
      "セグメントを選んでください",
    );
    const income = await rejectionOf(
      postSimpleEntry(
        prisma,
        {
          type: "income",
          entryDate: "2041-06-02",
          description: "会費",
          counterpart: `wallet:${wallet("架空銀行 普通")}`,
          accountId: refs.account("4010"),
          amount: "1,100",
          taxCategoryCode: "sales_10",
          segmentId: "",
        },
        { actor },
      ),
    );
    expect((income as LedgerValidationError).errors).toMatchObject([
      { code: "SEGMENT_REQUIRED", field: "segmentId", message: "セグメントを選んでください" },
    ]);
    // The accounts the forms leave out are refused by the ledger too.
    expect(
      ledgerErrors(
        await rejectionOf(
          postSimpleEntry(prisma, expense({ accountId: refs.account("1400") }), { actor }),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    expect(
      ledgerErrors(
        await rejectionOf(
          postSimpleEntry(prisma, expense({ accountId: refs.account("2100") }), { actor }),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    expect(
      ledgerErrors(
        await rejectionOf(
          postSimpleEntry(
            prisma,
            {
              type: "transfer",
              entryDate: "2041-06-01",
              description: "振替",
              fromWalletId: wallet("現金"),
              toWalletId: wallet("現金"),
              amount: "100",
            },
            { actor },
          ),
        ),
      ),
    ).toEqual([{ code: "SAME_WALLET", field: "toWalletId" }]);
    const outside = await rejectionOf(
      postSimpleEntry(prisma, expense({ entryDate: "2060-01-01" }), { actor }),
    );
    expect(ledgerErrors(outside)).toEqual([{ code: "OUT_OF_FISCAL_YEAR", field: "entryDate" }]);
    expect((outside as Error).message).toContain(
      "2060/01/01 を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください",
    );

    const unbalanced = voucher({ lines: [debitLine(), creditLine({ amount: "1,900" })] });
    expect(
      ledgerErrors(await rejectionOf(postVoucherEntry(prisma, unbalanced, { actor }))),
    ).toEqual([{ code: "UNBALANCED", field: undefined }]);
    const withoutSegment = voucher({ lines: [debitLine({ segmentId: "" }), creditLine()] });
    expect(
      ledgerErrors(await rejectionOf(postVoucherEntry(prisma, withoutSegment, { actor }))),
    ).toEqual([{ code: "SEGMENT_REQUIRED", field: "lines.0.segmentId" }]);
    const typo = await rejectionOf(postSimpleEntry(prisma, expense({ amount: "千円" }), { actor }));
    expect(typo).toBeInstanceOf(ZodError);
    expect((typo as ZodError).issues[0]).toMatchObject({
      path: ["amount"],
      message: "金額は円の整数で入力してください",
    });

    expect(await nextNo(exemptYear)).toBe(before);
    expect(await prisma.journalLine.count()).toBe(lines);
  });

  it("訂正: voids the original with a reversal, posts the replacement and links them", async () => {
    const original = await postSimpleEntry(
      prisma,
      expense({ entryDate: "2041-06-10", amount: "3,300" }),
      { actor },
    );
    const result = await correctJournalEntry(
      prisma,
      original.id,
      {
        reason: "金額の誤り",
        replacement: voucher({
          entryDate: "2041-06-10",
          description: "クラウド利用料",
          lines: [
            {
              side: "debit",
              accountId: refs.account("5320"),
              amount: "3,080",
              taxCategoryCode: "purchase_10",
              segmentId: refs.segment("platform"),
              partnerId,
            },
            {
              side: "credit",
              accountId: refs.account("2100"),
              subAccountId: refs.subAccount("架空カード"),
              amount: "3,080",
              taxCategoryCode: "na",
            },
          ],
        }),
      },
      { actor },
    );
    const { voided, reversal, replacement } = result;
    expect(voided).toMatchObject({
      id: original.id,
      status: "voided",
      voidReason: "金額の誤り",
      replacedById: replacement.id,
    });
    expect(reversal).toMatchObject({
      kind: "reversal",
      reversalOfId: original.id,
      entryDate: "2041-06-10",
      no: original.no + 1,
    });
    expect(reversal.lines.map((line) => [line.side, line.amount])).toEqual([
      ["credit", 3_300n],
      ["debit", 3_300n],
    ]);
    expect(replacement).toMatchObject({
      kind: "normal",
      sourceKind: "manual",
      status: "posted",
      no: original.no + 2,
    });
    expect(await linesOf(replacement.id)).toEqual([
      ["debit", "5320", 3_080n, "purchase_10", 280n],
      ["credit", "2100", 3_080n, "na", 0n],
    ]);

    const trail = await auditOf(original.id);
    expect(trail.map((row) => row.action)).toEqual([
      "journal_entry.post",
      "journal_entry.void",
      "journal_entry.correct",
    ]);
    expect(trail[2]).toMatchObject({
      actor,
      before: { replacedById: null },
      after: { replacedById: replacement.id },
      reason: "金額の誤り",
    });
    expect(trail[1]).toMatchObject({
      before: { status: "posted", replacedById: null },
      after: { status: "voided" },
      reason: "金額の誤り",
    });
    expect((await auditOf(reversal.id)).map((row) => [row.action, row.reason])).toEqual([
      ["journal_entry.post", "金額の誤り"],
    ]);
    expect((await auditOf(replacement.id)).map((row) => row.action)).toEqual([
      "journal_entry.post",
    ]);

    // The detail shows the chain both ways, and the history covers the whole chain.
    const detail = await getJournalEntryDetail(prisma, original.id);
    expect(detail).toMatchObject({
      status: "voided",
      reversal: { id: reversal.id, no: reversal.no },
      replacedBy: { id: replacement.id, no: replacement.no },
      reversalDate: null,
      blockedReason: "取消済みのため、訂正・取消はできません",
    });
    const replacementDetail = await getJournalEntryDetail(prisma, replacement.id);
    expect(replacementDetail?.replaces.map((ref) => ref.id)).toEqual([original.id]);
    expect(replacementDetail?.blockedReason).toBeNull();
    const reversalDetail = await getJournalEntryDetail(prisma, reversal.id);
    expect(reversalDetail?.reversalOf?.id).toBe(original.id);
    expect(reversalDetail?.blockedReason).toContain("反対仕訳は訂正・取消できません");
    const history = await loadEntryHistory(prisma, chainedEntryIds(detail!));
    expect(history.map((row) => [row.action, row.entryNo])).toEqual([
      ["journal_entry.post", original.no],
      ["journal_entry.post", reversal.no],
      ["journal_entry.void", original.no],
      ["journal_entry.post", replacement.no],
      ["journal_entry.correct", original.no],
    ]);

    // Neither the voided entry nor the reversal can be corrected again; the replacement can.
    expect(
      ledgerErrors(
        await rejectionOf(
          correctJournalEntry(
            prisma,
            original.id,
            { reason: "もう一度", replacement: voucher() },
            { actor },
          ),
        ),
      ),
    ).toEqual([{ code: "ALREADY_VOIDED", field: undefined }]);
    expect(
      ledgerErrors(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, reversal.id, { reason: "誤り" }, { actor }),
        ),
      ),
    ).toEqual([{ code: "CANNOT_REVERSE_REVERSAL", field: undefined }]);
    const second = await voidJournalEntryWithOpenDate(
      prisma,
      replacement.id,
      { reason: "二重計上" },
      { actor },
    );
    expect(second.reversal.entryDate).toBe("2041-06-10");
    expect(second.voided.replacedById).toBeNull();
  });

  it("訂正 is all or nothing, and names the replacement's fields", async () => {
    const original = await postSimpleEntry(prisma, expense({ entryDate: "2041-08-01" }), { actor });
    const before = await nextNo(exemptYear);
    const replacement = voucher({ entryDate: "2041-08-01" });
    const withoutSegment = voucher({
      entryDate: "2041-08-01",
      lines: [debitLine({ segmentId: "" }), creditLine()],
    });
    expect(
      ledgerErrors(
        await rejectionOf(
          correctJournalEntry(
            prisma,
            original.id,
            { reason: "科目の誤り", replacement: withoutSegment },
            { actor },
          ),
        ),
      ),
    ).toEqual([{ code: "SEGMENT_REQUIRED", field: "replacement.lines.0.segmentId" }]);
    const missingReason = await rejectionOf(
      correctJournalEntry(prisma, original.id, { reason: " ", replacement }, { actor }),
    );
    expect((missingReason as ZodError).issues[0]).toMatchObject({
      path: ["reason"],
      message: "理由を入力してください",
    });
    // A correction is 通常・決算整理 or the original's kind: 開始 is refused for a 通常 entry.
    expect(
      ledgerErrors(
        await rejectionOf(
          correctJournalEntry(
            prisma,
            original.id,
            { reason: "種類の誤り", replacement: { ...replacement, kind: "opening" } },
            { actor },
          ),
        ),
      ),
    ).toEqual([{ code: "INVALID_KIND", field: "replacement.kind" }]);
    // Nothing of the failed corrections remains: no reversal, no number used, still posted.
    expect(await nextNo(exemptYear)).toBe(before);
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id } }),
    ).toMatchObject({ status: "posted", replacedById: null });
    expect((await auditOf(original.id)).map((row) => row.action)).toEqual(["journal_entry.post"]);
  });

  /** The 伝票 the correction page fills from an entry (its rows as they are). */
  function asVoucher(
    entry: StoredJournalEntry,
    overrides: Record<string, unknown> = {},
  ): VoucherEntryFormInput {
    return {
      kind: entry.kind,
      entryDate: entry.entryDate,
      description: entry.description,
      partnerId: "",
      memoTagIds: [],
      lines: entry.lines.map((line) => ({
        side: line.side,
        accountId: line.accountId,
        subAccountId: line.subAccountId ?? "",
        amount: String(line.amount),
        taxCategoryCode: line.taxCategoryCode,
        segmentId: line.segmentId ?? "",
        partnerId: line.partnerId ?? "",
        description: line.description ?? "",
      })),
      ...overrides,
    };
  }

  it("訂正 keeps the tax of the rows it does not change (税抜経理・経過措置)", async () => {
    // 1,000 円: 5320 910 with a tax of 90 and 仮払消費税 90. Recomputed, 910 × 10% would be 91.
    const paid = await postSimpleEntry(
      prisma,
      expense({ entryDate: "2042-07-01", amount: "1000" }),
      { actor },
    );
    const corrected = await correctJournalEntry(
      prisma,
      paid.id,
      {
        reason: "摘要の誤り",
        replacement: asVoucher(paid, { description: "クラウド利用料（7 月）" }),
      },
      { actor },
    );
    expect(await linesOf(corrected.replacement.id)).toEqual([
      ["debit", "5320", 910n, "purchase_10", 90n],
      ["debit", "1400", 90n, "na", 0n],
      ["credit", "2100", 1_000n, "na", 0n],
    ]);

    // 経過措置: only the creditable 70% of the tax goes to 仮払消費税 (this year's fixture rule).
    await createTaxRateRule(
      prisma,
      {
        taxCategoryCode: "purchase_10_ni",
        effectiveFrom: "2042-04-01",
        effectiveTo: "2043-03-31",
        ratePercent: "10",
        deductiblePercent: "70",
        note: "テスト用の経過措置",
      },
      { actor },
    );
    const noInvoice = await postSimpleEntry(
      prisma,
      expense({ entryDate: "2042-07-02", amount: "3,300", taxCategoryCode: "purchase_10_ni" }),
      { actor },
    );
    const split = [
      ["debit", "5320", 3_090n, "purchase_10_ni", 300n],
      ["debit", "1400", 210n, "na", 0n],
      ["credit", "2100", 3_300n, "na", 0n],
    ];
    expect(await linesOf(noInvoice.id)).toEqual(split);
    const kept = await correctJournalEntry(
      prisma,
      noInvoice.id,
      { reason: "摘要の誤り", replacement: asVoucher(noInvoice, { description: "海外 SaaS" }) },
      { actor },
    );
    // Recomputed it would be 309 (3,090 × 10%).
    expect(await linesOf(kept.replacement.id)).toEqual(split);

    // A changed row is computed again; each original row is matched once.
    const [main, inputTax, card] = asVoucher(noInvoice).lines;
    const changed = await correctJournalEntry(
      prisma,
      kept.replacement.id,
      {
        reason: "金額の誤り",
        replacement: asVoucher(kept.replacement, {
          lines: [{ ...main, amount: "3,100" }, inputTax, { ...card, amount: "3,310" }],
        }),
      },
      { actor },
    );
    expect(await linesOf(changed.replacement.id)).toEqual([
      ["debit", "5320", 3_100n, "purchase_10_ni", 310n],
      ["debit", "1400", 210n, "na", 0n],
      ["credit", "2100", 3_310n, "na", 0n],
    ]);
  });

  it("取消 of the same entry at the same time succeeds once, without gaps in the numbers", async () => {
    const entry = await postSimpleEntry(prisma, expense({ entryDate: "2041-09-01" }), { actor });
    const results = await Promise.allSettled([
      voidJournalEntryWithOpenDate(prisma, entry.id, { reason: "重複 A" }, { actor }),
      voidJournalEntryWithOpenDate(prisma, entry.id, { reason: "重複 B" }, { actor }),
    ]);
    const done = results.filter((result) => result.status === "fulfilled");
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    expect(done).toHaveLength(1);
    expect(refused.map(ledgerErrors)).toEqual([[{ code: "ALREADY_VOIDED", field: undefined }]]);
    expect(await prisma.journalEntry.count({ where: { reversalOfId: entry.id } })).toBe(1);
    expect(
      (await auditOf(entry.id)).filter((row) => row.action === "journal_entry.void"),
    ).toHaveLength(1);
    assertSequence(
      await prisma.journalEntry.findMany({
        where: { fiscalYearId: exemptYear.id },
        select: { no: true },
      }),
    );
  });

  it("offers the active choices, plus the inactive ones an entry being corrected uses", async () => {
    const inactive = await prisma.memoTag.create({
      data: { id: `tag_inactive_${Date.now()}`, name: `旧タグ ${Date.now()}`, isActive: false },
    });
    const options = await loadEntryFormOptions(prisma);
    expect(options.memoTags.some((tag) => tag.id === inactive.id)).toBe(false);
    expect(options.wallets.every((row) => row.isActive)).toBe(true);
    expect(options.fiscalYears.map((year) => year.no)).toContain(41);
    expect(options.taxRules.length).toBeGreaterThan(0);
    const withInactive = await loadEntryFormOptions(prisma, { includeIds: [inactive.id] });
    expect(withInactive.memoTags.find((tag) => tag.id === inactive.id)?.isActive).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase)("journal list (仕訳帳)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let cardWallet: string;
  let partnerId: string;
  let tagId: string;
  const range = { from: "2044-04-01", to: "2045-03-31" } as const;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    await createFiscalYear(prisma, { no: 44, startDate: "2044-04-01", endDate: "2045-03-31" });
    cardWallet = (await prisma.wallet.findFirstOrThrow({ where: { name: "架空カード" } })).id;
    partnerId = (await prisma.partner.findFirstOrThrow({ where: { name: "架空不動産株式会社" } }))
      .id;
    tagId = (await prisma.memoTag.findFirstOrThrow({ where: { name: "設立" } })).id;
  });

  const spend = (entryDate: string, overrides: Record<string, unknown> = {}) =>
    postSimpleEntry(
      prisma,
      {
        type: "expense",
        entryDate,
        description: "通信費",
        counterpart: `wallet:${cardWallet}`,
        accountId: refs.account("5320"),
        amount: "1,100",
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("platform"),
        partnerId: "",
        memoTagIds: [],
        ...overrides,
      },
      { actor },
    );

  it("filters by period, account, partner, segment, tag, status and text, newest first", async () => {
    const april = await spend("2044-04-10");
    const rent = await spend("2044-05-01", {
      description: "家賃",
      accountId: refs.account("5300"),
      segmentId: refs.segment("kamakura"),
      partnerId,
      amount: "110,000",
    });
    const tagged = await spend("2044-05-01", { description: "設立の残り", memoTagIds: [tagId] });
    const split = await postVoucherEntry(
      prisma,
      {
        kind: "normal",
        entryDate: "2044-06-15",
        description: "備品と送料",
        partnerId: "",
        memoTagIds: [],
        lines: [
          {
            side: "debit",
            accountId: refs.account("5330"),
            amount: "5,000",
            taxCategoryCode: "purchase_10",
            segmentId: refs.segment("kamakura"),
            description: "椅子",
          },
          {
            side: "debit",
            accountId: refs.account("5320"),
            amount: "500",
            taxCategoryCode: "purchase_10",
            segmentId: refs.segment("platform"),
            description: "送料",
          },
          {
            side: "credit",
            accountId: refs.account("2100"),
            subAccountId: refs.subAccount("架空カード"),
            amount: "5,500",
            taxCategoryCode: "na",
          },
        ],
      },
      { actor },
    );
    const { reversal } = await voidJournalEntryWithOpenDate(
      prisma,
      april.id,
      { reason: "重複" },
      { actor },
    );

    // 登録済み: the entries in force. The voided entry and its reversal are left out.
    const posted = await listJournalEntries(prisma, range);
    expect(posted.rows.map((row) => row.id)).toEqual([split.id, tagged.id, rent.id]);
    expect(posted).toMatchObject({ total: 3, page: 1, pageSize: 50, pageCount: 1 });
    const splitRow = posted.rows[0];
    expect(splitRow).toMatchObject({
      no: split.no,
      entryDate: "2044-06-15",
      debit: { accountName: "消耗品費", subAccountName: null, others: 1 },
      credit: { accountName: "未払金", subAccountName: "架空カード", others: 0 },
      amount: 5_500n,
      segment: { name: "鎌倉", others: true },
      isLocked: false,
    });

    // 取消済み: the voided entry and the reversal that cancels it, side by side.
    const voided = await listJournalEntries(prisma, { ...range, status: "voided" });
    expect(voided.rows.map((row) => [row.id, row.status, row.kind])).toEqual([
      [reversal.id, "posted", "reversal"],
      [april.id, "voided", "normal"],
    ]);
    expect(voided.rows[0]?.reversalOf).toEqual({ id: april.id, no: april.no });
    expect((await listJournalEntries(prisma, { ...range, status: "all" })).total).toBe(5);

    const ids = async (filters: Parameters<typeof listJournalEntries>[1]) =>
      (await listJournalEntries(prisma, { ...range, ...filters })).rows.map((row) => row.id);
    expect(await ids({ from: "2044-05-01", to: "2044-05-31" })).toEqual([tagged.id, rent.id]);
    expect(await ids({ account: refs.account("5300") })).toEqual([rent.id]);
    expect(await ids({ partner: partnerId })).toEqual([rent.id]);
    expect(await ids({ segment: refs.segment("kamakura") })).toEqual([split.id, rent.id]);
    expect(await ids({ tag: tagId })).toEqual([tagged.id]);
    expect(await ids({ q: "家賃" })).toEqual([rent.id]);
    // The lines' 摘要 count too.
    expect(await ids({ q: "送料" })).toEqual([split.id]);
    expect(await ids({ q: "存在しない摘要" })).toEqual([]);
  });

  it("pages the list and keeps a page past the end on the last page", async () => {
    const all = { ...range, status: "all" } as const;
    const first = await listJournalEntries(prisma, all, 1, { pageSize: 3 });
    const second = await listJournalEntries(prisma, all, 2, { pageSize: 3 });
    expect([first.rows.length, second.rows.length, first.pageCount, first.total]).toEqual([
      3, 2, 2, 5,
    ]);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(5);
    const beyond = await listJournalEntries(prisma, all, 99, { pageSize: 3 });
    expect(beyond.page).toBe(2);
    expect(beyond.rows.map((row) => row.id)).toEqual(second.rows.map((row) => row.id));
  });
});
