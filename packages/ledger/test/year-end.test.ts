/**
 * 決算整理・決算振替の仕訳 (docs/design/16-year-end.md §4.3, §5.3, §6–§10). Every entry must pass
 * `validateEntry` and balance.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  accrualReversalSourceId,
  ACCRUAL_TYPES,
  buildAccrualEntry,
  buildAccrualReversal,
  buildClosingEntry,
  buildConsumptionTaxSettlement,
  buildCorporateTaxEntry,
  buildDeferredAmortizationEntry,
  buildDepreciationEntry,
  buildDisposalEntry,
  computeBalances,
  LedgerInvariantError,
  LedgerValidationError,
  parseYearEndSourceId,
  validateEntry,
  yearEndSourceId,
  type AccountRef,
  type ClosingRow,
  type DisposalEntryInput,
  type FiscalYearContext,
  type JournalEntryInput,
  type ValidationContext,
} from "../src";
import { ACCOUNTS as BASE_ACCOUNTS, FISCAL_YEAR, validEntryArb } from "./fixtures";

const ACCOUNTS = {
  bank: { id: "acc_bank", code: "1100", kind: "asset" },
  receivable: { id: "acc_receivable", code: "1250", kind: "asset" },
  prepaid: { id: "acc_prepaid", code: "1300", kind: "asset" },
  supplies: { id: "acc_supplies", code: "1320", kind: "asset" },
  inputTax: { id: "acc_input_tax", code: "1400", kind: "asset" },
  equipment: { id: "acc_equipment", code: "1510", kind: "asset" },
  accumulated: { id: "acc_accumulated", code: "1590", kind: "asset" },
  organization: { id: "acc_organization", code: "1700", kind: "asset" },
  accrued: { id: "acc_accrued", code: "2110", kind: "liability" },
  taxPayable: { id: "acc_tax_payable", code: "2120", kind: "liability" },
  consumptionTaxPayable: { id: "acc_ct_payable", code: "2130", kind: "liability" },
  deferredRevenue: { id: "acc_deferred_revenue", code: "2200", kind: "liability" },
  outputTax: { id: "acc_output_tax", code: "2310", kind: "liability" },
  retained: { id: "acc_retained", code: "3200", kind: "equity" },
  membership: { id: "acc_membership", code: "4010", kind: "revenue" },
  miscIncome: { id: "acc_misc_income", code: "4510", kind: "revenue" },
  communication: { id: "acc_communication", code: "5320", kind: "expense" },
  supplyExpense: { id: "acc_supply_expense", code: "5330", kind: "expense" },
  taxesAndDues: { id: "acc_taxes_and_dues", code: "5440", kind: "expense" },
  depreciation: { id: "acc_depreciation", code: "5460", kind: "expense" },
  organizationAmortization: { id: "acc_org_amortization", code: "5470", kind: "expense" },
  miscLoss: { id: "acc_misc_loss", code: "5600", kind: "expense" },
  corporateTax: { id: "acc_corporate_tax", code: "8000", kind: "expense" },
  internal: { id: "acc_internal", code: "9000", kind: "internal" },
} as const satisfies Record<string, AccountRef>;

const ALL_ACCOUNTS: readonly AccountRef[] = [
  ...Object.values(ACCOUNTS),
  ...Object.values(BASE_ACCOUNTS).filter(
    (account) => !Object.values(ACCOUNTS).some((own) => own.id === account.id),
  ),
];

const CORPORATE = "seg_corporate";
const YEAR_END = FISCAL_YEAR.endDate;
const FY = "fy_1";

function context(overrides: Partial<FiscalYearContext> = {}): ValidationContext {
  return {
    fiscalYear: { ...FISCAL_YEAR, status: "closing", ...overrides },
    accounts: new Map(ALL_ACCOUNTS.map((account) => [account.id, account])),
  };
}

const NEXT_YEAR: Partial<FiscalYearContext> = {
  startDate: "2027-04-01",
  endDate: "2028-03-31",
  status: "open",
};

function expectValid(entry: JournalEntryInput | null, ctx: ValidationContext = context()) {
  expect(entry).not.toBeNull();
  if (!entry) return;
  expect(validateEntry(entry, ctx)).toEqual({ ok: true });
}

/** `[side, accountId, amount]` of every line, for compact assertions. */
function linesOf(entry: JournalEntryInput | null): [string, string, bigint][] {
  return (entry?.lines ?? []).map((line) => [line.side, line.accountId, line.amount]);
}

