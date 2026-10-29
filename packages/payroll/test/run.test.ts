/**
 * The pure part of a confirmed pay run (22-payroll §5.3–§5.5, §7): premium months, payment
 * deadlines and their rule keys, the journal lines, the derived scheduled amounts and the snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  buildPaymentEntry,
  buildPayrollEntries,
  calculatePayroll,
  findTableById,
  parsePayrollRunItems,
  parsePayrollTableIds,
  paymentCategoryOfRuleKey,
  PayrollSnapshotError,
  payrollInputOf,
  payrollSchedule,
  pinnedTables,
  premiumMonthFor,
  residentTaxSlot,
  runPaymentSlots,
  scheduleAmount,
  serializePayrollRunItems,
  serializePayrollTableIds,
  shiftYearMonth,
  socialInsuranceSlot,
  summarizePayrollRun,
  tableIdsOf,
  withholdingSlot,
  type PayrollEntryLine,
  type PayrollRunItem,
  type PayrollRunItemInput,
  type PayrollRunSummary,
  type WorkerKind,
} from "../src";

// ---------------------------------------------------------------------------------------------
// Fixtures: the two people of §8.4 (fictional)
// ---------------------------------------------------------------------------------------------

const RUN = { paymentDate: "2026-12-25", premiumMonth: "2026-11" } as const;

const OFFICER_INPUT: PayrollRunItemInput = {
  taxablePay: 300_000n,
  nonTaxablePay: 0n,
  residentTax: 0n,
  standardRemuneration: { health: 300_000n, pension: 300_000n },
  coverage: { health: true, care: false, pension: true, employment: false },
  taxColumn: { column: "kou", dependents: 0 },
  adjustments: { incomeTax: 0n, socialInsurance: 0n },
};

const EMPLOYEE_INPUT: PayrollRunItemInput = {
  taxablePay: 250_000n,
  nonTaxablePay: 10_000n,
  residentTax: 10_000n,
  standardRemuneration: { health: 260_000n, pension: 260_000n },
  coverage: { health: true, care: false, pension: true, employment: true },
  taxColumn: { column: "kou", dependents: 0 },
  adjustments: { incomeTax: 0n, socialInsurance: 0n },
};

function item(
  kind: WorkerKind,
  input: PayrollRunItemInput,
  overrides: Partial<PayrollRunItemInput> = {},
  run: { paymentDate: "2026-12-25" | "2027-01-25"; premiumMonth: "2026-11" | "2026-12" } = RUN,
): PayrollRunItem {
  const full = { ...input, ...overrides };
  return {
    employeeId: kind === "officer" ? "emp_officer" : "emp_employee",
    name: kind === "officer" ? "テスト 太郎" : "テスト 花子",
    kind,
    input: full,
    adjustmentNote: overrides.adjustments ? "前月の誤りの訂正" : null,
    result: calculatePayroll(payrollInputOf(run, { kind, input: full })),
  };
}

const officer = (overrides: Partial<PayrollRunItemInput> = {}) =>
  item("officer", OFFICER_INPUT, overrides);
const employee = (overrides: Partial<PayrollRunItemInput> = {}) =>
  item("employee", EMPLOYEE_INPUT, overrides);

type LineRow = [side: string, account: string, amount: bigint];

/** Lines as `[side, 2300〔源泉所得税〕 | wallet, amount]` for compact assertions. */
function rows(lines: readonly PayrollEntryLine[]): LineRow[] {
  return lines.map((line) => [
    line.side,
    line.target.kind === "wallet"
      ? "wallet"
      : line.target.subAccountName
        ? `${line.target.accountCode}〔${line.target.subAccountName}〕`
        : line.target.accountCode,
    line.amount,
  ]);
}

function totals(lines: readonly PayrollEntryLine[]): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    expect(line.amount > 0n).toBe(true);
    if (line.side === "debit") debit += line.amount;
    else credit += line.amount;
  }
  return { debit, credit };
}

// ---------------------------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------------------------

