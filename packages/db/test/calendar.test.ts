import type { CalendarDate } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  buildCalendarItems,
  CALENDAR_RULES,
  selectCalendarNotices,
  type BuiltCalendarItem,
  type CalendarNoticeItem,
} from "../src/calendar";

function dueDates(items: BuiltCalendarItem[]): Record<string, CalendarDate> {
  return Object.fromEntries(items.map((item) => [item.ruleKey, item.dueDate]));
}

function build(
  foundedOn: CalendarDate,
  fiscalYear: { no: number; startDate: CalendarDate; endDate: CalendarDate },
): Record<string, CalendarDate> {
  return dueDates(
    buildCalendarItems({ company: { foundedOn }, fiscalYear: { id: "fy", ...fiscalYear } }),
  );
}

describe("calendar rules", () => {
  it("have unique keys", () => {
    const keys = CALENDAR_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("give the founding filings and the annual deadlines of 第 1 期 (founded 2026-11-10)", () => {
    const due = build("2026-11-10", { no: 1, startDate: "2026-11-10", endDate: "2027-03-31" });
    expect(due).toEqual({
      "founding.establishment-notice-tax-office": "2027-01-10",
      "founding.blue-return-application": "2027-02-09",
      "founding.salary-office-notice": "2026-12-10",
      "founding.withholding-special-application": "2026-12-10",
      "founding.social-insurance-application": "2026-11-15",
      "founding.local-notice-city": "2026-12-10",
      "founding.local-notice-prefecture": "2027-01-10",
      "founding.prescheduled-salary-notice": "2027-01-10",
      "founding.invoice-registration": "2027-03-31",
      "founding.simplified-tax-election": "2027-03-31",
      "founding.depreciation-method-notice": "2027-05-31",
      "annual.tax-return": "2027-05-31",
      "annual.shareholders-meeting": "2027-06-30",
      "annual.withholding-special-jan": "2027-01-20",
      "annual.legal-records": "2027-01-31",
    });
    // No 7/10 inside 2026-11-10..2027-03-31, and no interim return in the first year.
    expect(due["annual.withholding-special-jul"]).toBeUndefined();
    expect(due["annual.interim-return"]).toBeUndefined();
  });

  it("give only the annual deadlines from 第 2 期", () => {
    const due = build("2026-11-10", { no: 2, startDate: "2027-04-01", endDate: "2028-03-31" });
    expect(Object.keys(due).filter((key) => key.startsWith("founding."))).toEqual([]);
    expect(due).toEqual({
      "annual.tax-return": "2028-05-31",
      "annual.shareholders-meeting": "2028-06-30",
      "annual.withholding-special-jan": "2028-01-20",
      "annual.legal-records": "2028-01-31",
      "annual.withholding-special-jul": "2027-07-10",
      "annual.interim-return": "2027-11-30",
    });
  });

  it("round month additions down to the end of a shorter month", () => {
    const due = build("2026-11-30", { no: 1, startDate: "2026-11-30", endDate: "2027-03-31" });
    // 2026-11-30 + 3 months = 2027-02-28 (no 02-30); the day before is 02-27.
    expect(due["founding.blue-return-application"]).toBe("2027-02-27");
    expect(due["founding.establishment-notice-tax-office"]).toBe("2027-01-30");
    expect(due["founding.salary-office-notice"]).toBe("2026-12-30");
  });

  it("take the day before the end of 第 1 期 when it comes before founding + 3 months", () => {
    const due = build("2027-01-15", { no: 1, startDate: "2027-01-15", endDate: "2027-03-31" });
    expect(due["founding.blue-return-application"]).toBe("2027-03-30");
    // 1/20 and 1/31 fall inside the short first year.
    expect(due["annual.withholding-special-jan"]).toBe("2027-01-20");
    expect(due["annual.legal-records"]).toBe("2027-01-31");
  });

  it("carry the kind, title and note of the rule", () => {
    const items = buildCalendarItems({
      company: { foundedOn: "2026-11-10" },
      fiscalYear: { id: "fy", no: 2, startDate: "2027-04-01", endDate: "2028-03-31" },
    });
    expect(items.find((item) => item.ruleKey === "annual.shareholders-meeting")).toEqual({
      ruleKey: "annual.shareholders-meeting",
      kind: "meeting",
      title: "定時株主総会・決算公告（自社）",
      dueDate: "2028-06-30",
      note: null,
    });
    expect(items.find((item) => item.ruleKey === "annual.withholding-special-jul")?.kind).toBe(
      "payment",
    );
    expect(items.find((item) => item.ruleKey === "annual.interim-return")?.note).toBe(
      "前期の税額が一定額を超えた場合",
    );
  });
});

function item(
  id: string,
  dueDate: CalendarDate,
  options: { lastNotifiedOn?: CalendarDate; completed?: boolean } = {},
): CalendarNoticeItem {
  return {
    id,
    dueDate,
    completedAt: options.completed ? new Date("2026-11-01T00:00:00Z") : null,
    lastNotifiedOn: options.lastNotifiedOn ?? null,
    title: `title ${id}`,
    note: null,
    kind: "filing",
  };
}

function stages(items: CalendarNoticeItem[], today: CalendarDate): Record<string, string> {
  return Object.fromEntries(
    selectCalendarNotices(items, today).map((notice) => [notice.item.id, notice.stage]),
  );
}

describe("selectCalendarNotices", () => {
  const due: CalendarDate = "2026-12-10";

  it("says nothing until 7 days before the due date", () => {
    expect(stages([item("a", due)], "2026-12-02")).toEqual({});
  });

  it("mails once within 7 days, then again on the due date", () => {
    expect(stages([item("a", due)], "2026-12-03")).toEqual({ a: "week" });
    expect(stages([item("a", due)], "2026-12-09")).toEqual({ a: "week" });
    // Already mailed inside the 7-day window: quiet until the due date.
    expect(stages([item("a", due, { lastNotifiedOn: "2026-12-03" })], "2026-12-05")).toEqual({});
    expect(stages([item("a", due, { lastNotifiedOn: "2026-12-03" })], due)).toEqual({
      a: "today",
    });
    // A mail sent before the window (an earlier due date) does not count.
    expect(stages([item("a", due, { lastNotifiedOn: "2026-12-02" })], "2026-12-04")).toEqual({
      a: "week",
    });
  });

  it("mails an overdue item once when the due-date mail never went out", () => {
    expect(stages([item("a", due)], "2026-12-11")).toEqual({ a: "overdue" });
    expect(stages([item("a", due, { lastNotifiedOn: "2026-12-05" })], "2026-12-20")).toEqual({
      a: "overdue",
    });
    expect(stages([item("a", due, { lastNotifiedOn: due })], "2026-12-11")).toEqual({});
    expect(stages([item("a", due, { lastNotifiedOn: "2026-12-11" })], "2026-12-12")).toEqual({});
    expect(stages([item("a", due, { lastNotifiedOn: due })], due)).toEqual({});
  });

  it("skips completed items and sorts by due date", () => {
    const notices = selectCalendarNotices(
      [
        item("late", "2026-12-15"),
        item("done", "2026-12-10", { completed: true }),
        item("early", "2026-12-01"),
        item("today", "2026-12-10"),
      ],
      "2026-12-10",
    );
    expect(notices.map((notice) => [notice.item.id, notice.stage])).toEqual([
      ["early", "overdue"],
      ["today", "today"],
      ["late", "week"],
    ]);
  });
});
