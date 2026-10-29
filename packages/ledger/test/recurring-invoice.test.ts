/**
 * 定期請求の予定日・支払期限・対象月 (docs/design/18-invoicing.md §14.1, §14.2, §14.6).
 */
import { describe, expect, it } from "vitest";
import {
  describeRecurringInvoiceDueRule,
  describeRecurringInvoiceSchedule,
  expandTargetMonth,
  hasTargetMonthPlaceholder,
  invoiceMonthLabel,
  nextRecurringInvoiceDates,
  RECURRING_INVOICE_FREQUENCY_LABELS,
  recurringInvoiceDateInMonth,
  recurringInvoiceDates,
  recurringInvoiceDueDate,
  recurringInvoiceDueRuleProblem,
  recurringInvoiceTargetMonth,
  recurringInvoiceTargetOffsetLabel,
  type RecurringInvoiceSchedule,
} from "../src";

const schedule = (
  issueDay: number,
  rest: Partial<RecurringInvoiceSchedule> = {},
): RecurringInvoiceSchedule => ({
  frequency: "monthly",
  issueDay,
  startDate: "2026-11-01",
  endDate: null,
  ...rest,
});

describe("recurringInvoiceDates", () => {
  it("puts a day the month does not have on its last day (末日 = 31, February, leap years)", () => {
    expect(
      recurringInvoiceDates(schedule(31), { after: "2026-11-01", through: "2027-02-28" }),
    ).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
    expect(
      recurringInvoiceDates(schedule(30, { startDate: "2028-01-01" }), {
        after: "2028-01-31",
        through: "2028-03-31",
      }),
    ).toEqual(["2028-02-29", "2028-03-30"]);
  });

  it("takes the dates after `after` up to `through` (the 92-day window of §14.2)", () => {
    expect(
      recurringInvoiceDates(schedule(25), { after: "2026-11-25", through: "2027-01-24" }),
    ).toEqual(["2026-12-25"]);
    expect(
      recurringInvoiceDates(schedule(25), { after: "2026-11-24", through: "2026-11-25" }),
    ).toEqual(["2026-11-25"]);
    expect(
      recurringInvoiceDates(schedule(25), { after: "2026-12-01", through: "2026-12-01" }),
    ).toEqual([]);
  });

  it("counts 隔月 from the month of the start date", () => {
    const bimonthly = schedule(10, { frequency: "bimonthly", startDate: "2026-11-15" });
    // 11/10 is before the start date; the next one of the start month's cycle is 2027/01/10.
    expect(
      recurringInvoiceDates(bimonthly, { after: "2026-10-31", through: "2027-05-31" }),
    ).toEqual(["2027-01-10", "2027-03-10", "2027-05-10"]);
    expect(recurringInvoiceDateInMonth(bimonthly, "2026-12")).toBeNull();
    expect(recurringInvoiceDateInMonth(bimonthly, "2027-01")).toBe("2027-01-10");
    // Months before the start keep the same parity.
    expect(recurringInvoiceDateInMonth(bimonthly, "2026-09")).toBe("2026-09-10");
    expect(recurringInvoiceDateInMonth(bimonthly, "2026-10")).toBeNull();
  });

  it("happens in the start month once a year (毎年)", () => {
    const yearly = schedule(31, { frequency: "yearly", startDate: "2027-02-01" });
    expect(recurringInvoiceDates(yearly, { after: "2026-12-31", through: "2029-12-31" })).toEqual([
      "2027-02-28",
      "2028-02-29",
      "2029-02-28",
    ]);
    expect(recurringInvoiceDateInMonth(yearly, "2027-03")).toBeNull();
  });

  it("stops after the end date (inclusive) and starts on the start date", () => {
    const ending = schedule(25, { startDate: "2026-11-25", endDate: "2027-01-25" });
    expect(recurringInvoiceDates(ending, { after: "2026-10-31", through: "2027-06-30" })).toEqual([
      "2026-11-25",
      "2026-12-25",
      "2027-01-25",
    ]);
    const late = schedule(25, { startDate: "2026-11-26" });
    expect(recurringInvoiceDates(late, { after: "2026-10-31", through: "2026-12-31" })).toEqual([
      "2026-12-25",
    ]);
  });
});

describe("nextRecurringInvoiceDates", () => {
  it("gives the next dates after a day (次回 3 回の予定日)", () => {
    expect(nextRecurringInvoiceDates(schedule(25), { after: "2026-11-25", count: 3 })).toEqual([
      "2026-12-25",
      "2027-01-25",
      "2027-02-25",
    ]);
    expect(nextRecurringInvoiceDates(schedule(25), { after: "2026-11-24", count: 1 })).toEqual([
      "2026-11-25",
    ]);
  });

  it("starts at the start date and ends at the end date", () => {
    const future = schedule(31, { startDate: "2027-03-01", endDate: "2027-04-30" });
    expect(nextRecurringInvoiceDates(future, { after: "2026-11-01", count: 3 })).toEqual([
      "2027-03-31",
      "2027-04-30",
    ]);
    const yearly = schedule(1, { frequency: "yearly", startDate: "2026-04-01" });
    expect(nextRecurringInvoiceDates(yearly, { after: "2026-11-01", count: 2 })).toEqual([
      "2027-04-01",
      "2028-04-01",
    ]);
    expect(nextRecurringInvoiceDates(yearly, { after: "2026-11-01", count: 0 })).toEqual([]);
  });
});