describe("premium months", () => {
  it("翌月控除 deducts the previous month's premium, 当月控除 the same month's", () => {
    expect(premiumMonthFor("2026-12", "next_month")).toBe("2026-11");
    expect(premiumMonthFor("2027-01", "next_month")).toBe("2026-12");
    expect(premiumMonthFor("2026-12", "same_month")).toBe("2026-12");
    expect(() => premiumMonthFor("2026-13", "next_month")).toThrow(RangeError);
    expect(() => premiumMonthFor("2026-12", "later" as never)).toThrow(RangeError);
  });

  it("shifts months across years", () => {
    expect(shiftYearMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftYearMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftYearMonth("2026-06", 5)).toBe("2026-11");
    expect(shiftYearMonth("2026-12", -24)).toBe("2024-12");
    expect(shiftYearMonth("2026-12", 0)).toBe("2026-12");
    expect(() => shiftYearMonth("2026-12", 0.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Deadlines (§7.1)
// ---------------------------------------------------------------------------------------------

describe("payment deadlines", () => {
  it("源泉所得税: the 10th of the next month, into January across the year", () => {
    expect(withholdingSlot("2026-12", false)).toEqual({
      category: "withholding",
      ruleKey: "payroll.withholding.2026-12",
      title: "源泉所得税の納付（2026 年 12 月支給分）",
      dueDate: "2027-01-10",
      periodLabel: "2026 年 12 月支給分",
    });
    expect(withholdingSlot("2027-01", false).dueDate).toBe("2027-02-10");
  });

  it("源泉所得税（納期の特例）: January–June by 10 July, July–December by 20 January", () => {
    expect(withholdingSlot("2026-12", true)).toEqual({
      category: "withholding",
      ruleKey: "payroll.withholding.2026-H2",
      title: "源泉所得税の納付（2026 年 7〜12 月支給分・納期の特例）",
      dueDate: "2027-01-20",
      periodLabel: "2026 年 7〜12 月支給分",
    });
    expect(withholdingSlot("2026-07", true).ruleKey).toBe("payroll.withholding.2026-H2");
    expect(withholdingSlot("2027-01", true)).toMatchObject({
      ruleKey: "payroll.withholding.2027-H1",
      title: "源泉所得税の納付（2027 年 1〜6 月支給分・納期の特例）",
      dueDate: "2027-07-10",
    });
    expect(withholdingSlot("2027-06", true).ruleKey).toBe("payroll.withholding.2027-H1");
  });

  it("住民税: the 10th of the next month", () => {
    expect(residentTaxSlot("2026-12", false)).toEqual({
      category: "resident_tax",
      ruleKey: "payroll.resident_tax.2026-12",
      title: "住民税の納付（2026 年 12 月分）",
      dueDate: "2027-01-10",
      periodLabel: "2026 年 12 月分",
    });
  });

  it("住民税（納期の特例）: June–November by 10 December, December–May by 10 June", () => {
    expect(residentTaxSlot("2026-12", true)).toEqual({
      category: "resident_tax",
      ruleKey: "payroll.resident_tax.2026-12to2027-05",
      title: "住民税の納付（2026 年 12 月〜2027 年 5 月分・納期の特例）",
      dueDate: "2027-06-10",
      periodLabel: "2026 年 12 月〜2027 年 5 月分",
    });
    for (const month of ["2027-01", "2027-03", "2027-05"] as const) {
      expect(residentTaxSlot(month, true).ruleKey).toBe("payroll.resident_tax.2026-12to2027-05");
      expect(residentTaxSlot(month, true).dueDate).toBe("2027-06-10");
    }
    expect(residentTaxSlot("2026-06", true)).toMatchObject({
      ruleKey: "payroll.resident_tax.2026-06to2026-11",
      title: "住民税の納付（2026 年 6〜11 月分・納期の特例）",
      dueDate: "2026-12-10",
    });
    expect(residentTaxSlot("2026-11", true).dueDate).toBe("2026-12-10");
    expect(residentTaxSlot("2027-06", true).ruleKey).toBe("payroll.resident_tax.2027-06to2027-11");
  });

  it("社会保険料: the last day of the month after the premium month", () => {
    expect(socialInsuranceSlot("2026-11")).toEqual({
      category: "social_insurance",
      ruleKey: "payroll.social_insurance.2026-11",
      title: "社会保険料の納付（2026 年 11 月分）",
      dueDate: "2026-12-31",
      periodLabel: "2026 年 11 月分",
    });
    expect(socialInsuranceSlot("2026-12").dueDate).toBe("2027-01-31");
    expect(socialInsuranceSlot("2027-01").dueDate).toBe("2027-02-28");
    expect(socialInsuranceSlot("2028-01").dueDate).toBe("2028-02-29");
  });

  it("reads the category back from a rule key, and nothing from other keys", () => {
    expect(paymentCategoryOfRuleKey("payroll.withholding.2026-H2")).toBe("withholding");
    expect(paymentCategoryOfRuleKey("payroll.resident_tax.2026-12")).toBe("resident_tax");
    expect(paymentCategoryOfRuleKey("payroll.social_insurance.2026-11")).toBe("social_insurance");
    expect(paymentCategoryOfRuleKey("payroll.unknown.2026-11")).toBeNull();
    expect(paymentCategoryOfRuleKey("tax.withholding.2026-12")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Entries (§5.3・§5.4)
// ---------------------------------------------------------------------------------------------

describe("buildPayrollEntries", () => {
  it("§8.4: the officer and the employee into 2 balanced entries", () => {
    const entries = buildPayrollEntries({
      payMonth: "2026-12",
      premiumMonth: "2026-11",
      items: [officer(), employee()],
      payFrom: "accrued",
      commuteTaxCategoryCode: "purchase_10",
    });
    expect(entries.pay.description).toBe("給与 2026 年 12 月支給");
    expect(rows(entries.pay.lines)).toEqual([
      ["debit", "5200", 300_000n],
      ["debit", "5210", 250_000n],
      ["debit", "5360", 10_000n],
      ["credit", "2300〔源泉所得税〕", 6_430n + 4_770n],
      ["credit", "2300〔住民税〕", 10_000n],
      ["credit", "2300〔社会保険料〕", 42_675n + 36_985n],
      ["credit", "2300〔雇用保険料〕", 1_300n],
      ["credit", "2100〔給与〕", 250_895n + 206_945n],
    ]);
    expect(entries.pay.lines.map((line) => line.taxCategoryCode)).toEqual([
      "na",
      "na",
      "purchase_10",
      "na",
      "na",
      "na",
      "na",
      "na",
    ]);
    expect(totals(entries.pay.lines)).toEqual({ debit: 560_000n, credit: 560_000n });

    // 会社負担: 健保 15,225 + 13,195、厚年 27,450 + 23,790、拠出金 1,080 + 936 (雇用保険は年度更新).
    expect(entries.employer?.description).toBe("法定福利費 2026 年 11 月分");
    expect(rows(entries.employer?.lines ?? [])).toEqual([
      ["debit", "5220", 81_676n],
      ["credit", "2110〔社会保険料〕", 81_676n],
    ]);
    expect(entries.socialInsurance.employerTotal).toBe(81_676n);
  });

  it("pays from the wallet instead of 未払金〔給与〕 and leaves out lines of 0 円", () => {
    const entries = buildPayrollEntries({
      payMonth: "2026-12",
      premiumMonth: "2026-11",
      items: [officer()],
      payFrom: "wallet",
      commuteTaxCategoryCode: "purchase_10",
    });
    expect(rows(entries.pay.lines)).toEqual([
      ["debit", "5200", 300_000n],
      ["credit", "2300〔源泉所得税〕", 6_430n],
      ["credit", "2300〔社会保険料〕", 42_675n],
      ["credit", "wallet", 250_895n],
    ]);
  });

  it("puts a negative total (an adjustment) on the other side", () => {
    const refund = officer({ adjustments: { incomeTax: -10_000n, socialInsurance: 0n } });
    expect(refund.result.incomeTaxTotal).toBe(-3_570n);
    const entries = buildPayrollEntries({
      payMonth: "2026-12",
      premiumMonth: "2026-11",
      items: [refund],
      payFrom: "accrued",
      commuteTaxCategoryCode: "purchase_10",
    });
    expect(rows(entries.pay.lines)).toEqual([
      ["debit", "5200", 300_000n],
      ["debit", "2300〔源泉所得税〕", 3_570n],
      ["credit", "2300〔社会保険料〕", 42_675n],
      ["credit", "2100〔給与〕", 260_895n],
    ]);
    const { debit, credit } = totals(entries.pay.lines);
    expect(debit).toBe(credit);
  });

  it("makes no employer entry without social insurance", () => {
    const uninsured = employee({
      coverage: { health: false, care: false, pension: false, employment: true },
      standardRemuneration: { health: 0n, pension: 0n },
    });
    const entries = buildPayrollEntries({
      payMonth: "2026-12",
      premiumMonth: "2026-11",
      items: [uninsured],
      payFrom: "accrued",
      commuteTaxCategoryCode: "purchase_10",
    });
    expect(entries.employer).toBeNull();
    expect(rows(entries.pay.lines).map(([, account]) => account)).not.toContain(
      "2300〔社会保険料〕",
    );
  });
});

describe("buildPaymentEntry", () => {
  const scheduled = { total: 161_336n, withheld: 79_660n, employer: 81_676n };

  it("源泉所得税・住民税: 預り金 against the wallet, at the scheduled amount only", () => {
    const entry = buildPaymentEntry({
      category: "withholding",
      description: "源泉所得税の納付（2026 年 12 月支給分）",
      scheduled: { total: 11_200n, withheld: 11_200n, employer: 0n },
      paid: 11_200n,
    });
    expect(rows(entry.lines)).toEqual([
      ["debit", "2300〔源泉所得税〕", 11_200n],
      ["credit", "wallet", 11_200n],
    ]);
    expect(
      rows(
        buildPaymentEntry({
          category: "resident_tax",
          description: "住民税の納付（2026 年 12 月分）",
          scheduled: { total: 10_000n, withheld: 10_000n, employer: 0n },
          paid: 10_000n,
        }).lines,
      ),
    ).toEqual([
      ["debit", "2300〔住民税〕", 10_000n],
      ["credit", "wallet", 10_000n],
    ]);
    expect(() =>
      buildPaymentEntry({
        category: "withholding",
        description: "x",
        scheduled: { total: 11_200n, withheld: 11_200n, employer: 0n },
        paid: 11_201n,
      }),
    ).toThrow(RangeError);
  });

  it("社会保険料: 預り金 + 未払費用, the difference from the notice on 法定福利費", () => {
    const description = "社会保険料の納付（2026 年 11 月分）";
    expect(
      rows(
        buildPaymentEntry({ category: "social_insurance", description, scheduled, paid: 161_336n })
          .lines,
      ),
    ).toEqual([
      ["debit", "2300〔社会保険料〕", 79_660n],
      ["debit", "2110〔社会保険料〕", 81_676n],
      ["credit", "wallet", 161_336n],
    ]);
    expect(
      rows(
        buildPaymentEntry({ category: "social_insurance", description, scheduled, paid: 161_337n })
          .lines,
      ),
    ).toEqual([
      ["debit", "2300〔社会保険料〕", 79_660n],
      ["debit", "2110〔社会保険料〕", 81_676n],
      ["debit", "5220", 1n],
      ["credit", "wallet", 161_337n],
    ]);
    const lower = buildPaymentEntry({
      category: "social_insurance",
      description,
      scheduled,
      paid: 161_335n,
    });
    expect(rows(lower.lines)).toEqual([
      ["debit", "2300〔社会保険料〕", 79_660n],
      ["debit", "2110〔社会保険料〕", 81_676n],
      ["credit", "5220", 1n],
      ["credit", "wallet", 161_335n],
    ]);
    const { debit, credit } = totals(lower.lines);
    expect(debit).toBe(credit);
    expect(() =>
      buildPaymentEntry({ category: "social_insurance", description, scheduled, paid: 0n }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Scheduled amounts (§7.2)
// ---------------------------------------------------------------------------------------------

describe("scheduled amounts", () => {
  const december = summarizePayrollRun({
    payMonth: "2026-12",
    premiumMonth: "2026-11",
    withholdingSpecialDue: true,
    residentTaxSpecialDue: true,
    items: [officer(), employee()],
  });
  const januaryItems = [
    item("officer", OFFICER_INPUT, {}, { paymentDate: "2027-01-25", premiumMonth: "2026-12" }),
    item(
      "employee",
      EMPLOYEE_INPUT,
      { residentTax: 0n, adjustments: { incomeTax: -200n, socialInsurance: 100n } },
      { paymentDate: "2027-01-25", premiumMonth: "2026-12" },
    ),
  ];
  const january = summarizePayrollRun({
    payMonth: "2027-01",
    premiumMonth: "2026-12",
    withholdingSpecialDue: true,
    residentTaxSpecialDue: true,
    items: januaryItems,
  });

  it("summarizes a run with the adjusted totals", () => {
    expect(december).toMatchObject({
      headcount: 2,
      grossPay: 560_000n,
      incomeTax: 11_200n,
      residentTax: 10_000n,
      socialInsuranceEmployee: 79_660n,
      socialInsuranceEmployer: 81_676n,
      employmentInsuranceEmployee: 1_300n,
      netPay: 457_840n,
    });
    expect(december.grossPay - december.totalDeductions).toBe(december.netPay);
    const [, adjusted] = januaryItems;
    expect(january.incomeTax).toBe(6_260n + (adjusted?.result.incomeTaxTotal ?? 0n));
    expect(january.socialInsuranceEmployee).toBe(42_675n + 36_985n + 100n);
  });

  it("adds runs paying into the same deadline and keeps the others apart", () => {
    const runs: PayrollRunSummary[] = [december, january];
    // 源泉所得税（納期の特例）: December goes to 2026-H2, January to 2027-H1.
    expect(scheduleAmount("payroll.withholding.2026-H2", runs)).toEqual({
      total: 11_200n,
      withheld: 11_200n,
      employer: 0n,
      payMonths: ["2026-12"],
      bonusMonths: [],
    });
    expect(scheduleAmount("payroll.withholding.2027-H1", runs).payMonths).toEqual(["2027-01"]);
    // 住民税（納期の特例）: both are in December–May.
    expect(scheduleAmount("payroll.resident_tax.2026-12to2027-05", runs)).toEqual({
      total: 10_000n,
      withheld: 10_000n,
      employer: 0n,
      payMonths: ["2026-12", "2027-01"],
      bonusMonths: [],
    });
    // 社会保険料: one premium month each, employee + employer.
    expect(scheduleAmount("payroll.social_insurance.2026-11", runs)).toEqual({
      total: 79_660n + 81_676n,
      withheld: 79_660n,
      employer: 81_676n,
      payMonths: ["2026-12"],
      bonusMonths: [],
    });
    expect(scheduleAmount("payroll.social_insurance.2026-12", runs).withheld).toBe(79_760n);
    expect(scheduleAmount("payroll.withholding.2027-12", runs).total).toBe(0n);
    expect(scheduleAmount("tax.other", runs).total).toBe(0n);
  });

  it("lists every deadline once, by due date, without 0 円 categories", () => {
    const schedule = payrollSchedule([december, january]);
    expect(schedule.map((row) => [row.ruleKey, row.dueDate, row.total])).toEqual([
      ["payroll.social_insurance.2026-11", "2026-12-31", 161_336n],
      ["payroll.withholding.2026-H2", "2027-01-20", 11_200n],
      ["payroll.social_insurance.2026-12", "2027-01-31", 79_760n + 81_676n],
      ["payroll.resident_tax.2026-12to2027-05", "2027-06-10", 10_000n],
      ["payroll.withholding.2027-H1", "2027-07-10", january.incomeTax],
    ]);
    // January has no 住民税 of its own: it makes no deadline of that category.
    const own = runPaymentSlots({ ...january, residentTax: 0n });
    expect(own.map(({ slot }) => slot.category)).toEqual(["withholding", "social_insurance"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Snapshot (§5.5)
// ---------------------------------------------------------------------------------------------

describe("run snapshot", () => {
  const items = [
    officer(),
    employee({ adjustments: { incomeTax: -200n, socialInsurance: 100n } }),
    item("employee", { ...EMPLOYEE_INPUT, taxColumn: { column: "otsu", secondaryDependents: 1 } }),
    item("employee", { ...EMPLOYEE_INPUT, taxColumn: { column: "otsu" } }),
  ];

  /** Through JSON, as Postgres stores it. */
  const stored = () => JSON.parse(JSON.stringify(serializePayrollRunItems(items))) as unknown;

  it("stores amounts as strings and reads them back as they were", () => {
    const json = stored() as {
      result: { netPay: unknown; socialInsurance: { health: { full: unknown } } };
    }[];
    expect(json[0]?.result.netPay).toBe("250895");
    expect(json[0]?.result.socialInsurance.health.full).toEqual({ num: "30450", den: "1" });
    expect(parsePayrollRunItems(json)).toEqual(items);
  });

  it("recalculates identically with the stored table ids", () => {
    const ids = tableIdsOf(items.map((row) => row.result));
    expect(ids).toEqual({
      withholding: "withholding-monthly-2026",
      kenpo: "kyokai-kenpo-kanagawa-2026",
      pension: "pension-2020",
      employment: "employment-insurance-2026",
    });
    const readIds = parsePayrollTableIds(JSON.parse(JSON.stringify(serializePayrollTableIds(ids))));
    const tables = pinnedTables(readIds);
    const again = parsePayrollRunItems(stored()).map((row) => ({
      ...row,
      result: calculatePayroll(payrollInputOf(RUN, row, tables)),
    }));
    expect(serializePayrollRunItems(again)).toEqual(serializePayrollRunItems(items));
    expect(tableIdsOf([officer().result]).employment).toBeNull();
  });

  it("rejects ids that are not registered", () => {
    expect(() =>
      pinnedTables({
        withholding: "withholding-monthly-2026",
        kenpo: "kyokai-kenpo-kanagawa-1999",
        pension: "pension-2020",
        employment: null,
      }),
    ).toThrow(PayrollSnapshotError);
    expect(() =>
      pinnedTables({
        withholding: "pension-2020",
        kenpo: "kyokai-kenpo-kanagawa-2026",
        pension: "pension-2020",
        employment: null,
      }),
    ).toThrow(/withholding/);
    expect(findTableById("pension-2020")?.kind).toBe("pension");
  });

  it("rejects anything but the exact shape", () => {
    const mutate = (change: (rows: Record<string, unknown>[]) => void): unknown => {
      const rows = stored() as Record<string, unknown>[];
      change(rows);
      return rows;
    };
    const result = (rows: Record<string, unknown>[]) =>
      (rows[0] as { result: Record<string, unknown> }).result;
    const cases: [string, unknown][] = [
      ["not an array", {}],
      ["an unknown key", mutate((rows) => (rows[0] = { ...rows[0], extra: 1 }))],
      ["a missing key", mutate((rows) => delete result(rows).netPay)],
      ["a number amount", mutate((rows) => (result(rows).netPay = 250_895))],
      ["a decimal amount", mutate((rows) => (result(rows).netPay = "250895.5"))],
      ["a leading zero", mutate((rows) => (result(rows).netPay = "0250895"))],
      [
        "an unnormalized rational",
        mutate(
          (rows) =>
            ((result(rows).socialInsurance as { childContribution: unknown }).childContribution = {
              num: "2160",
              den: "2",
            }),
        ),
      ],
      ["inconsistent totals", mutate((rows) => (result(rows).netPay = "250896"))],
      ["an unknown kind", mutate((rows) => (rows[0] = { ...rows[0], kind: "partner" }))],
      [
        "an unknown tax column",
        mutate(
          (rows) =>
            ((rows[0] as { input: Record<string, unknown> }).input.taxColumn = { column: "hei" }),
        ),
      ],
    ];
    for (const [label, json] of cases) {
      expect(() => parsePayrollRunItems(json), label).toThrow(PayrollSnapshotError);
    }
    expect(() => parsePayrollTableIds({ withholding: "a", kenpo: "b", pension: "c" })).toThrow(
      PayrollSnapshotError,
    );
  });
});