describe("sourceId of generated entries", () => {
  it("builds and reads year_end:<purpose>:<fiscalYearId>[:<detail>]", () => {
    expect(yearEndSourceId("closing", FY)).toBe("year_end:closing:fy_1");
    expect(yearEndSourceId("deferred", FY, "acc_organization")).toBe(
      "year_end:deferred:fy_1:acc_organization",
    );
    expect(accrualReversalSourceId("je_1")).toBe("year_end:accrual_reversal:je_1");
    expect(parseYearEndSourceId("year_end:deferred:fy_1:acc_organization")).toEqual({
      purpose: "deferred",
      fiscalYearId: FY,
      detail: "acc_organization",
    });
    expect(parseYearEndSourceId("year_end:corporate_tax:fy_1")).toEqual({
      purpose: "corporate_tax",
      fiscalYearId: FY,
      detail: null,
    });
    expect(parseYearEndSourceId("year_end:accrual_reversal:je_1")).toEqual({
      purpose: "accrual_reversal",
      originalEntryId: "je_1",
    });
  });

  it("returns null for other sourceIds", () => {
    expect(parseYearEndSourceId(null)).toBeNull();
    expect(parseYearEndSourceId("fa_1")).toBeNull();
    expect(parseYearEndSourceId("year_end:unknown:fy_1")).toBeNull();
    expect(parseYearEndSourceId("year_end:closing")).toBeNull();
    expect(parseYearEndSourceId("year_end:accrual_reversal:je_1:x")).toBeNull();
  });
});

describe("減価償却・繰延資産の仕訳 (§4.3, §6)", () => {
  it("借方 減価償却費 (資産のセグメント) / 貸方 減価償却累計額", () => {
    const entry = buildDepreciationEntry({
      date: YEAR_END,
      assetId: "fa_1",
      assetName: "ノート PC",
      amount: 75_000n,
      expenseAccountId: ACCOUNTS.depreciation.id,
      creditAccountId: ACCOUNTS.accumulated.id,
      segmentId: "seg_kamakura",
    });
    expectValid(entry);
    expect(entry).toMatchObject({
      kind: "adjusting",
      sourceKind: "fixed_asset",
      sourceId: "fa_1",
      description: "減価償却費 ノート PC",
    });
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.depreciation.id, 75_000n],
      ["credit", ACCOUNTS.accumulated.id, 75_000n],
    ]);
    expect(entry.lines[0]?.segmentId).toBe("seg_kamakura");
    expect(entry.lines.every((line) => line.taxCategoryCode === "na")).toBe(true);
  });

  it("rejects an amount of 0", () => {
    expect(() =>
      buildDepreciationEntry({
        date: YEAR_END,
        assetId: "fa_1",
        assetName: "ノート PC",
        amount: 0n,
        expenseAccountId: ACCOUNTS.depreciation.id,
        creditAccountId: ACCOUNTS.equipment.id,
        segmentId: CORPORATE,
      }),
    ).toThrow(LedgerValidationError);
  });

  it("借方 創立費償却 / 貸方 創立費", () => {
    const entry = buildDeferredAmortizationEntry({
      date: YEAR_END,
      fiscalYearId: FY,
      deferredAccountId: ACCOUNTS.organization.id,
      deferredAccountName: "創立費",
      expenseAccountId: ACCOUNTS.organizationAmortization.id,
      amount: 13_750n,
      segmentId: CORPORATE,
    });
    expectValid(entry);
    expect(entry).toMatchObject({
      description: "創立費の償却",
      sourceKind: "year_end",
      sourceId: `year_end:deferred:${FY}:${ACCOUNTS.organization.id}`,
    });
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.organizationAmortization.id, 13_750n],
      ["credit", ACCOUNTS.organization.id, 13_750n],
    ]);
  });
});

