import { daysBetween } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  buildCashflowForecast,
  buildCashReport,
  CASHFLOW_DAYS,
  cashflowCsvRows,
  csvText,
  forecastStartDate,
  recurringCashEffect,
  recurringOccurrences,
  type CashflowInputs,
  type CashflowRecurringItem,
  type ReportSource,
} from "../src";
import { FY1, FY2 } from "./fixtures/book";
import {
  CF_BOOK,
  CF_END,
  CF_EXPECTED_ROWS,
  CF_EXPECTED_STEPS,
  CF_INPUTS,
  CF_RECURRING,
  CF_START,
  expandSteps,
} from "./fixtures/cashflow";

const forecastOf = (inputs: CashflowInputs = CF_INPUTS, source: ReportSource = CF_BOOK) =>
  buildCashflowForecast(source, inputs, { start: CF_START });

const monthly = (
  dayOfMonth: number,
  rest: Partial<CashflowRecurringItem> = {},
): Pick<
  CashflowRecurringItem,
  "frequency" | "dayOfMonth" | "monthOfYear" | "startDate" | "endDate"
> => ({
  frequency: "monthly",
  dayOfMonth,
  monthOfYear: null,
  startDate: "2026-01-01",
  endDate: null,
  ...rest,
});

const withoutItems = (...ids: string[]): CashflowInputs => ({
  ...CF_INPUTS,
  recurring: CF_RECURRING.filter((item) => !ids.includes(item.id)),
});

describe("recurringOccurrences", () => {
  it("puts 末日 on the last day of each month, 2/29 in a leap year", () => {
    expect(
      recurringOccurrences(monthly(31), { after: "2026-11-01", through: "2027-02-28" }),
    ).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
    expect(
      recurringOccurrences(monthly(30), { after: "2028-01-31", through: "2028-03-31" }),
    ).toEqual(["2028-02-29", "2028-03-30"]);
  });

  it("puts a yearly 2/29 on 2/28 in a common year", () => {
    const yearly = monthly(29, { frequency: "yearly", monthOfYear: 2 });
    expect(recurringOccurrences(yearly, { after: "2026-12-31", through: "2029-03-01" })).toEqual([
      "2027-02-28",
      "2028-02-29",
      "2029-02-28",
    ]);
    // A yearly item without its month never occurs (the repository rejects it).
    expect(
      recurringOccurrences(
        { ...yearly, monthOfYear: null },
        { after: "2026-12-31", through: "2029-03-01" },
      ),
    ).toEqual([]);
  });

  it("skips days before the start in the start's month (1/15 start, day 10 → 2/10)", () => {
    expect(
      recurringOccurrences(monthly(10, { startDate: "2027-01-15" }), {
        after: "2027-01-01",
        through: "2027-03-31",
      }),
    ).toEqual(["2027-02-10", "2027-03-10"]);
  });

  it("excludes `after`, includes `through` and the end date, stops after the end date", () => {
    expect(
      recurringOccurrences(monthly(1, { endDate: "2027-02-01" }), {
        after: "2026-12-01",
        through: "2027-03-01",
      }),
    ).toEqual(["2027-01-01", "2027-02-01"]);
    expect(
      recurringOccurrences(monthly(1), { after: "2026-12-01", through: "2026-12-01" }),
    ).toEqual([]);
  });
});

describe("recurringCashEffect", () => {
  const effect = (id: string) =>
    recurringCashEffect(
      CF_RECURRING.find((item) => item.id === id)!,
      CF_BOOK,
    );

  it("counts only the cash-like side of the entry 「口座の科目 ⇄ 科目」 (§3.2)", () => {
    expect(effect("r:rent")).toBe(-110_000n);
    expect(effect("r:maintenance")).toBe(200_000n);
    expect(effect("r:gcp")).toBe(0n); // card payment: the debt grows
    expect(effect("r:card")).toBe(-40_000n); // the card's withdrawal from the bank
    expect(effect("r:payout")).toBe(0n); // Stripe → bank inside 現預金
  });

  it("works the other way round: the card as the wallet, the bank as the account", () => {
    expect(
      recurringCashEffect({ amount: 40_000n, walletId: "w:card", accountId: "acc:1100" }, CF_BOOK),
    ).toBe(-40_000n);
  });

  it("is null without a wallet", () => {
    expect(
      recurringCashEffect({ amount: -1_000n, walletId: null, accountId: "acc:5300" }, CF_BOOK),
    ).toBeNull();
  });
});

