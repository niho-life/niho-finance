import { invoiceMailSchema, type InvoiceDetail } from "@niho-finance/db";
import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";
import {
  buildInvoiceMailDraft,
  type InvoiceMailSource,
} from "../app/(app)/invoices/_lib/mail-draft";

/** A fictional issued invoice (18 §11): the totals of the fixture, a 振込先, a partner with mail. */
function source(overrides: Partial<InvoiceMailSource> = {}): InvoiceMailSource {
  const issuer: InvoiceDetail["issuer"] = {
    name: "架空商会株式会社",
    address: null,
    representative: null,
    invoiceRegistrationNumber: null,
    invoiceRegisteredOn: null,
    qualified: false,
    bankAccount: {
      bankName: "架空銀行",
      branchName: "見本支店",
      accountType: "ordinary",
      accountNumber: "0000000",
      accountHolder: "カ）カクウショウカイ",
      note: null,
    },
  };
  return {
    docType: "invoice",
    number: "INV-2026-0001",
    dueDate: "2027-01-31",
    total: 138_622n,
    issuer,
    recipient: {
      partnerId: "p",
      name: "架空デザイン合同会社",
      address: null,
      email: "billing@example.com",
      partnerIsActive: true,
    },
    sentTo: null,
    ...overrides,
  };
}

describe("the default mail of a document", () => {
  it("writes a business letter with the amount, the due date and the 振込先", () => {
    const draft = buildInvoiceMailDraft(source());
    expect(draft.to).toBe("billing@example.com");
    expect(draft.subject).toBe("請求書（INV-2026-0001）のご送付｜架空商会株式会社");
    expect(draft.text.split("\n")).toEqual(
      expect.arrayContaining([
        "架空デザイン合同会社 ご担当者様",
        "いつもお世話になっております。架空商会株式会社です。",
        "請求書（INV-2026-0001）をお送りします。添付の PDF をご確認ください。",
        "ご請求金額：¥ 138,622（税込）",
        "支払期限：2027年1月31日",
        "お振込先：架空銀行 見本支店 普通 0000000",
        "口座名義：カ）カクウショウカイ",
      ]),
    );
    expect(draft.text.trimEnd().endsWith("架空商会株式会社")).toBe(true);
  });

  it("leaves the 振込先 out of a quote and names its own amount and due date", () => {
    const draft = buildInvoiceMailDraft(
      source({ docType: "quote", number: "QT-2026-0002", dueDate: "2026-12-31" }),
    );
    expect(draft.subject).toBe("見積書（QT-2026-0002）のご送付｜架空商会株式会社");
    expect(draft.text).toContain("お見積金額：¥ 138,622（税込）");
    expect(draft.text).toContain("有効期限：2026年12月31日");
    expect(draft.text).not.toContain("お振込先");
  });

  it("falls back to the last mail destination, never to a recorded method", () => {
    const noMail = { ...source().recipient, email: null };
    expect(
      buildInvoiceMailDraft(source({ recipient: noMail, sentTo: "a@example.com, b@example.com" }))
        .to,
    ).toBe("a@example.com, b@example.com");
    expect(buildInvoiceMailDraft(source({ recipient: noMail, sentTo: "郵送" })).to).toBe("");
  });
});

describe("the mail form", () => {
  it("takes up to 5 addresses separated by commas or spaces, without duplicates", () => {
    const parsed = invoiceMailSchema.parse({
      to: "a@example.com, b@example.com  a@example.com",
      subject: "件名",
      text: "本文",
    });
    expect(parsed.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("names what is wrong with the recipients", () => {
    const messageOf = (to: string) => {
      try {
        invoiceMailSchema.parse({ to, subject: "件名", text: "本文" });
      } catch (error) {
        return (error as ZodError).issues[0]?.message;
      }
      return null;
    };
    expect(messageOf("")).toBe("宛先のメールアドレスを入れてください");
    expect(messageOf("billing@example")).toContain("メールアドレスの形ではありません");
    expect(
      messageOf(
        "1@example.com 2@example.com 3@example.com 4@example.com 5@example.com 6@example.com",
      ),
    ).toBe("宛先は 5 件までにしてください");
  });
});
