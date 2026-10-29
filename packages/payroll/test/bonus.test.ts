/**
 * 賞与 (22-payroll §10): the three examples of No.2523 (令和 8 年分) exactly, 標準賞与額 and its caps,
 * the premiums and their rounding, the officer's filing check, the 2 balanced entries, what a bonus
 * run adds to the payment schedule, and the snapshot. Every person is fictional.
 */
import { describe, expect, it } from "vitest";
import {
  bonusInputOf,
  bonusRateRow,
  bonusReportSlot,
  bonusTableIdsOf,
  bonusWithholdingTax,
  buildBonusEntries,
  calculateBonus,
  calculatePayroll,
  cappedStandardBonus,
  findBonusWithholdingTable,
  findWithholdingTable,
  insuranceYearOf,
  parseBonusRunItems,
  parseBonusTableIds,
  paymentCategoryOfRuleKey,
  PayrollInputError,
  PayrollSnapshotError,
  PayrollTableMissingError,
  pinnedBonusTables,
  predeterminedFilingWarnings,
  runPaymentSlots,
  scheduleAmount,
  serializeBonusRunItems,
  serializeBonusTableIds,
  standardBonusAmount,
  summarizeBonusRun,
  summarizePayrollRun,
  withholdingTax,
  type BonusInput,
  type PayrollBonusItem,
  type PayrollEntryLine,
} from "../src";

const BONUS_2026 = findBonusWithholdingTable("2026-12-10");
const MONTHLY_2026 = findWithholdingTable("2026-12-10");

// ---------------------------------------------------------------------------------------------
// §10.6: No.2523 の具体例（令和 8 年分）
// ---------------------------------------------------------------------------------------------