describe("forecastStartDate", () => {
  it("is today, or the first day of the books before they start", () => {
    expect(forecastStartDate([FY1, FY2], "2027-01-15")).toBe("2027-01-15");
    expect(forecastStartDate([FY1, FY2], "2026-10-28")).toBe(FY1.startDate);
    expect(forecastStartDate([FY1, FY2], "2028-05-01")).toBe("2028-05-01");
    expect(forecastStartDate([], "2026-10-28")).toBe("2026-10-28");
  });
});

describe("buildCashflowForecast", () => {
  const forecast = forecastOf();

  it("runs from the start to 90 days later (91 points)", () => {
    expect(forecast.start).toBe(CF_START);
    expect(forecast.end).toBe(CF_END);
    expect(forecast.dates).toHaveLength(CASHFLOW_DAYS + 1);
    expect(forecast.dates[0]).toBe(CF_START);
    expect(forecast.dates[CASHFLOW_DAYS]).toBe(CF_END);
  });

  it("starts from the cash of the book on the start day, like the cash tab and the home", () => {
    const cash = buildCashReport(CF_BOOK, {
      fiscalYear: FY1,
      preset: "custom",
      from: FY1.startDate,
      to: CF_START,
      segmentId: null,
    });
    expect(forecast.opening.total).toBe(975_000n);
    expect(forecast.opening.total).toBe(cash.total);
    expect(forecast.opening.wallets.map((w) => [w.walletId, w.balance])).toEqual(
      cash.wallets.map((w) => [w.walletId, w.balance]),
    );
    expect(forecast.opening.wallets.map((w) => [w.name, w.balance])).toEqual([
      ["架空銀行 普通", 920_000n],
      ["Stripe 架空", 55_000n],
    ]);
    expect(forecast.opening.unassigned).toEqual([]);
    expect(forecast.balances[0]).toBe(975_000n);
  });

  it("shows cash no active wallet owns in the opening", () => {
    const noStripe = forecastOf(CF_INPUTS, {
      ...CF_BOOK,
      wallets: CF_BOOK.wallets.filter((w) => w.kind !== "stripe"),
    });
    expect(noStripe.opening.total).toBe(975_000n);
    expect(noStripe.opening.unassigned.map((u) => [u.accountName, u.balance])).toEqual([
      ["Stripe 残高", 55_000n],
    ]);
  });

  it("matches the hand-computed daily balances", () => {
    expect(forecast.balances).toEqual(expandSteps(CF_EXPECTED_STEPS, CASHFLOW_DAYS));
  });

  it("lists the rows in the order of §6 with the running balance", () => {
    expect(forecast.events.map((e) => [e.date, e.kind, e.label, e.amount, e.balance])).toEqual(
      CF_EXPECTED_ROWS,
    );
    const entry = forecast.events.find((e) => e.kind === "entry")!;
    expect(entry.entryNo).toBe(6);
    expect(forecast.events.find((e) => e.kind === "recurring")!.walletName).toBe("架空銀行 普通");
  });

  it("ends each day of the line on the balance of that day's last row", () => {
    for (const event of forecast.events) {
      if (event.balance === null) continue;
      const sameDay = forecast.events.filter(
        (other) => other.date === event.date && other.balance !== null,
      );
      if (sameDay[sameDay.length - 1] !== event) continue;
      expect(forecast.balances[daysBetween(CF_START, event.date)]).toBe(event.balance);
    }
  });

  it("gives the lowest day, the first day below 0 and the 90th day", () => {
    expect(forecast.lowest).toEqual({ date: "2027-02-28", balance: -328_000n });
    expect(forecast.firstNegative).toEqual({ date: "2027-01-31", balance: -25_000n });
    expect(forecast.final).toEqual({ date: CF_END, balance: -128_000n });
  });

  it("does not count the start day, inactive items, or days after the end date", () => {
    const labels = forecast.events.map((e) => `${e.date} ${e.label}`);
    expect(labels).not.toContain("2026-12-01 保守の売上");
    expect(labels).not.toContain("2027-02-10 カードの引落し");
    expect(labels).not.toContain("2027-01-15 顧問料");
    expect(labels.some((label) => label.includes("旧オフィスの家賃"))).toBe(false);
    // Cash-neutral rows, the voided pair and entries after the end are left out.
    expect(labels.some((label) => /GCP|Stripe|誤登録|受託の残金/.test(label))).toBe(false);
  });

  it("drops an item from the line when it is deactivated or ends", () => {
    const deactivated = forecastOf({
      ...CF_INPUTS,
      recurring: CF_RECURRING.map((item) =>
        item.id === "r:salary" ? { ...item, isActive: false } : item,
      ),
    });
    // 3 × 300,000 fewer outflows.
    expect(deactivated.final.balance).toBe(-128_000n + 900_000n);
    const ended = forecastOf({
      ...CF_INPUTS,
      recurring: CF_RECURRING.map((item) =>
        item.id === "r:salary" ? { ...item, endDate: "2027-01-24" } : item,
      ),
    });
    // Only 12/25 is left.
    expect(ended.final.balance).toBe(-128_000n + 600_000n);
  });

  it("marks deadlines without an amount and does not move the line for them", () => {
    expect(forecast.marks).toEqual([{ date: "2027-02-28", title: "法人税等の中間申告・納付" }]);
    expect(forecast.balances[89]).toBe(-328_000n);
  });

  it("does not count exactly 0 as below 0", () => {
    // 社会保険料 65,000 instead of 90,000: 1/31 ends at exactly 0; the first day below is 2/25.
    const zero = forecastOf({
      ...CF_INPUTS,
      deadlines: [
        { date: "2027-01-10", title: "源泉所得税の納付", amount: 45_000n },
        { date: "2027-01-31", title: "社会保険料の納付", amount: 65_000n },
        { date: "2027-02-28", title: "法人税等の中間申告・納付", amount: null },
      ],
    });
    expect(zero.balances[61]).toBe(0n);
    expect(zero.firstNegative).toEqual({ date: "2027-02-25", balance: -133_000n });
  });

  it("notes what is not in the line (§3.1)", () => {
    expect(forecast.notes).toEqual([
      { kind: "deadlinesWithoutAmount", count: 1 },
      { kind: "receivablesNotConnected" },
      { kind: "payablesNotConnected" },
      { kind: "recurringWithoutCashEffect", count: 2 },
    ]);
    expect(forecast.activeRecurringCount).toBe(8);
  });

  it("notes a card's debt when no recurring item pays it", () => {
    const noWithdrawal = forecastOf(withoutItems("r:card"));
    expect(noWithdrawal.notes).toContainEqual({
      kind: "cardUnpaid",
      walletId: "w:card",
      walletName: "架空カード",
      amount: 33_000n,
    });
    // A withdrawal that ended before the period does not pay it either.
    const ended = forecastOf({
      ...CF_INPUTS,
      recurring: CF_RECURRING.map((item) =>
        item.id === "r:card" ? { ...item, endDate: "2026-11-30" } : item,
      ),
    });
    expect(ended.notes.some((note) => note.kind === "cardUnpaid")).toBe(true);
    expect(forecast.notes.some((note) => note.kind === "cardUnpaid")).toBe(false);
  });

  it("notes items without a wallet", () => {
    const withoutWallet = forecastOf({
      ...CF_INPUTS,
      recurring: [
        ...CF_RECURRING,
        {
          id: "r:no-wallet",
          name: "口座のない定期取引",
          amount: -1_000n,
          frequency: "monthly",
          dayOfMonth: 20,
          monthOfYear: null,
          startDate: "2026-11-01",
          endDate: null,
          walletId: null,
          accountId: "acc:5490",
          isActive: true,
        },
      ],
    });
    expect(withoutWallet.notes).toContainEqual({ kind: "recurringWithoutWallet", count: 1 });
    expect(withoutWallet.final.balance).toBe(forecast.final.balance);
  });

  it("notes inputs that are not connected and the lack of recurring items", () => {
    const bare = forecastOf({ recurring: [], deadlines: null, receivables: null, payables: null });
    expect(bare.notes).toEqual([
      { kind: "noRecurring" },
      { kind: "deadlinesNotConnected" },
      { kind: "receivablesNotConnected" },
      { kind: "payablesNotConnected" },
      { kind: "cardUnpaid", walletId: "w:card", walletName: "架空カード", amount: 33_000n },
    ]);
    // Connected but empty inputs are not noted.
    const empty = forecastOf({
      recurring: CF_RECURRING,
      deadlines: [],
      receivables: [],
      payables: [],
    });
    expect(empty.notes).toEqual([{ kind: "recurringWithoutCashEffect", count: 2 }]);
  });

  it("puts invoices on their due dates, past-due payables on the next day", () => {
    const invoices = forecastOf({
      recurring: [],
      deadlines: [],
      receivables: [
        { date: "2027-01-20", amount: 100_000n, label: "請求 0001 架空デザイン合同会社" },
        { date: "2026-11-30", amount: 50_000n, label: "請求 0000 架空デザイン合同会社" },
        { date: CF_START, amount: 7_000n, label: "請求 0002 架空デザイン合同会社" },
        { date: null, amount: 20_000n, label: "請求 0003 架空デザイン合同会社" },
        { date: "2027-03-02", amount: 1_000n, label: "請求 0004 架空デザイン合同会社" },
      ],
      payables: [
        { date: "2026-11-28", amount: 10_000n, label: "架空クラウド株式会社" },
        { date: "2027-02-01", amount: 5_000n, label: "架空不動産株式会社" },
      ],
    });
    // 975,000 − 10,000 (past due → 12/02) − 165,000 (No.6) + 100,000 − 5,000.
    expect(invoices.events.map((e) => [e.date, e.kind, e.amount, e.balance])).toEqual([
      ["2026-12-02", "payable", -10_000n, 965_000n],
      ["2026-12-18", "entry", -165_000n, 800_000n],
      ["2027-01-20", "receivable", 100_000n, 900_000n],
      ["2027-02-01", "payable", -5_000n, 895_000n],
    ]);
    expect(invoices.notes).toEqual([
      { kind: "noRecurring" },
      { kind: "receivablesOverdue", count: 2, amount: 57_000n },
      { kind: "receivablesWithoutDate", count: 1, amount: 20_000n },
      { kind: "cardUnpaid", walletId: "w:card", walletName: "架空カード", amount: 33_000n },
    ]);
  });

  it("draws a flat line for a book with nothing in it", () => {
    const empty = buildCashflowForecast(
      { ...CF_BOOK, entries: [] },
      { recurring: [], deadlines: null, receivables: null, payables: null },
      { start: CF_START },
    );
    expect(empty.balances).toEqual(Array.from({ length: CASHFLOW_DAYS + 1 }, () => 0n));
    expect(empty.events).toEqual([]);
    expect(empty.lowest).toEqual({ date: CF_START, balance: 0n });
    expect(empty.firstNegative).toBeNull();
    expect(empty.final).toEqual({ date: CF_END, balance: 0n });
    expect(empty.notes.map((note) => note.kind)).toEqual([
      "noRecurring",
      "deadlinesNotConnected",
      "receivablesNotConnected",
      "payablesNotConnected",
    ]);
  });
});