describe("前払・未払・前受・貯蔵品 (§7)", () => {
  const cases = {
    prepaid_expense: [ACCOUNTS.prepaid, ACCOUNTS.communication, "debit"],
    accrued_expense: [ACCOUNTS.accrued, ACCOUNTS.communication, "credit"],
    deferred_revenue: [ACCOUNTS.deferredRevenue, ACCOUNTS.membership, "credit"],
    supplies: [ACCOUNTS.supplies, ACCOUNTS.supplyExpense, "debit"],
  } as const;

  it.each(ACCRUAL_TYPES)("%s: the table's sides, and a reversal that swaps them", (type) => {
    const [balanceAccount, plAccount, balanceSide] = cases[type];
    const entry = buildAccrualEntry({
      date: YEAR_END,
      fiscalYearId: FY,
      type,
      balanceAccountId: balanceAccount.id,
      plAccountId: plAccount.id,
      amount: 12_000n,
      segmentId: "seg_platform",
      description: "  ",
    });
    expectValid(entry);
    expect(entry.sourceId).toBe(`year_end:accrual:${FY}`);
    expect(entry.lines.find((line) => line.accountId === balanceAccount.id)?.side).toBe(
      balanceSide,
    );
    expect(entry.lines.find((line) => line.accountId === plAccount.id)?.segmentId).toBe(
      "seg_platform",
    );

    const reversal = buildAccrualReversal(entry, { date: "2027-04-01", originalEntryId: "je_9" });
    expectValid(reversal, context(NEXT_YEAR));
    expect(reversal).toMatchObject({
      kind: "adjusting",
      sourceKind: "year_end",
      sourceId: "year_end:accrual_reversal:je_9",
      entryDate: "2027-04-01",
    });
    expect(reversal.description).toBe(`振り戻し: ${entry.description}`);
    expect(reversal.lines.map((line) => line.side)).toEqual(
      entry.lines.map((line) => (line.side === "debit" ? "credit" : "debit")),
    );
  });

  it("keeps the description given on the sheet", () => {
    const entry = buildAccrualEntry({
      date: YEAR_END,
      fiscalYearId: FY,
      type: "prepaid_expense",
      balanceAccountId: ACCOUNTS.prepaid.id,
      plAccountId: ACCOUNTS.communication.id,
      amount: 30_000n,
      segmentId: CORPORATE,
      description: "年払いのクラウド 翌期分",
    });
    expect(entry.description).toBe("年払いのクラウド 翌期分");
  });
});