describe("No.2523 (令和 8 年分)", () => {
  it("前月 285,454 円・賞与 389,558 円・扶養 3 人 → 2.042% → 7,954 円", () => {
    const result = bonusWithholdingTax({
      bonusTable: BONUS_2026,
      monthlyTable: MONTHLY_2026,
      taxColumn: { column: "kou", dependents: 3 },
      base: 389_558n,
      previousMonth: { pay: 285_454n, incomeTax: 0n },
      calcPeriodOver6Months: false,
    });
    expect(result).toMatchObject({ method: "rate", ratePercent: "2.042", tax: 7_954n });
  });

  it("前月 166,531 円・賞与 1,668,062 円・扶養 1 人・6 か月 → (16,100 − 1,510) × 6 = 87,540 円", () => {
    const previousTax = withholdingTax(MONTHLY_2026, { column: "kou", dependents: 1 }, 166_531n);
    expect(previousTax).toBe(1_510n);
    const result = bonusWithholdingTax({
      bonusTable: BONUS_2026,
      monthlyTable: MONTHLY_2026,
      taxColumn: { column: "kou", dependents: 1 },
      base: 1_668_062n,
      previousMonth: { pay: 166_531n, incomeTax: previousTax },
      calcPeriodOver6Months: false,
    });
    expect(result).toEqual({
      method: "monthly_10x",
      ratePercent: null,
      rate: null,
      divisor: 6,
      // 1,668,062 ÷ 6 = 278,010（1 円未満切り捨て）+ 166,531
      monthlyAmount: 444_541n,
      monthlyTax: 16_100n,
      previousMonthTax: 1_510n,
      tax: 87_540n,
    });
  });

  it("前月の給与なし・賞与 769,300 円・扶養 0 人 → 1,300 × 6 = 7,800 円", () => {
    const input = {
      bonusTable: BONUS_2026,
      monthlyTable: MONTHLY_2026,
      taxColumn: { column: "kou", dependents: 0 },
      base: 769_300n,
      previousMonth: null,
      calcPeriodOver6Months: false,
    } as const;
    expect(bonusWithholdingTax(input)).toMatchObject({
      method: "monthly_no_prev",
      divisor: 6,
      monthlyAmount: 128_216n,
      monthlyTax: 1_300n,
      tax: 7_800n,
    });
    // 計算期間が 6 か月超: 769,300 ÷ 12 = 64,108 円 is below the table (0 円) × 12.
    expect(bonusWithholdingTax({ ...input, calcPeriodOver6Months: true })).toMatchObject({
      divisor: 12,
      monthlyAmount: 64_108n,
      tax: 0n,
    });
    // 前月の給与 ≤ 前月の社会保険料等 (0 or less after them) counts as no pay.
    expect(
      bonusWithholdingTax({ ...input, previousMonth: { pay: 0n, incomeTax: 0n } }).method,
    ).toBe("monthly_no_prev");
  });

  it("finds the row of the previous month's pay by 以上・未満, 7 人以上 and 乙欄", () => {
    const kou = (dependents: number, pay: bigint) =>
      bonusRateRow(BONUS_2026, { column: "kou", dependents }, pay).ratePercent;
    expect(kou(0, 81_999n)).toBe("0");
    expect(kou(0, 82_000n)).toBe("2.042");
    expect(kou(0, 93_999n)).toBe("2.042");
    expect(kou(0, 94_000n)).toBe("4.084");
    expect(kou(0, 3_495_000n)).toBe("45.945");
    expect(kou(7, 316_999n)).toBe("0");
    expect(kou(9, 316_999n)).toBe("0");
    expect(kou(9, 317_000n)).toBe("2.042");
    const otsu = (pay: bigint) =>
      bonusRateRow(BONUS_2026, { column: "otsu", secondaryDependents: 2 }, pay).ratePercent;
    expect([otsu(1n), otsu(223_999n), otsu(224_000n), otsu(527_000n), otsu(1_118_000n)]).toEqual([
      "10.21",
      "10.21",
      "20.42",
      "38.798",
      "45.945",
    ]);
    // 乙欄 300,000 円 → 30.63%: 100,000 × 30.63% = 30,630.
    expect(
      bonusWithholdingTax({
        bonusTable: BONUS_2026,
        monthlyTable: MONTHLY_2026,
        taxColumn: { column: "otsu" },
        base: 100_000n,
        previousMonth: { pay: 300_000n, incomeTax: 0n },
        calcPeriodOver6Months: false,
      }).tax,
    ).toBe(30_630n);
  });
});

// ---------------------------------------------------------------------------------------------
// §10.2: 標準賞与額
// ---------------------------------------------------------------------------------------------

describe("標準賞与額", () => {
  it("truncates to the thousand yen", () => {
    expect(standardBonusAmount(0n)).toBe(0n);
    expect(standardBonusAmount(999n)).toBe(0n);
    expect(standardBonusAmount(1_999n)).toBe(1_000n);
    expect(standardBonusAmount(389_558n)).toBe(389_000n);
    expect(() => standardBonusAmount(-1n)).toThrow(PayrollInputError);
  });

  it("caps health at 573 万円 a 年度 and the pension at 150 万円 a month", () => {
    const both = { health: true, pension: true };
    expect(cappedStandardBonus(2_000_500n, 0n, both)).toEqual({
      amount: 2_000_000n,
      health: 2_000_000n,
      pension: 1_500_000n,
    });
    expect(cappedStandardBonus(1_000_000n, 5_000_000n, both)).toEqual({
      amount: 1_000_000n,
      health: 730_000n,
      pension: 1_000_000n,
    });
    expect(cappedStandardBonus(1_000_000n, 5_730_000n, both).health).toBe(0n);
    expect(cappedStandardBonus(1_000_000n, 0n, { health: false, pension: false })).toEqual({
      amount: 1_000_000n,
      health: 0n,
      pension: 0n,
    });
    // 年度: 4 月 1 日〜翌年 3 月 31 日.
    expect(insuranceYearOf("2026-04-01")).toBe(2026);
    expect(insuranceYearOf("2027-03-31")).toBe(2026);
  });
});