describe("cashflowCsvRows", () => {
  const rows = cashflowCsvRows(forecastOf());

  it("starts with the header and the start row", () => {
    expect(rows[0]).toEqual(["日付", "内容", "種類", "口座", "入出金", "残高"]);
    expect(rows[1]).toEqual(["2026/12/01", "今日の現預金", "", "", null, 975_000n]);
    expect(rows).toHaveLength(2 + CF_EXPECTED_ROWS.length);
  });

  it("writes each row with its kind, wallet, amount and balance", () => {
    expect(rows[2]).toEqual([
      "2026/12/10",
      "カードの引落し",
      "定期取引",
      "架空銀行 普通",
      -40_000n,
      935_000n,
    ]);
    expect(rows[3]).toEqual(["2026/12/18", "No. 6 PC の購入", "取引", "", -165_000n, 770_000n]);
    expect(rows[8]).toEqual(["2027/01/10", "源泉所得税の納付", "納付", "", -45_000n, 475_000n]);
  });

  it("leaves 入出金 and 残高 empty while an amount is unknown", () => {
    const text = csvText(rows);
    expect(text).toContain("2027/02/28,法人税等の中間申告・納付,納付,,,\r\n");
    expect(text).toContain("2027/03/01,保守の売上,定期取引,架空銀行 普通,200000,-128000\r\n");
  });
});