describe("消費税の精算 (§8)", () => {
  const accounts = {
    outputTax: ACCOUNTS.outputTax.id,
    inputTax: ACCOUNTS.inputTax.id,
    payable: ACCOUNTS.consumptionTaxPayable.id,
    receivable: ACCOUNTS.receivable.id,
    miscIncome: ACCOUNTS.miscIncome.id,
    miscLoss: ACCOUNTS.miscLoss.id,
    taxesAndDues: ACCOUNTS.taxesAndDues.id,
  };
  const base = {
    date: YEAR_END,
    fiscalYearId: FY,
    accounts,
    segmentId: CORPORATE,
  } as const;

  it("税抜経理: 仮受・仮払を消し、納付税額を未払消費税等、端数を雑収入へ", () => {
    const entry = buildConsumptionTaxSettlement({
      ...base,
      accountingMethod: "tax_exclusive",
      outputTaxBalance: 500_000n,
      inputTaxBalance: 200_050n,
      payable: 299_900n,
    });
    expectValid(entry);
    expect(entry?.sourceId).toBe(`year_end:consumption_tax:${FY}`);
    expect(linesOf(entry)).toEqual([
      ["debit", accounts.outputTax, 500_000n],
      ["credit", accounts.inputTax, 200_050n],
      ["credit", accounts.payable, 299_900n],
      ["credit", accounts.miscIncome, 50n],
    ]);
  });

  it("税抜経理: 申告書の額が多ければ差額は雑損失", () => {
    const entry = buildConsumptionTaxSettlement({
      ...base,
      accountingMethod: "tax_exclusive",
      outputTaxBalance: 500_000n,
      inputTaxBalance: 200_000n,
      payable: 300_100n,
    });
    expectValid(entry);
    expect(linesOf(entry)).toContainEqual(["debit", accounts.miscLoss, 100n]);
  });

  it("税抜経理: 還付は未収入金", () => {
    const entry = buildConsumptionTaxSettlement({
      ...base,
      accountingMethod: "tax_exclusive",
      outputTaxBalance: 100_000n,
      inputTaxBalance: 300_000n,
      payable: -200_000n,
    });
    expectValid(entry);
    expect(linesOf(entry)).toEqual([
      ["debit", accounts.outputTax, 100_000n],
      ["credit", accounts.inputTax, 300_000n],
      ["debit", accounts.receivable, 200_000n],
    ]);
  });

  it("税込経理: 借方 租税公課 / 貸方 未払消費税等 (還付は 未収入金 / 雑収入)", () => {
    const entry = buildConsumptionTaxSettlement({
      ...base,
      accountingMethod: "tax_inclusive",
      outputTaxBalance: 0n,
      inputTaxBalance: 0n,
      payable: 120_000n,
    });
    expectValid(entry);
    expect(linesOf(entry)).toEqual([
      ["debit", accounts.taxesAndDues, 120_000n],
      ["credit", accounts.payable, 120_000n],
    ]);
    const refund = buildConsumptionTaxSettlement({
      ...base,
      accountingMethod: "tax_inclusive",
      outputTaxBalance: 0n,
      inputTaxBalance: 0n,
      payable: -30_000n,
    });
    expectValid(refund);
    expect(linesOf(refund)).toEqual([
      ["debit", accounts.receivable, 30_000n],
      ["credit", accounts.miscIncome, 30_000n],
    ]);
  });

  it("returns null when there is nothing to post", () => {
    for (const accountingMethod of ["tax_exclusive", "tax_inclusive"] as const) {
      expect(
        buildConsumptionTaxSettlement({
          ...base,
          accountingMethod,
          outputTaxBalance: 0n,
          inputTaxBalance: 0n,
          payable: 0n,
        }),
      ).toBeNull();
    }
  });
});

describe("法人税等 (§9)", () => {
  it("借方 法人税、住民税及び事業税 / 貸方 未払法人税等", () => {
    const entry = buildCorporateTaxEntry({
      date: YEAR_END,
      fiscalYearId: FY,
      amount: 23_200n,
      expenseAccountId: ACCOUNTS.corporateTax.id,
      payableAccountId: ACCOUNTS.taxPayable.id,
      segmentId: CORPORATE,
    });
    expectValid(entry);
    expect(entry.sourceId).toBe(`year_end:corporate_tax:${FY}`);
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.corporateTax.id, 23_200n],
      ["credit", ACCOUNTS.taxPayable.id, 23_200n],
    ]);
  });
});

