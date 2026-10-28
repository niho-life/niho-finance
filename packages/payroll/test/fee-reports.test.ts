/**
 * 報酬、料金、契約金及び賞金の支払調書 (22-payroll §12.2): per-payee aggregation of 5410 / 5110 and the
 * 預り金 of the same entries, the 5 万円 rule, 個人 / 法人 / 未確認, the 合計表's rows and the e-Tax
 * 309 CSV (53 items). Every partner is fictional.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateFeePayments,
  FEE_CSV_FIELD_COUNT,
  feeReportCsvRows,
  feeReportTotals,
  type FeeJournalLine,
  type FeePartner,
  type FeeWithholdingLine,
  type StatementPayer,
} from "../src";

const PAYER: StatementPayer = {
  name: "架空株式会社",
  address: "架空県架空市本町1-2-3",
  phone: null,
  corporateNumber: "7000012345678",
};

const PARTNERS: FeePartner[] = [
  { id: "p_tax", name: "架空 税理士事務所", address: "架空市1-1", isIndividual: true },
  { id: "p_design", name: "テスト デザイン", address: null, isIndividual: true },
  { id: "p_corp", name: "架空商事株式会社", address: "架空市2-2", isIndividual: false },
  { id: "p_unknown", name: "未確認の取引先", address: null, isIndividual: null },
  { id: "p_small", name: "テスト 翻訳", address: null, isIndividual: true },
];

const line = (
  entryNo: number,
  partnerId: string | null,
  accountCode: "5410" | "5110",
  amount: bigint,
): FeeJournalLine => ({
  entryId: `e${entryNo}`,
  entryNo,
  entryDate:
    `2026-${String(Math.min(12, entryNo)).padStart(2, "0")}-10` as `${number}-${number}-${number}`,
  accountCode,
  partnerId,
  amount,
});

const withheld = (
  entryNo: number,
  amount: bigint,
  partnerId: string | null = null,
): FeeWithholdingLine => ({
  entryId: `e${entryNo}`,
  partnerId,
  amount,
});

describe("aggregateFeePayments", () => {
  const result = aggregateFeePayments({
    lines: [
      line(1, "p_tax", "5410", 55_000n),
      line(2, "p_tax", "5410", 55_000n),
      // A correction entered as a credit (返金).
      line(3, "p_tax", "5410", -5_000n),
      line(4, "p_design", "5110", 120_000n),
      line(5, "p_corp", "5110", 300_000n),
      line(6, "p_unknown", "5410", 80_000n),
      line(7, "p_small", "5110", 30_000n),
      line(8, null, "5410", 10_000n),
      // One entry for two payees, the 預り金 without a partner.
      line(9, "p_tax", "5410", 10_000n),
      line(9, "p_design", "5110", 10_000n),
    ],
    withholding: [
      withheld(1, 5_105n),
      withheld(2, 5_105n),
      withheld(4, 12_252n),
      withheld(6, 8_168n),
      withheld(7, 3_063n),
      withheld(9, 2_042n),
    ],
    partners: PARTNERS,
    categories: { "p_design.5110": "manuscript" },
  });
  const byId = new Map(result.payees.map((payee) => [payee.partner.id, payee]));

  it("nets each payee's lines and puts the 預り金 of the entry to them", () => {
    expect(byId.get("p_tax")).toMatchObject({
      paid: 115_000n,
      withheld: 10_210n,
      reportable: true,
      items: [
        { accountCode: "5410", category: "tax_accountant", paid: 115_000n, withheld: 10_210n },
      ],
    });
    expect(byId.get("p_tax")?.entries.map((entry) => entry.no)).toEqual([1, 2, 3, 9]);
    expect(byId.get("p_design")).toMatchObject({
      paid: 130_000n,
      withheld: 12_252n,
      items: [{ category: "manuscript" }],
    });
  });

  it("reports individuals over 5 万円 only", () => {
    expect(byId.get("p_corp")?.reportable).toBe(false);
    expect(byId.get("p_unknown")?.reportable).toBe(false);
    expect(byId.get("p_small")?.reportable).toBe(false);
  });

  it("lists lines without a partner and 預り金 it cannot put to one payee", () => {
    expect(result.unassigned).toEqual([{ entryId: "e8", entryNo: 8, amount: 10_000n }]);
    expect(result.ambiguousWithholding).toEqual([{ entryId: "e9", entryNo: 9, amount: 2_042n }]);
  });

  it("gives the 合計表's rows of the individuals", () => {
    const totals = feeReportTotals(result.payees);
    expect(totals.total).toEqual({
      people: 3,
      paid: 275_000n,
      withheld: 25_525n,
      reported: { people: 2, paid: 245_000n },
    });
    expect(totals.byItem).toEqual([
      {
        item: 1,
        row: {
          people: 2,
          paid: 160_000n,
          withheld: 15_315n,
          reported: { people: 1, paid: 130_000n },
        },
      },
      {
        item: 2,
        row: {
          people: 1,
          paid: 115_000n,
          withheld: 10_210n,
          reported: { people: 1, paid: 115_000n },
        },
      },
    ]);
    expect(totals.byCategory.map((row) => row.category)).toEqual([
      "tax_accountant",
      "design",
      "manuscript",
    ]);
  });
});

describe("the e-Tax 309 CSV row (53 items)", () => {
  const payee = aggregateFeePayments({
    lines: [line(1, "p_tax", "5410", 110_000n)],
    withholding: [withheld(1, 11_231n)],
    partners: PARTNERS,
  }).payees[0]!;

  it("has 53 items with the payment in 支払内容 (1)", () => {
    const [row] = feeReportCsvRows(2026, PAYER, payee, { payeeNumber: "123456789012" });
    expect(row).toHaveLength(FEE_CSV_FIELD_COUNT);
    const at = (no: number) => row![no - 1];
    expect(at(1)).toBe("309");
    expect(at(4)).toBe("架空県架空市本町１－２－３");
    expect(at(5)).toBe("架空株式会社");
    expect(at(10)).toBe("0");
    expect(at(11)).toBe("08");
    expect(at(12)).toBe("架空市１－１");
    expect(at(13)).toBe("0");
    expect(at(14)).toBe("架空　税理士事務所");
    expect([at(15), at(16), at(17), at(18), at(19), at(20)]).toEqual([
      "税理士報酬",
      "",
      "110000",
      "",
      "11231",
      "",
    ]);
    expect(row!.slice(20, 50).every((value) => value === "")).toBe(true);
    expect(at(52)).toBe("7000012345678");
    // A 個人番号 is padded to 13 digits.
    expect(at(53)).toBe("0123456789012");
  });

  it("leaves the payee's number empty unless typed", () => {
    const [row] = feeReportCsvRows(2026, PAYER, payee);
    expect(row![52]).toBe("");
  });
});
