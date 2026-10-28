import { describe, expect, it } from "vitest";
import { convertBalanceTransaction, STRIPE_CATEGORY_LABELS } from "../src/stripe/convert";
import { fetchBalanceTransactions, parseSyncCursor } from "../src/stripe/fetch";
import type { BalanceTransactionSource, StripeBalanceTransaction } from "../src/stripe/types";
import { FakeBalanceTransactionSource } from "./support/fake-source";
import { stripeFixture } from "./support/fixtures";

const platform = stripeFixture("platform");
const kamakura = stripeFixture("kamakura");

function transaction(id: string): StripeBalanceTransaction {
  const found = [...platform, ...kamakura].find((bt) => bt.id === id);
  if (!found) throw new Error(`fixture ${id} is missing`);
  return found;
}

describe("convertBalanceTransaction (12-imports §4.3)", () => {
  it("splits a charge into the gross line and the fee line, keeping fee_details with the tax", () => {
    const bt = transaction("txn_test_pf_01");
    expect(convertBalanceTransaction(bt)).toEqual({
      failure: null,
      rows: [
        {
          externalId: "txn_test_pf_01",
          txnDate: "2026-11-02",
          valueDate: "2026-11-09",
          occurredAt: new Date("2026-11-02T01:00:00Z"),
          amount: 10000n,
          descriptionRaw: "決済",
          counterpartyRaw: null,
          balanceAfter: null,
          category: "charge",
          raw: bt,
        },
        {
          externalId: "txn_test_pf_01:fee",
          txnDate: "2026-11-02",
          valueDate: "2026-11-09",
          occurredAt: new Date("2026-11-02T01:00:00Z"),
          amount: -360n,
          descriptionRaw: "手数料 · 決済",
          counterpartyRaw: null,
          balanceAfter: null,
          category: "fee",
          raw: {
            balanceTransactionId: "txn_test_pf_01",
            feeDetails: [
              {
                amount: 327,
                application: null,
                currency: "jpy",
                description: "Stripe processing fees",
                type: "stripe_fee",
              },
              { amount: 33, application: null, currency: "jpy", description: "JCT", type: "tax" },
            ],
          },
        },
      ],
    });
  });

  it("adds the description after the category name, on both lines", () => {
    const { rows } = convertBalanceTransaction(transaction("txn_test_pf_02"));
    expect(rows.map((row) => [row.externalId, row.amount, row.descriptionRaw])).toEqual([
      ["txn_test_pf_02", 5500n, "決済 予約 テストルーム 2 泊"],
      ["txn_test_pf_02:fee", -198n, "手数料 · 決済 予約 テストルーム 2 泊"],
    ]);
  });

  it("turns a refunded fee (a negative fee) into an incoming fee line", () => {
    const { rows } = convertBalanceTransaction(transaction("txn_test_pf_03"));
    expect(
      rows.map((row) => [row.externalId, row.amount, row.category, row.descriptionRaw]),
    ).toEqual([
      ["txn_test_pf_03", -5500n, "refund", "返金 REFUND FOR CHARGE (予約 テストルーム 2 泊)"],
      [
        "txn_test_pf_03:fee",
        198n,
        "fee",
        "手数料 · 返金 REFUND FOR CHARGE (予約 テストルーム 2 泊)",
      ],
    ]);
  });

  it.each([
    ["txn_test_pf_04", 1200n, "platform_earning", "プラットフォーム手数料"],
    ["txn_test_pf_05", -1100n, "fee", "手数料 Billing - Usage Fee (2026-10-01 - 2026-10-31)"],
    ["txn_test_pf_06", -3000n, "transfer", "振替"],
    ["txn_test_pf_09", -50000n, "payout", "入金（銀行へ） STRIPE PAYOUT"],
    ["txn_test_km_04", -20000n, "payout", "入金（銀行へ） STRIPE PAYOUT"],
  ])("makes one line for %s, which has no fee", (id, amount, category, descriptionRaw) => {
    const { rows, failure } = convertBalanceTransaction(transaction(id));
    expect(failure).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: id, amount, category, descriptionRaw });
  });

  it("keeps a dispute's fee as its own line", () => {
    const { rows } = convertBalanceTransaction(transaction("txn_test_km_03"));
    expect(rows.map((row) => [row.externalId, row.amount, row.descriptionRaw])).toEqual([
      ["txn_test_km_03", -22000n, "チャージバック Chargeback withdrawal for ch_test_km_02"],
      [
        "txn_test_km_03:fee",
        -1500n,
        "手数料 · チャージバック Chargeback withdrawal for ch_test_km_02",
      ],
    ]);
  });

  it("makes only the fee line when the gross amount is zero", () => {
    const bt = { ...transaction("txn_test_pf_06"), amount: 0, fee: 50, net: -50 };
    const { rows } = convertBalanceTransaction(bt);
    expect(rows.map((row) => [row.externalId, row.amount, row.descriptionRaw])).toEqual([
      ["txn_test_pf_06:fee", -50n, "手数料 · 振替"],
    ]);
  });

  it("skips a transaction with neither an amount nor a fee", () => {
    expect(convertBalanceTransaction(transaction("txn_test_pf_07"))).toEqual({
      rows: [],
      failure: null,
    });
  });

  it("fails a transaction in another currency", () => {
    expect(convertBalanceTransaction(transaction("txn_test_pf_08"))).toEqual({
      rows: [],
      failure: { rowNumber: 0, reason: "通貨が円ではありません（usd）" },
    });
  });

  it("fails an amount that is not a whole number", () => {
    const bt = { ...transaction("txn_test_pf_02"), amount: 5500.5 };
    expect(convertBalanceTransaction(bt).failure).toEqual({
      rowNumber: 0,
      reason: "金額が読めません",
    });
  });

  it("fails a time that is not a whole number of seconds", () => {
    const bt = { ...transaction("txn_test_pf_02"), created: Number.NaN };
    expect(convertBalanceTransaction(bt).failure).toEqual({
      rowNumber: 0,
      reason: "日付が読めません",
    });
  });

  it("dates by the JST calendar day of created and keeps the UTC time", () => {
    const bt = transaction("txn_test_pf_10");
    const { rows } = convertBalanceTransaction(bt);
    expect(rows.map((row) => [row.txnDate, row.valueDate, row.occurredAt?.toISOString()])).toEqual([
      ["2026-12-01", "2026-12-07", "2026-11-30T15:30:00.000Z"],
      ["2026-12-01", "2026-12-07", "2026-11-30T15:30:00.000Z"],
    ]);
    expect(convertBalanceTransaction(bt, { timeZone: "UTC" }).rows[0]?.txnDate).toBe("2026-11-30");
  });

  it("takes in a pending transaction with its future available_on as the value date", () => {
    const { rows } = convertBalanceTransaction(transaction("txn_test_km_05"));
    expect(rows[0]).toMatchObject({
      txnDate: "2026-11-30",
      valueDate: "2026-12-06",
      amount: 11000n,
      raw: { status: "pending" },
    });
  });

  it("shows an unknown reporting_category as it is", () => {
    const bt = { ...transaction("txn_test_pf_06"), reporting_category: "anticipation_repayment" };
    expect(convertBalanceTransaction(bt).rows[0]?.descriptionRaw).toBe("anticipation_repayment");
    const prototypeKey = { ...transaction("txn_test_pf_06"), reporting_category: "constructor" };
    expect(convertBalanceTransaction(prototypeKey).rows[0]?.descriptionRaw).toBe("constructor");
  });

  it("stores an expanded source as its ID", () => {
    const bt = {
      ...transaction("txn_test_pf_02"),
      source: { id: "ch_test_pf_02", object: "charge" } as unknown as string,
    };
    expect(convertBalanceTransaction(bt).rows[0]?.raw).toMatchObject({ source: "ch_test_pf_02" });
  });

  it("names every reporting_category of §4.3", () => {
    expect(STRIPE_CATEGORY_LABELS).toEqual({
      charge: "決済",
      payment: "決済",
      refund: "返金",
      payment_refund: "返金",
      refund_failure: "返金の失敗",
      dispute: "チャージバック",
      dispute_reversal: "チャージバックの取消",
      fee: "手数料",
      payout: "入金（銀行へ）",
      payout_reversal: "入金の戻り",
      platform_earning: "プラットフォーム手数料",
      platform_earning_refund: "プラットフォーム手数料の返金",
      transfer: "振替",
      transfer_reversal: "振替の取消",
      topup: "チャージ",
      adjustment: "調整",
      risk_reserved_funds: "留保",
      other_adjustment: "その他の調整",
    });
  });

  describe.each([
    ["platform (acct_0000000000000001)", platform],
    ["拠点 (acct_0000000000000002)", kamakura],
  ])("fictional account %s", (_name, transactions) => {
    it("adds up to each transaction's net, with unique external IDs", () => {
      const ids: string[] = [];
      for (const bt of transactions) {
        const { rows, failure } = convertBalanceTransaction(bt);
        if (bt.currency !== "jpy") {
          expect(failure).not.toBeNull();
          continue;
        }
        expect(rows.reduce((total, row) => total + row.amount, 0n)).toBe(BigInt(bt.net));
        ids.push(...rows.map((row) => row.externalId));
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives the same lines when synced again", () => {
      const convert = () => transactions.map((bt) => convertBalanceTransaction(bt));
      expect(convert()).toEqual(convert());
    });
  });
});