describe("除却・売却 (§5.3)", () => {
  const base: DisposalEntryInput = {
    date: "2027-03-10",
    assetId: "fa_1",
    assetName: "複合機",
    method: "straight_line",
    cost: 1_000_000n,
    accumulated: 375_000n,
    assetAccountBalance: 1_000_000n,
    assetAccountId: ACCOUNTS.equipment.id,
    accumulatedAccountId: ACCOUNTS.accumulated.id,
    proceeds: 0n,
    proceedsCounterpart: null,
    proceedsSplit: null,
    outputTaxAccountId: ACCOUNTS.outputTax.id,
    miscIncomeAccountId: ACCOUNTS.miscIncome.id,
    miscLossAccountId: ACCOUNTS.miscLoss.id,
    segmentId: CORPORATE,
    description: "",
  };
  const open = context({ status: "open" });
  const bank = { accountId: ACCOUNTS.bank.id, subAccountId: null };

  it("除却 (定額): 累計額と取得価額を外し、帳簿価額は雑損失", () => {
    const { entry, bookValue } = buildDisposalEntry(base);
    expect(bookValue).toBe(625_000n);
    expectValid(entry, open);
    expect(entry).toMatchObject({
      kind: "normal",
      sourceKind: "fixed_asset",
      sourceId: "fa_1",
      description: "除却 複合機",
    });
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.accumulated.id, 375_000n],
      ["debit", ACCOUNTS.miscLoss.id, 625_000n],
      ["credit", ACCOUNTS.equipment.id, 1_000_000n],
    ]);
  });

  it("売却益 (税込経理): 雑収入に 売却額 (sales_10) と 帳簿価額 (na)", () => {
    const { entry } = buildDisposalEntry({
      ...base,
      proceeds: 700_000n,
      proceedsCounterpart: bank,
      proceedsSplit: { amount: 700_000n, taxAmount: 63_636n, taxLineAmount: 0n },
      description: "複合機の売却",
    });
    expectValid(entry, open);
    expect(entry?.description).toBe("複合機の売却");
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.accumulated.id, 375_000n],
      ["debit", ACCOUNTS.bank.id, 700_000n],
      ["debit", ACCOUNTS.miscIncome.id, 625_000n],
      ["credit", ACCOUNTS.equipment.id, 1_000_000n],
      ["credit", ACCOUNTS.miscIncome.id, 700_000n],
    ]);
    const proceedsLine = entry?.lines.at(-1);
    expect(proceedsLine).toMatchObject({ taxCategoryCode: "sales_10", taxAmount: 63_636n });
    expect(entry?.lines[2]).toMatchObject({ taxCategoryCode: "na", taxAmount: 0n });
  });

  it("売却損 (定率・税抜経理): 雑損失に 帳簿価額 (na) と 税抜の売却額 (sales_10)、仮受消費税", () => {
    const { entry, bookValue } = buildDisposalEntry({
      ...base,
      method: "declining_balance",
      accumulated: 437_500n,
      proceeds: 550_000n,
      proceedsCounterpart: bank,
      proceedsSplit: { amount: 500_000n, taxAmount: 50_000n, taxLineAmount: 50_000n },
    });
    expect(bookValue).toBe(562_500n);
    expectValid(entry, context({ status: "open", accountingMethod: "tax_exclusive" }));
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.accumulated.id, 437_500n],
      ["debit", ACCOUNTS.bank.id, 550_000n],
      ["debit", ACCOUNTS.miscLoss.id, 562_500n],
      ["credit", ACCOUNTS.equipment.id, 1_000_000n],
      ["credit", ACCOUNTS.miscLoss.id, 500_000n],
      ["credit", ACCOUNTS.outputTax.id, 50_000n],
    ]);
    expect(entry?.lines[4]).toMatchObject({ taxCategoryCode: "sales_10", taxAmount: 50_000n });
  });

  it("即時: 償却済みなら資産の行はなく、売却額 0 なら仕訳を作らない", () => {
    const immediate = {
      ...base,
      method: "immediate",
      cost: 98_000n,
      accumulated: 98_000n,
      assetAccountBalance: 0n,
    } as const;
    expect(buildDisposalEntry(immediate)).toEqual({ entry: null, bookValue: 0n });

    const { entry } = buildDisposalEntry({
      ...immediate,
      proceeds: 11_000n,
      proceedsCounterpart: bank,
      proceedsSplit: { amount: 11_000n, taxAmount: 1_000n, taxLineAmount: 0n },
    });
    expectValid(entry, open);
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.bank.id, 11_000n],
      ["credit", ACCOUNTS.miscIncome.id, 11_000n],
    ]);
  });

  it("即時: 取得した期に償却前に除却すれば、資産の科目から外して雑損失", () => {
    const { entry, bookValue } = buildDisposalEntry({
      ...base,
      method: "immediate",
      cost: 98_000n,
      accumulated: 0n,
      assetAccountBalance: 98_000n,
    });
    expect(bookValue).toBe(98_000n);
    expectValid(entry, open);
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.miscLoss.id, 98_000n],
      ["credit", ACCOUNTS.equipment.id, 98_000n],
    ]);
  });

  it("一括: 資産の科目は外さず、売却額だけを雑収入にする", () => {
    const lumpSum = {
      ...base,
      method: "lump_sum_3y",
      cost: 180_000n,
      accumulated: 25_000n,
      assetAccountBalance: 155_000n,
    } as const;
    expect(buildDisposalEntry(lumpSum)).toEqual({ entry: null, bookValue: 0n });
    const { entry } = buildDisposalEntry({
      ...lumpSum,
      proceeds: 33_000n,
      proceedsCounterpart: bank,
      proceedsSplit: null,
    });
    expectValid(entry, open);
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.bank.id, 33_000n],
      ["credit", ACCOUNTS.miscIncome.id, 33_000n],
    ]);
    expect(entry?.description).toBe("売却 複合機");
  });

  it("rejects inconsistent amounts", () => {
    expect(() => buildDisposalEntry({ ...base, assetAccountBalance: 0n })).toThrow(RangeError);
    expect(() => buildDisposalEntry({ ...base, accumulated: 1_000_001n })).toThrow(RangeError);
    expect(() => buildDisposalEntry({ ...base, proceeds: 1_000n })).toThrow(RangeError);
    expect(() =>
      buildDisposalEntry({
        ...base,
        proceeds: 1_100n,
        proceedsCounterpart: bank,
        proceedsSplit: { amount: 1_000n, taxAmount: 100n, taxLineAmount: 0n },
      }),
    ).toThrow(RangeError);
  });
});

