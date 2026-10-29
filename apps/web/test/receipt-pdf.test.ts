import type { ReceiptPdfData } from "@niho-finance/db";
import { describe, expect, it } from "vitest";
import { receiptPdfFileNames, renderReceiptPdf } from "@/lib/pdf/receipt";

/** A fictional receipt of a 適格請求書 (10% and 8%, 18 §3.2's fixture), issued on 2026-12-15. */
function receiptData(overrides: Partial<ReceiptPdfData["receipt"]> = {}): ReceiptPdfData {
  return {
    receipt: {
      id: "01RECEIPT0000000000000000A",
      invoiceId: "01INVOICE0000000000000000A",
      number: "RC-2026-0001",
      issueDate: "2026-12-15",
      receivedOn: "2026-12-10",
      amount: 138_622n,
      proviso: "架空サイトの開発 の代金として",
      recipientName: "架空デザイン合同会社",
      pdfDocumentId: null,
      issuedAt: new Date("2026-12-15T01:00:00Z"),
      issuedBy: "owner@example.com",
      voided: false,
      voidedAt: null,
      voidReason: null,
      ...overrides,
    },
    invoice: {
      id: "01INVOICE0000000000000000A",
      number: "INV-2026-0001",
      title: "架空サイトの開発",
    },
    recipient: { name: "架空デザイン合同会社", address: "架空県架空市 1-2-3" },
    issuer: {
      name: "架空商会株式会社",
      address: "架空県架空町 4-5-6",
      representative: "代表取締役 架空 太郎",
      invoiceRegistrationNumber: "T9999999999999",
      invoiceRegisteredOn: "2026-11-02",
      qualified: true,
      bankAccount: null,
    },
    qualified: true,
    rates: [
      {
        taxCategoryCode: "sales_10",
        ratePercent: 10,
        reduced: false,
        taxable: true,
        lineCount: 3,
        subtotal: 125_005n,
        amountExclusive: 125_005n,
        taxAmount: 12_500n,
        amountInclusive: 137_505n,
        label: "10%",
      },
      {
        taxCategoryCode: "sales_8r",
        ratePercent: 8,
        reduced: true,
        taxable: true,
        lineCount: 1,
        subtotal: 1_035n,
        amountExclusive: 1_035n,
        taxAmount: 82n,
        amountInclusive: 1_117n,
        label: "8%（軽減）",
      },
    ],
    amountExclusive: 126_040n,
    taxTotal: 12_582n,
    stampNote: "電子領収書につき収入印紙は不要です",
  };
}

const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5));

describe("receipt PDF (18 §15.2)", () => {
  it("draws a receipt in force and a void one", async () => {
    const bytes = await renderReceiptPdf(receiptData(), {
      exportedAt: new Date("2026-12-15T03:00:00Z"),
    });
    expect(header(bytes)).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(2_000);

    const voided = await renderReceiptPdf(
      receiptData({ voided: true, voidedAt: new Date(), voidReason: "宛名の誤り" }),
    );
    expect(header(voided)).toBe("%PDF-");
  }, 30_000);

  it("draws a 区分記載 receipt without the registration number", async () => {
    const data = receiptData();
    const bytes = await renderReceiptPdf({
      ...data,
      qualified: false,
      issuer: { ...data.issuer, qualified: false, invoiceRegistrationNumber: null },
      stampNote: null,
    });
    expect(header(bytes)).toBe("%PDF-");
  }, 30_000);

  it("names the files like the NIHO app's receipts", () => {
    expect(receiptPdfFileNames(receiptData())).toEqual({
      fileName: "RC-2026-0001.pdf",
      utf8FileName: "20261215-架空デザイン合同会社様_領収書_RC-2026-0001.pdf",
    });
  });
});
