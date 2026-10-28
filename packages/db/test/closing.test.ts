import { describe, expect, it } from "vitest";
import {
  auditLogFilterSchema,
  closeRange,
  entriesFilterSchema,
  isCloseDate,
  listCloseOptions,
  simpleEntrySchema,
} from "../src";

const year = { startDate: "2026-11-02", endDate: "2027-03-31", lockedThrough: null } as const;

describe("listCloseOptions (11 §7)", () => {
  it("offers the month ends from the first month up to the end of today's month", () => {
    expect(listCloseOptions(year, "2027-01-15")).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
    ]);
    expect(listCloseOptions(year, "2027-06-01")).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    // Before the year's first month ends there is nothing to close yet.
    expect(listCloseOptions(year, "2026-10-28")).toEqual([]);
  });

  it("ends on the year's last day, handles leap years and keeps the current close", () => {
    expect(
      listCloseOptions(
        { startDate: "2028-01-01", endDate: "2028-03-15", lockedThrough: null },
        "2029-01-01",
      ),
    ).toEqual(["2028-01-31", "2028-02-29", "2028-03-15"]);
    expect(listCloseOptions({ ...year, lockedThrough: "2027-02-28" }, "2026-12-10")).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-02-28",
    ]);
  });
});

describe("isCloseDate / closeRange", () => {
  it("accepts month ends inside the year and its last day", () => {
    expect(isCloseDate("2026-11-30", year)).toBe(true);
    expect(isCloseDate("2027-03-31", year)).toBe(true);
    expect(isCloseDate("2026-11-15", year)).toBe(false);
    expect(isCloseDate("2026-10-31", year)).toBe(false);
    expect(isCloseDate("2027-04-30", year)).toBe(false);
    const midMonth = {
      startDate: "2027-04-01",
      endDate: "2027-05-15",
      lockedThrough: null,
    } as const;
    expect(isCloseDate("2027-05-15", midMonth)).toBe(true);
  });

  it("tells the dates that become read-only or open again", () => {
    expect(closeRange(year, "2026-12-31")).toEqual({
      direction: "close",
      from: "2026-11-02",
      to: "2026-12-31",
    });
    const closed = { ...year, lockedThrough: "2026-12-31" } as const;
    expect(closeRange(closed, "2027-01-31")).toEqual({
      direction: "close",
      from: "2027-01-01",
      to: "2027-01-31",
    });
    expect(closeRange(closed, "2026-11-30")).toEqual({
      direction: "reopen",
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(closeRange(closed, null)).toEqual({
      direction: "reopen",
      from: "2026-11-02",
      to: "2026-12-31",
    });
    expect(closeRange(closed, "2026-12-31")).toBeNull();
    expect(closeRange(year, null)).toBeNull();
  });
});

describe("transaction schemas", () => {
  it("parse 収入・支出・振替 from form values", () => {
    expect(
      simpleEntrySchema.parse({
        type: "expense",
        entryDate: "2026-11-05",
        description: " クラウド利用料 ",
        counterpart: "wallet:w_card",
        accountId: "acc_5320",
        amount: "１,１００",
        taxCategoryCode: "purchase_10",
        segmentId: "",
        partnerId: "",
        memoTagIds: ["tag_1", "tag_1"],
      }),
    ).toEqual({
      type: "expense",
      entryDate: "2026-11-05",
      description: "クラウド利用料",
      counterpart: { kind: "wallet", walletId: "w_card" },
      accountId: "acc_5320",
      amount: 1_100n,
      taxCategoryCode: "purchase_10",
      segmentId: null,
      partnerId: null,
      memoTagIds: ["tag_1"],
    });
    const transfer = simpleEntrySchema.parse({
      type: "transfer",
      entryDate: "2026-11-30",
      description: "振替",
      fromWalletId: "w_bank",
      toWalletId: "w_cash",
      amount: "10,000",
      fee: "0",
    });
    expect(transfer).toMatchObject({ fee: null, memoTagIds: [] });
    const bad = simpleEntrySchema.safeParse({
      type: "income",
      entryDate: "2026-11-30",
      description: "",
      counterpart: "bank",
      accountId: "",
      amount: "0",
      taxCategoryCode: "sales_99",
    });
    expect(bad.success).toBe(false);
    expect(
      Object.fromEntries(
        (bad.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]),
      ),
    ).toEqual({
      description: "摘要を入力してください",
      counterpart: "入金先が正しくありません",
      accountId: "科目を選んでください",
      amount: "金額は 1 円以上にしてください",
      taxCategoryCode: "税区分が正しくありません",
    });
  });

  it("read the list filters from the URL leniently", () => {
    expect(entriesFilterSchema.parse({})).toEqual({
      from: null,
      to: null,
      account: null,
      partner: null,
      segment: null,
      tag: null,
      status: "posted",
      q: null,
      page: 1,
    });
    expect(
      entriesFilterSchema.parse({
        from: "2026-11-01",
        to: "2026-13-01",
        status: ["voided", "all"],
        q: "  家賃 ",
        page: "3",
        account: "",
      }),
    ).toMatchObject({
      from: "2026-11-01",
      to: null,
      status: "voided",
      q: "家賃",
      page: 3,
      account: null,
    });
    expect(entriesFilterSchema.parse({ status: "bogus", page: "-1" })).toMatchObject({
      status: "posted",
      page: 1,
    });
    expect(auditLogFilterSchema.parse({ entity: "journal_entry", page: "x" })).toEqual({
      entity: "journal_entry",
      from: null,
      to: null,
      page: 1,
    });
    expect(auditLogFilterSchema.parse({ entity: "bogus" }).entity).toBeNull();
  });
});