describe("決算振替 (§10)", () => {
  const rows: ClosingRow[] = [
    {
      accountId: ACCOUNTS.membership.id,
      kind: "revenue",
      segmentId: "seg_kamakura",
      net: -1_000_000n,
    },
    {
      accountId: ACCOUNTS.membership.id,
      kind: "revenue",
      segmentId: "seg_platform",
      net: -200_000n,
    },
    {
      accountId: ACCOUNTS.communication.id,
      kind: "expense",
      segmentId: "seg_kamakura",
      net: 300_000n,
    },
    { accountId: ACCOUNTS.communication.id, kind: "expense", segmentId: CORPORATE, net: 100_000n },
    { accountId: ACCOUNTS.internal.id, kind: "internal", segmentId: "seg_platform", net: -50_000n },
    { accountId: ACCOUNTS.internal.id, kind: "internal", segmentId: "seg_kamakura", net: 50_000n },
    { accountId: ACCOUNTS.corporateTax.id, kind: "expense", segmentId: CORPORATE, net: 23_200n },
    { accountId: ACCOUNTS.miscIncome.id, kind: "revenue", segmentId: CORPORATE, net: 0n },
  ];
  const base = {
    date: YEAR_END,
    fiscalYearId: FY,
    fiscalYearNo: 1,
    retainedEarningsAccountId: ACCOUNTS.retained.id,
  };

  it("brings each account × segment to 0 and carries the net income to 繰越利益剰余金", () => {
    const { entry, netIncome } = buildClosingEntry({ ...base, rows });
    // 1,200,000 − 300,000 − 100,000 − 23,200 = 776,800。
    expect(netIncome).toBe(776_800n);
    expectValid(entry);
    expect(entry).toMatchObject({
      kind: "closing",
      sourceKind: "year_end",
      sourceId: `year_end:closing:${FY}`,
      description: "決算振替 第 1 期",
      entryDate: YEAR_END,
    });
    expect(
      entry?.lines.map((line) => [line.side, line.accountId, line.segmentId, line.amount]),
    ).toEqual([
      ["debit", ACCOUNTS.membership.id, "seg_kamakura", 1_000_000n],
      ["debit", ACCOUNTS.membership.id, "seg_platform", 200_000n],
      ["credit", ACCOUNTS.communication.id, "seg_kamakura", 300_000n],
      ["credit", ACCOUNTS.communication.id, CORPORATE, 100_000n],
      ["debit", ACCOUNTS.internal.id, "seg_platform", 50_000n],
      ["credit", ACCOUNTS.internal.id, "seg_kamakura", 50_000n],
      ["credit", ACCOUNTS.corporateTax.id, CORPORATE, 23_200n],
      ["credit", ACCOUNTS.retained.id, null, 776_800n],
    ]);
  });

  it("a net loss is debited to 繰越利益剰余金", () => {
    const { entry, netIncome } = buildClosingEntry({
      ...base,
      rows: [
        {
          accountId: ACCOUNTS.communication.id,
          kind: "expense",
          segmentId: CORPORATE,
          net: 60_000n,
        },
        { accountId: ACCOUNTS.membership.id, kind: "revenue", segmentId: CORPORATE, net: -10_000n },
      ],
    });
    expect(netIncome).toBe(-50_000n);
    expectValid(entry);
    expect(linesOf(entry).at(-1)).toEqual(["debit", ACCOUNTS.retained.id, 50_000n]);
  });

  it("has no 繰越利益剰余金 line when only internal rows are left, and no entry when all are 0", () => {
    const internalOnly = buildClosingEntry({ ...base, rows: rows.slice(4, 6) });
    expect(internalOnly.netIncome).toBe(0n);
    expectValid(internalOnly.entry);
    expect(internalOnly.entry?.lines).toHaveLength(2);
    expect(buildClosingEntry({ ...base, rows: [rows[7]!] })).toEqual({
      entry: null,
      netIncome: 0n,
    });
    expect(buildClosingEntry({ ...base, rows: [] })).toEqual({ entry: null, netIncome: 0n });
  });

  it("merges rows of the same account and segment", () => {
    const { entry, netIncome } = buildClosingEntry({
      ...base,
      rows: [rows[0]!, { ...rows[0]!, net: 400_000n }],
    });
    expect(netIncome).toBe(600_000n);
    expect(linesOf(entry)).toEqual([
      ["debit", ACCOUNTS.membership.id, 600_000n],
      ["credit", ACCOUNTS.retained.id, 600_000n],
    ]);
  });

  it("rejects balance-sheet rows and internal rows that do not net to 0", () => {
    expect(() =>
      buildClosingEntry({
        ...base,
        rows: [{ accountId: ACCOUNTS.bank.id, kind: "asset", segmentId: null, net: 1n }],
      }),
    ).toThrow(RangeError);
    expect(() => buildClosingEntry({ ...base, rows: rows.slice(4, 5) })).toThrow(
      LedgerInvariantError,
    );
  });

  it("closes any valid year: P/L balances become 0 and 繰越利益剰余金 takes the net income", () => {
    const accountMap = new Map(ALL_ACCOUNTS.map((account) => [account.id, account]));
    fc.assert(
      fc.property(fc.array(validEntryArb(), { minLength: 1, maxLength: 8 }), (entries) => {
        const closingRows: ClosingRow[] = computeBalances(entries, { groupBy: "segment" }).flatMap(
          (row) => {
            const account = accountMap.get(row.accountId);
            if (!account || !["revenue", "expense", "internal"].includes(account.kind)) return [];
            return [
              {
                accountId: row.accountId,
                kind: account.kind,
                segmentId: row.segmentId,
                net: row.net,
              },
            ];
          },
        );
        const { entry, netIncome } = buildClosingEntry({ ...base, rows: closingRows });
        if (entry) expectValid(entry);
        const after = computeBalances(entry ? [...entries, entry] : entries, {
          groupBy: "account",
        });
        for (const row of after) {
          const kind = accountMap.get(row.accountId)?.kind;
          if (kind === "revenue" || kind === "expense" || kind === "internal") {
            expect(row.net).toBe(0n);
          }
        }
        const retained = after.find((row) => row.accountId === ACCOUNTS.retained.id);
        expect(retained?.net ?? 0n).toBe(-netIncome);
      }),
      { numRuns: 100 },
    );
  });
});
