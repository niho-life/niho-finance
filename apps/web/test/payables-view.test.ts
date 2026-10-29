import { payablesFilterSchema } from "@niho-finance/db";
import { describe, expect, it } from "vitest";
import {
  differenceText,
  payableDetailHref,
  payableName,
  payablesListHref,
  payablesQuery,
  payableStatusParts,
  paymentOutcome,
  paymentTermsHelp,
} from "../app/(app)/payables/_lib/view";

/** 支払の画面 (25 §6, §7): the list's URL, the state, the difference and the terms as owners read them. */
describe("payables view", () => {
  it("keeps only the filters that differ from the defaults", () => {
    expect(payablesQuery(payablesFilterSchema.parse({}))).toBe("");
    const filters = payablesFilterSchema.parse({
      status: "all",
      partner: "par_test",
      view: "partner",
      q: "外注",
      page: "2",
    });
    const query = payablesQuery(filters);
    expect(query).toBe("status=all&partner=par_test&view=partner&q=%E5%A4%96%E6%B3%A8&page=2");
    expect(payablesQuery({ ...filters, page: 1, view: "due", status: "open" })).toBe(
      "partner=par_test&q=%E5%A4%96%E6%B3%A8",
    );
    // Unknown values fall back to the defaults (the URL is typed by hand).
    expect(payablesFilterSchema.parse({ status: "void", view: "x" })).toMatchObject({
      status: "open",
      view: "due",
    });
  });

  it("goes back to the list it came from, its own parameters only", () => {
    expect(payablesListHref(undefined)).toBe("/payables");
    expect(payablesListHref("status=paid&evil=1&page=3")).toBe("/payables?status=paid&page=3");
    expect(payableDetailHref("doc_1", "")).toBe("/payables/doc_1");
    expect(payableDetailHref("doc_1", "status=paid")).toBe("/payables/doc_1?list=status%3Dpaid");
    expect(payableName("テスト外注株式会社")).toBe("テスト外注株式会社 の請求書");
  });

  it("says the state: overdue in warn, then 一部支払 / 支払済み / 取消, 未払 alone", () => {
    expect(payableStatusParts({ state: "unpaid", overdue: false, overdueDays: 0 })).toEqual([
      { text: "未払", tone: "plain" },
    ]);
    expect(payableStatusParts({ state: "unpaid", overdue: true, overdueDays: 3 })).toEqual([
      { text: "期限超過（3 日）", tone: "warn" },
    ]);
    expect(payableStatusParts({ state: "partial", overdue: true, overdueDays: 1 })).toEqual([
      { text: "期限超過（1 日）", tone: "warn" },
      { text: "一部支払", tone: "plain" },
    ]);
    expect(payableStatusParts({ state: "paid", overdue: false, overdueDays: 0 })[0]?.text).toBe(
      "支払済み",
    );
    expect(
      payableStatusParts({ state: "cancelled", overdue: false, overdueDays: 0 })[0]?.text,
    ).toBe("取消");
  });

  it("says what happens to the difference before sending", () => {
    expect(paymentOutcome(null, 110_000n).text).toBeNull();
    expect(paymentOutcome(110_660n, 110_000n)).toMatchObject({
      applied: 110_000n,
      fee: 660n,
      remainingAfter: 0n,
      text: "差額 660 円は振込手数料（支払手数料）にします。支払後の残りは 0 円です",
    });
    expect(paymentOutcome(50_000n, 110_000n).text).toBe(
      "一部支払です。支払後の残りは 60,000 円です",
    );
    expect(paymentOutcome(110_000n, 110_000n).text).toBe("支払後の残りは 0 円です（支払済み）");
    expect(paymentOutcome(112_000n, 110_000n).problem).toMatch("1,100 円まで");
    expect(differenceText(110_000n, 110_000n)).toBe("一致");
    expect(differenceText(110_660n, 110_000n)).toBe("手数料 660");
    expect(differenceText(112_000n, 110_000n)).toBe("超過 2,000");
    expect(differenceText(100_000n, 110_000n)).toBe("一部 残り 10,000");
  });

  it("explains the default due date by the partner's terms", () => {
    expect(paymentTermsHelp({ closingDay: 20, dueMonths: 1, dueDay: 10 })).toBe(
      "支払条件: 20 日締め翌月 10 日払い",
    );
    expect(paymentTermsHelp(null)).toMatch("取引先の支払条件を入れると既定になります");
  });
});