describe("fetchBalanceTransactions (12-imports §4.2)", () => {
  it("pages with starting_after until has_more is false", async () => {
    const source = new FakeBalanceTransactionSource(platform, 4);
    const { transactions, newest } = await fetchBalanceTransactions(source, {});
    expect(source.calls).toEqual([
      { limit: 100 },
      { limit: 100, startingAfter: "txn_test_pf_07" },
      { limit: 100, startingAfter: "txn_test_pf_03" },
    ]);
    expect(transactions.map((bt) => bt.id)).toEqual([
      "txn_test_pf_10",
      "txn_test_pf_09",
      "txn_test_pf_08",
      "txn_test_pf_07",
      "txn_test_pf_06",
      "txn_test_pf_05",
      "txn_test_pf_04",
      "txn_test_pf_03",
      "txn_test_pf_02",
      "txn_test_pf_01",
    ]);
    expect(newest).toEqual({ created: 1796052600, id: "txn_test_pf_10" });
  });

  it("asks only for transactions created at or after createdGte", async () => {
    const source = new FakeBalanceTransactionSource(kamakura, 2);
    const createdGte = transaction("txn_test_km_02").created;
    const { transactions, newest } = await fetchBalanceTransactions(source, { createdGte });
    expect(source.calls).toEqual([
      { limit: 100, createdGte },
      { limit: 100, createdGte, startingAfter: "txn_test_km_04" },
    ]);
    expect(transactions.map((bt) => bt.id)).toEqual([
      "txn_test_km_05",
      "txn_test_km_04",
      "txn_test_km_03",
      "txn_test_km_02",
    ]);
    expect(newest).toEqual({ created: 1795996799, id: "txn_test_km_05" });
  });

  it("returns no cursor when there is nothing new", async () => {
    const source = new FakeBalanceTransactionSource(platform, 4);
    expect(await fetchBalanceTransactions(source, { createdGte: 1900000000 })).toEqual({
      transactions: [],
      newest: null,
    });
    expect(source.calls).toHaveLength(1);
  });

  it("takes the first listed of transactions created in the same second as the newest", async () => {
    const base = transaction("txn_test_pf_06");
    const source: BalanceTransactionSource = {
      list: () =>
        Promise.resolve({
          data: [
            { ...base, id: "txn_test_tie_a", created: 1796000000 },
            { ...base, id: "txn_test_tie_b", created: 1796000000 },
            { ...base, id: "txn_test_tie_c", created: 1795000000 },
          ],
          hasMore: false,
        }),
    };
    const { newest } = await fetchBalanceTransactions(source, {});
    expect(newest).toEqual({ created: 1796000000, id: "txn_test_tie_a" });
  });

  it("stops on an empty page and refuses a page that repeats", async () => {
    const empty: BalanceTransactionSource = {
      list: () => Promise.resolve({ data: [], hasMore: true }),
    };
    expect(await fetchBalanceTransactions(empty, {})).toEqual({ transactions: [], newest: null });

    const bt = transaction("txn_test_pf_06");
    const stuck: BalanceTransactionSource = {
      list: () => Promise.resolve({ data: [bt], hasMore: true }),
    };
    await expect(fetchBalanceTransactions(stuck, {})).rejects.toThrow(/same page/);
  });
});

describe("parseSyncCursor", () => {
  it("reads the saved cursor", () => {
    expect(parseSyncCursor('{"created":1796052600,"id":"txn_test_pf_10"}')).toEqual({
      created: 1796052600,
      id: "txn_test_pf_10",
    });
  });

  it("reads what fetchBalanceTransactions returned, once saved as JSON", async () => {
    const { newest } = await fetchBalanceTransactions(
      new FakeBalanceTransactionSource(kamakura, 10),
      {},
    );
    expect(parseSyncCursor(JSON.stringify(newest))).toEqual(newest);
  });

  it.each([
    null,
    "",
    "not json",
    "null",
    "123",
    "[]",
    '{"created":"1796052600","id":"txn_test_pf_10"}',
    '{"created":1.5,"id":"txn_test_pf_10"}',
    '{"created":-1,"id":"txn_test_pf_10"}',
    '{"created":1796052600,"id":""}',
    '{"created":1796052600}',
    '{"id":"txn_test_pf_10"}',
  ])("returns null for %j", (text) => {
    expect(parseSyncCursor(text)).toBeNull();
  });
});