describe("the due date rule (支払期限)", () => {
  it("defaults to the end of the next month, like defaultDueDate", () => {
    expect(recurringInvoiceDueDate("2026-11-25", { dueMonths: 1, dueDay: 31 })).toBe("2026-12-31");
    expect(recurringInvoiceDueDate("2027-01-31", { dueMonths: 1, dueDay: 31 })).toBe("2027-02-28");
    expect(recurringInvoiceDueDate("2026-12-31", { dueMonths: 1, dueDay: 31 })).toBe("2027-01-31");
  });

  it("takes 0–3 months later and the day (末日 when the month is shorter)", () => {
    expect(recurringInvoiceDueDate("2026-11-10", { dueMonths: 0, dueDay: 31 })).toBe("2026-11-30");
    expect(recurringInvoiceDueDate("2026-11-10", { dueMonths: 2, dueDay: 10 })).toBe("2027-01-10");
    expect(recurringInvoiceDueDate("2026-11-30", { dueMonths: 3, dueDay: 30 })).toBe("2027-02-28");
  });

  it("refuses a rule that falls before the issue date in the same month", () => {
    expect(recurringInvoiceDueRuleProblem(25, { dueMonths: 0, dueDay: 10 })).toMatch(
      /支払期限が発行日より前/,
    );
    expect(recurringInvoiceDueRuleProblem(25, { dueMonths: 0, dueDay: 25 })).toBeNull();
    expect(recurringInvoiceDueRuleProblem(31, { dueMonths: 0, dueDay: 30 })).not.toBeNull();
    expect(recurringInvoiceDueRuleProblem(25, { dueMonths: 1, dueDay: 1 })).toBeNull();
  });

  it("describes the rule", () => {
    expect(describeRecurringInvoiceDueRule({ dueMonths: 1, dueDay: 31 })).toBe("翌月末");
    expect(describeRecurringInvoiceDueRule({ dueMonths: 1, dueDay: 10 })).toBe("翌月 10 日");
    expect(describeRecurringInvoiceDueRule({ dueMonths: 0, dueDay: 31 })).toBe("当月末");
    expect(describeRecurringInvoiceDueRule({ dueMonths: 2, dueDay: 5 })).toBe("翌々月 5 日");
    expect(describeRecurringInvoiceDueRule({ dueMonths: 3, dueDay: 31 })).toBe("3 か月後の末日");
  });
});

describe("対象月", () => {
  it("is the month of the issue date plus the offset", () => {
    expect(recurringInvoiceTargetMonth("2026-11-25", 0)).toBe("2026-11");
    expect(recurringInvoiceTargetMonth("2026-11-25", -1)).toBe("2026-10");
    expect(recurringInvoiceTargetMonth("2026-12-25", 1)).toBe("2027-01");
    expect(recurringInvoiceTargetMonth("2027-01-05", -1)).toBe("2026-12");
    expect(invoiceMonthLabel("2026-01")).toBe("2026年1月");
    expect(recurringInvoiceTargetOffsetLabel(-1)).toBe("前月分");
    expect(recurringInvoiceTargetOffsetLabel(0)).toBe("当月分");
    expect(recurringInvoiceTargetOffsetLabel(1)).toBe("翌月分");
  });

  it("replaces {対象月} in the text (full-width braces too)", () => {
    expect(expandTargetMonth("顧問料（{対象月}分）", "2026-11-25", 0)).toBe(
      "顧問料（2026年11月分）",
    );
    expect(expandTargetMonth("保守 {対象月}・{対象月}", "2026-12-25", 1)).toBe(
      "保守 2027年1月・2027年1月",
    );
    expect(expandTargetMonth("顧問料（｛対象月｝分）", "2026-11-25", -1)).toBe(
      "顧問料（2026年10月分）",
    );
    expect(expandTargetMonth("顧問料", "2026-11-25", 0)).toBe("顧問料");
    expect(hasTargetMonthPlaceholder("顧問料（{対象月}分）")).toBe(true);
    expect(hasTargetMonthPlaceholder("顧問料")).toBe(false);
    expect(hasTargetMonthPlaceholder(null)).toBe(false);
  });
});

describe("describeRecurringInvoiceSchedule", () => {
  it("says the frequency and the day (末日 for 31)", () => {
    expect(describeRecurringInvoiceSchedule(schedule(25))).toBe("毎月 25 日");
    expect(describeRecurringInvoiceSchedule(schedule(31, { frequency: "bimonthly" }))).toBe(
      "隔月 末日",
    );
    expect(
      describeRecurringInvoiceSchedule(
        schedule(31, { frequency: "yearly", startDate: "2027-03-01" }),
      ),
    ).toBe("毎年 3 月 31 日");
    expect(
      describeRecurringInvoiceSchedule(
        schedule(31, { frequency: "yearly", startDate: "2027-02-01" }),
      ),
    ).toBe("毎年 2 月 末日");
    expect(RECURRING_INVOICE_FREQUENCY_LABELS.bimonthly).toBe("隔月");
  });
});