// ---------------------------------------------------------------------------------------------
// calculateBonus
// ---------------------------------------------------------------------------------------------

/** テスト 太郎 (役員, §8.4): 2026 年 11 月支給の給与は社会保険料等控除後 257,325 円・税額 6,430 円. */
const OFFICER: BonusInput = {
  paymentDate: "2026-12-10",
  worker: "officer",
  bonus: 1_000_000n,
  coverage: { health: true, care: false, pension: true, employment: false },
  taxColumn: { column: "kou", dependents: 0 },
  previousMonth: { pay: 257_325n, incomeTax: 6_430n },
  calcPeriodOver6Months: false,
  priorHealthStandardBonus: 0n,
};

/** テスト 花子 (従業員・介護あり・扶養 1 人). */
const EMPLOYEE: BonusInput = {
  paymentDate: "2026-12-10",
  worker: "employee",
  bonus: 500_500n,
  coverage: { health: true, care: true, pension: true, employment: true },
  taxColumn: { column: "kou", dependents: 1 },
  previousMonth: { pay: 211_715n, incomeTax: 3_150n },
  calcPeriodOver6Months: false,
  priorHealthStandardBonus: 0n,
};

describe("calculateBonus", () => {
  it("an officer: 標準賞与額 1,000,000 円, 健保 50,750・厚年 91,500, 4.084% → 35,030 円", () => {
    const result = calculateBonus(OFFICER);
    expect(result).toMatchObject({
      bonus: 1_000_000n,
      standardBonus: { amount: 1_000_000n, health: 1_000_000n, pension: 1_000_000n },
      employmentInsurance: null,
      // 1,000,000 − 50,750 − 91,500
      withholdingBase: 857_750n,
      withholding: { method: "rate", ratePercent: "4.084" },
      // 857,750 × 4.084% = 35,030.51
      incomeTax: 35_030n,
      totalDeductions: 50_750n + 91_500n + 35_030n,
      netPay: 822_720n,
    });
    // (9.92% + 0.23%) × 1,000,000 ÷ 2; 18.3% × 1,000,000 ÷ 2
    expect(result.socialInsurance.health.employee).toBe(50_750n);
    expect(result.socialInsurance.pension.employee).toBe(91_500n);
    expect(result.tables.bonusWithholding.id).toBe("withholding-bonus-2026");
    expect(result.tables.withholding.id).toBe("withholding-monthly-2026");
    expect(result.tables.kenpo.id).toBe("kyokai-kenpo-kanagawa-2026");
    expect(result.tables.employment).toBeNull();
  });

  it("an employee with care: 50 銭 rounds down, 2.042% of the 対象額", () => {
    const result = calculateBonus(EMPLOYEE);
    // 健保 500,000 × 11.77% ÷ 2 = 29,425; 厚年 45,750; 雇用 500,500 × 5/1000 = 2,502.5 → 2,502.
    expect(result.socialInsurance.health.employee).toBe(29_425n);
    expect(result.socialInsurance.pension.employee).toBe(45_750n);
    expect(result.employmentInsurance?.employee).toBe(2_502n);
    expect(result.withholdingBase).toBe(500_500n - 29_425n - 45_750n - 2_502n);
    expect(result.withholding.ratePercent).toBe("2.042");
    // 422,823 × 2.042% = 8,634.04…
    expect(result.incomeTax).toBe(8_634n);
    expect(result.netPay).toBe(414_189n);
    expect(result.netPay + result.totalDeductions).toBe(result.bonus);
  });

  it("applies the caps to the premiums and the 10-times exception to a large bonus", () => {
    const capped = calculateBonus({
      ...OFFICER,
      bonus: 3_000_000n,
      priorHealthStandardBonus: 5_000_000n,
    });
    expect(capped.standardBonus).toEqual({
      amount: 3_000_000n,
      health: 730_000n,
      pension: 1_500_000n,
    });
    // 730,000 × 10.15% ÷ 2 = 37,047.5 → 37,047 (50 銭以下切り捨て)
    expect(capped.socialInsurance.health.employee).toBe(37_047n);
    expect(capped.socialInsurance.pension.employee).toBe(137_250n);
    expect(capped.withholding.method).toBe("monthly_10x");
    expect(capped.withholdingBase).toBe(3_000_000n - 37_047n - 137_250n);
  });

  it("uses the 令和 9 年分 tables for a 2027 payment and stops when a table is missing", () => {
    expect(
      calculateBonus({ ...OFFICER, paymentDate: "2027-01-15" }).tables.bonusWithholding.id,
    ).toBe("withholding-bonus-2027");
    let error: unknown;
    try {
      calculateBonus({ ...OFFICER, paymentDate: "2028-01-15" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PayrollTableMissingError);
    expect((error as PayrollTableMissingError).tableKind).toBe("withholding-bonus");
  });

  it("rejects 雇用保険 for an officer and invalid amounts", () => {
    const codes = (input: BonusInput) => {
      try {
        calculateBonus(input);
      } catch (error) {
        expect(error).toBeInstanceOf(PayrollInputError);
        return (error as PayrollInputError).codes;
      }
      return [];
    };
    expect(codes({ ...OFFICER, coverage: { ...OFFICER.coverage, employment: true } })).toEqual([
      "OFFICER_EMPLOYMENT_INSURANCE",
    ]);
    expect(codes({ ...OFFICER, bonus: -1n })).toEqual(["INVALID_AMOUNT"]);
    expect(codes({ ...OFFICER, previousMonth: { pay: 1n, incomeTax: -1n } })).toEqual([
      "INVALID_AMOUNT",
    ]);
    expect(codes({ ...OFFICER, tables: { kenpo: undefined, pension: undefined } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// §10.3: 事前確定届出給与
// ---------------------------------------------------------------------------------------------

describe("事前確定届出給与", () => {
  const codes = (
    filing: { date: string | null; amount: bigint | null } | null,
    bonus = 1_000_000n,
  ) =>
    predeterminedFilingWarnings(
      {
        kind: "officer",
        bonus,
        filing: filing as Parameters<typeof predeterminedFilingWarnings>[0]["filing"],
      },
      "2026-12-10",
    ).map((warning) => warning.code);

  it("warns when the filing is missing or differs, never for an employee", () => {
    expect(codes({ date: "2026-12-10", amount: 1_000_000n })).toEqual([]);
    expect(codes(null)).toEqual(["FILING_MISSING"]);
    expect(codes({ date: "2026-12-10", amount: null })).toEqual(["FILING_MISSING"]);
    expect(codes({ date: "2026-12-15", amount: 1_000_000n })).toEqual(["FILING_DATE_MISMATCH"]);
    expect(codes({ date: "2026-12-10", amount: 900_000n })).toEqual(["FILING_AMOUNT_MISMATCH"]);
    expect(codes(null, 0n)).toEqual([]);
    expect(codes({ date: "2026-12-10", amount: 900_000n }, 0n)).toEqual(["FILING_AMOUNT_MISMATCH"]);
    expect(
      predeterminedFilingWarnings({ kind: "employee", bonus: 1n, filing: null }, "2026-12-10"),
    ).toEqual([]);
    const [missing] = predeterminedFilingWarnings(
      { kind: "officer", bonus: 1n, filing: { date: "2026-12-15", amount: 2n } },
      "2026-12-10",
    );
    expect(missing?.message).toMatch(/2026\/12\/10 が届け出た支給日 2026\/12\/15 と違います/);
  });
});

// ---------------------------------------------------------------------------------------------
// §10.4: 仕訳と暦
// ---------------------------------------------------------------------------------------------

function totals(lines: readonly PayrollEntryLine[]) {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    if (line.side === "debit") debit += line.amount;
    else credit += line.amount;
  }
  return { debit, credit };
}

const target = (line: PayrollEntryLine) =>
  line.target.kind === "wallet"
    ? "wallet"
    : line.target.subAccountName
      ? `${line.target.accountCode}〔${line.target.subAccountName}〕`
      : line.target.accountCode;

describe("the bonus entries and the schedule", () => {
  const officer = calculateBonus(OFFICER);
  const employee = calculateBonus(EMPLOYEE);
  const items = [
    { kind: "officer" as const, result: officer },
    { kind: "employee" as const, result: employee },
  ];

  it("makes 2 balanced entries on the 賞与 sub-accounts", () => {
    const entries = buildBonusEntries({
      payMonth: "2026-12",
      title: "冬季賞与",
      items,
      payFrom: "accrued",
    });
    expect(entries.pay.description).toBe("冬季賞与 2026 年 12 月支給");
    expect(entries.pay.lines.map((line) => [line.side, target(line), line.amount])).toEqual([
      ["debit", "5200〔賞与〕", 1_000_000n],
      ["debit", "5210〔賞与〕", 500_500n],
      ["credit", "2300〔源泉所得税〕", 35_030n + 8_634n],
      ["credit", "2300〔社会保険料〕", 142_250n + 75_175n],
      ["credit", "2300〔雇用保険料〕", 2_502n],
      ["credit", "2100〔給与〕", 822_720n + 414_189n],
    ]);
    expect(entries.pay.lines.every((line) => line.taxCategoryCode === "na")).toBe(true);
    const pay = totals(entries.pay.lines);
    expect(pay.debit).toBe(pay.credit);

    // 会社分: 健保 160,350 − 80,175, 厚年 274,500 − 137,250, 拠出金 1,500,000 × 0.36% = 5,400.
    expect(entries.employer?.description).toBe("法定福利費 2026 年 12 月分（冬季賞与）");
    expect(entries.employer?.lines.map((line) => [line.side, target(line), line.amount])).toEqual([
      ["debit", "5220", 222_825n],
      ["credit", "2110〔社会保険料〕", 222_825n],
    ]);
    expect(entries.socialInsurance.employerTotal).toBe(222_825n);

    const wallet = buildBonusEntries({
      payMonth: "2026-12",
      title: "賞与",
      items,
      payFrom: "wallet",
    });
    expect(wallet.pay.lines.at(-1)).toMatchObject({ side: "credit", target: { kind: "wallet" } });
  });

  it("adds 源泉所得税 to the pay month and 社会保険料 to the pay month as premium month", () => {
    const bonus = summarizeBonusRun({ payMonth: "2026-12", withholdingSpecialDue: false, items });
    expect(bonus).toMatchObject({
      kind: "bonus",
      premiumMonth: "2026-12",
      residentTax: 0n,
      incomeTax: 43_664n,
      socialInsuranceEmployee: 217_425n,
      socialInsuranceEmployer: 222_825n,
      employmentInsuranceEmployee: 2_502n,
      grossPay: 1_500_500n,
      netPay: 1_236_909n,
    });
    expect(runPaymentSlots(bonus).map(({ slot }) => [slot.ruleKey, slot.dueDate])).toEqual([
      ["payroll.withholding.2026-12", "2027-01-10"],
      ["payroll.social_insurance.2026-12", "2027-01-31"],
    ]);
    expect(
      runPaymentSlots(
        summarizeBonusRun({ payMonth: "2026-12", withholdingSpecialDue: true, items }),
      )[0]?.slot.ruleKey,
    ).toBe("payroll.withholding.2026-H2");

    // A January run (翌月控除: 12 月分) pays into the same 社会保険料 deadline as the bonus.
    const january = summarizePayrollRun({
      payMonth: "2027-01",
      premiumMonth: "2026-12",
      withholdingSpecialDue: false,
      residentTaxSpecialDue: false,
      items: [
        {
          result: calculatePayroll({
            paymentDate: "2027-01-25",
            premiumMonth: "2026-12",
            worker: "officer",
            taxablePay: 300_000n,
            nonTaxablePay: 0n,
            standardRemuneration: { health: 300_000n, pension: 300_000n },
            coverage: OFFICER.coverage,
            taxColumn: { column: "kou", dependents: 0 },
            residentTax: 0n,
          }),
        },
      ],
    });
    const social = scheduleAmount("payroll.social_insurance.2026-12", [january, bonus]);
    expect(social).toMatchObject({
      withheld: january.socialInsuranceEmployee + 217_425n,
      employer: january.socialInsuranceEmployer + 222_825n,
      payMonths: ["2027-01"],
      bonusMonths: ["2026-12"],
    });
    // The bonus has no 住民税: it never shows on a 住民税 deadline.
    expect(scheduleAmount("payroll.resident_tax.2026-12", [bonus])).toMatchObject({
      total: 0n,
      bonusMonths: [],
    });
  });

  it("files 被保険者賞与支払届 within 5 days of the payment date", () => {
    const slot = bonusReportSlot("2026-12", "2026-12-28");
    expect(slot).toEqual({
      ruleKey: "payroll.bonus_report.2026-12",
      title: "被保険者賞与支払届の提出（2026 年 12 月支給の賞与）",
      dueDate: "2027-01-02",
    });
    expect(paymentCategoryOfRuleKey(slot.ruleKey)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

describe("the bonus snapshot", () => {
  const run = { paymentDate: "2026-12-10", calcPeriodOver6Months: false } as const;
  const items: PayrollBonusItem[] = [OFFICER, EMPLOYEE].map((input, index) => {
    const {
      paymentDate: _date,
      calcPeriodOver6Months: _period,
      worker,
      tables: _tables,
      ...rest
    } = input;
    return {
      employeeId: `emp_${index}`,
      name: index === 0 ? "テスト 太郎" : "テスト 花子",
      kind: worker,
      input: {
        ...rest,
        filing: worker === "officer" ? { date: "2026-12-10", amount: 1_000_000n } : null,
      },
      result: calculateBonus(input),
    };
  });

  it("round-trips through JSON and recalculates identically with the stored table ids", () => {
    const stored = JSON.parse(JSON.stringify(serializeBonusRunItems(items))) as unknown;
    expect(parseBonusRunItems(stored)).toEqual(items);
    const ids = bonusTableIdsOf(items.map((item) => item.result));
    expect(ids).toEqual({
      bonusWithholding: "withholding-bonus-2026",
      withholding: "withholding-monthly-2026",
      kenpo: "kyokai-kenpo-kanagawa-2026",
      pension: "pension-2020",
      employment: "employment-insurance-2026",
    });
    const storedIds = JSON.parse(JSON.stringify(serializeBonusTableIds(ids))) as unknown;
    expect(parseBonusTableIds(storedIds)).toEqual(ids);
    const tables = pinnedBonusTables(ids);
    const again = parseBonusRunItems(stored).map((item) => ({
      ...item,
      result: calculateBonus(bonusInputOf(run, item, tables)),
    }));
    expect(serializeBonusRunItems(again)).toEqual(stored);
  });

  it("rejects a changed snapshot", () => {
    const stored = JSON.parse(JSON.stringify(serializeBonusRunItems(items))) as {
      result: { netPay: string; withholding: { method: string } };
    }[];
    const netPay = structuredClone(stored);
    netPay[0]!.result.netPay = "1";
    expect(() => parseBonusRunItems(netPay)).toThrow(PayrollSnapshotError);
    const method = structuredClone(stored);
    method[0]!.result.withholding.method = "monthly_no_prev";
    expect(() => parseBonusRunItems(method)).toThrow(/exactly when/);
    expect(() =>
      pinnedBonusTables({
        bonusWithholding: "withholding-monthly-2026",
        withholding: "withholding-monthly-2026",
        kenpo: "kyokai-kenpo-kanagawa-2026",
        pension: "pension-2020",
        employment: null,
      }),
    ).toThrow(PayrollSnapshotError);
  });
});
