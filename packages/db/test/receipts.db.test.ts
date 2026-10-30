import type { CalendarDate } from "@niho-finance/ledger";
import type { Company, PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachReceiptPdf,
  cancelInvoicePayment,
  createInvoiceDraft,
  describeAuditTargets,
  getDocumentDetail,
  getInvoiceDetail,
  getInvoiceReceipts,
  getReceiptPdfData,
  issueInvoice,
  issueReceipt,
  listInvoices,
  loadInvoiceHistory,
  newId,
  recordInvoicePayment,
  registerDocument,
  SettingsError,
  voidInvoice,
  voidReceipt,
  type InvoiceDraftInput,
  type InvoiceRecord,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

const actor = "receipt-tester@example.com";
const options = { actor };
/** 第 67 期 (2067-04-01〜2068-03-31) is this file's own year. */
const TODAY: CalendarDate = "2067-07-01";

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

/**
 * 領収書 (18-invoicing §15): only a paid invoice takes one, numbered RC-<期>-<連番>, one in force per
 * invoice, frozen after the issue (application and DB), voided and issued again, blocking the
 * invoice's 入金の取消 and 無効, with the copies fixed and every write in the audit log.
 */
describe.skipIf(!hasTestDatabase)("receipts (領収書)", () => {
  let prisma: PrismaClient;
  let company: Company;
  let partnerId: string;
  let bankWalletId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    await createFiscalYear(prisma, { no: 67, startDate: "2067-04-01", endDate: "2068-03-31" });
    company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    partnerId = (
      await prisma.partner.create({
        data: {
          id: newId(),
          name: "架空受領株式会社",
          kind: "customer",
          address: "架空県架空市 1-2-3",
        },
      })
    ).id;
    bankWalletId = (await prisma.wallet.findFirstOrThrow({ where: { name: "架空銀行 普通" } })).id;
  });

  afterAll(async () => {
    if (!company) return;
    await prisma.company.update({ where: { id: company.id }, data: { name: company.name } });
  });

  const draftInput = (overrides: Partial<InvoiceDraftInput> = {}): InvoiceDraftInput => ({
    docType: "invoice",
    partnerId,
    title: "架空アプリの保守",
    issueDate: "2067-06-01",
    dueDate: "",
    pricesIncludeTax: false,
    note: "",
    revenueAccountId: "",
    segmentId: "",
    sourceInvoiceId: "",
    lines: [
      {
        date: "",
        name: "保守 一式",
        quantity: "1",
        unit: "式",
        unitPrice: "100,000",
        taxCategoryCode: "sales_10",
      },
    ],
    ...overrides,
  });

  async function issued(overrides: Partial<InvoiceDraftInput> = {}): Promise<InvoiceRecord> {
    const draft = await createInvoiceDraft(prisma, draftInput(overrides), options);
    return issueInvoice(prisma, draft.id, options);
  }

  /** Issued and paid in full on 6/20 (入金 109,340 円 + 振込手数料 660 円 = 110,000 円). */
  async function paid(overrides: Partial<InvoiceDraftInput> = {}): Promise<InvoiceRecord> {
    const invoice = await issued(overrides);
    return recordInvoicePayment(
      prisma,
      invoice.id,
      {
        paidOn: "2067-06-20",
        walletId: bankWalletId,
        amount: "109,340",
        fee: "660",
        walletTransactionId: "",
      },
      options,
    );
  }

  const issueOn = (invoiceId: string, issueDate: CalendarDate = "2067-06-25", proviso = "") =>
    issueReceipt(prisma, invoiceId, { issueDate, proviso }, { ...options, today: TODAY });

  it("issues only for a paid invoice", async () => {
    const draft = await createInvoiceDraft(prisma, draftInput(), options);
    expect(settingsError(await rejectionOf(issueOn(draft.id))).message).toBe(
      "領収書を発行できるのは入金済みの請求書だけです（この請求書は下書きです）",
    );
    const open = await issued();
    expect(settingsError(await rejectionOf(issueOn(open.id))).message).toBe(
      "領収書を発行できるのは入金済みの請求書だけです（この請求書は発行済みです）",
    );
    // A partial payment leaves it 発行済み.
    await recordInvoicePayment(
      prisma,
      open.id,
      {
        paidOn: "2067-06-10",
        walletId: bankWalletId,
        amount: "10,000",
        fee: "",
        walletTransactionId: "",
      },
      options,
    );
    expect(settingsError(await rejectionOf(issueOn(open.id))).message).toMatch(
      /入金済みの請求書だけ/,
    );
    const quoteDraft = await createInvoiceDraft(prisma, draftInput({ docType: "quote" }), options);
    const quote = await issueInvoice(prisma, quoteDraft.id, options);
    expect(settingsError(await rejectionOf(issueOn(quote.id))).message).toBe(
      "領収書を発行できるのは入金済みの請求書だけです",
    );
    const section = await getInvoiceReceipts(prisma, open.id, { today: TODAY });
    expect(section).toMatchObject({ available: false, canIssue: false, current: null });
  });

  it("numbers RC-<期>-<連番>, copies the invoice and keeps one in force", async () => {
    const invoice = await paid();
    const section = await getInvoiceReceipts(prisma, invoice.id, { today: TODAY });
    expect(section).toMatchObject({
      available: true,
      canIssue: true,
      blocked: null,
      defaults: {
        issueDate: TODAY,
        proviso: "架空アプリの保守 の代金として",
        receivedOn: "2067-06-20",
        amount: 110_000n,
        recipientName: "架空受領株式会社",
        stampHelp: "紙に印刷して渡すときは収入印紙が要ります（5 万円以上）",
      },
    });

    const receipt = await issueOn(invoice.id);
    expect(receipt).toMatchObject({
      number: "RC-2067-0001",
      issueDate: "2067-06-25",
      receivedOn: "2067-06-20",
      // The fee the customer deducted is received in full: the invoice's total.
      amount: 110_000n,
      proviso: "架空アプリの保守 の代金として",
      recipientName: "架空受領株式会社",
      pdfDocumentId: null,
      voided: false,
      issuedBy: actor,
    });
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.issuerSnapshot).toEqual(stored.issuerSnapshot);
    expect(row.recipientSnapshot).toEqual(stored.recipientSnapshot);
    expect(row.subtotalByRate).toEqual(stored.subtotalByRate);
    expect(row.taxByRate).toEqual(stored.taxByRate);

    // One in force: refused by the application, and by the partial unique index under it.
    expect(settingsError(await rejectionOf(issueOn(invoice.id))).message).toBe(
      "領収書 RC-2067-0001 を発行済みです。発行し直すには、先にその領収書を無効にしてください",
    );
    const twin = newId();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "receipt" ("id", "invoice_id", "number", "issue_date", "received_on", "amount",
          "proviso", "recipient_snapshot", "issuer_snapshot", "subtotal_by_rate", "tax_by_rate",
          "issued_by")
        SELECT ${twin}, "invoice_id", 'RC-2067-9999', "issue_date", "received_on", "amount",
          "proviso", "recipient_snapshot", "issuer_snapshot", "subtotal_by_rate", "tax_by_rate",
          "issued_by"
        FROM "receipt" WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/Key \(invoice_id\)=\(\w+\) already exists/);

    // The next invoice's receipt takes the next number; the custom 但し書き is kept.
    const other = await paid({ title: "" });
    const second = await issueOn(other.id, "2067-06-30", "システム保守料として");
    expect(second).toMatchObject({ number: "RC-2067-0002", proviso: "システム保守料として" });
    const third = await paid({ title: "" });
    expect((await issueOn(third.id)).proviso).toBe("お品代として");

    // The list and the detail show it.
    const detail = await getInvoiceDetail(prisma, invoice.id, { today: TODAY });
    expect(detail?.receipt).toEqual({
      id: receipt.id,
      number: "RC-2067-0001",
      issueDate: "2067-06-25",
      pdfDocumentId: null,
    });
    const page = await listInvoices(prisma, { status: "paid", partner: partnerId }, 1, {
      today: TODAY,
    });
    expect(page.rows.find((item) => item.id === invoice.id)?.receipt?.number).toBe("RC-2067-0001");
  });

  it("checks the issue date: after the last payment, not after today, in a fiscal year", async () => {
    const invoice = await paid();
    expect(settingsError(await rejectionOf(issueOn(invoice.id, "2067-06-19")))).toEqual({
      message: "発行日は入金日（2067/06/20）以後にしてください",
      field: "issueDate",
    });
    expect(settingsError(await rejectionOf(issueOn(invoice.id, "2067-07-02")))).toEqual({
      message: "発行日は今日以前にしてください",
      field: "issueDate",
    });
    const noYear = await rejectionOf(
      issueReceipt(
        prisma,
        invoice.id,
        { issueDate: "2069-01-10", proviso: "" },
        { ...options, today: "2069-01-10" },
      ),
    );
    expect(settingsError(noYear)).toEqual({
      message:
        "2069/01/10 を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください",
      field: "issueDate",
    });
    // The refused issues took no number.
    expect((await issueOn(invoice.id)).number).toMatch(/^RC-2067-\d{4}$/);
  });

  it("refuses rewriting an issued receipt (application and DB trigger)", async () => {
    const invoice = await paid();
    const receipt = await issueOn(invoice.id);
    await expect(
      prisma.$executeRaw`UPDATE "receipt" SET "amount" = 1 WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/ledger guard: receipt .* its body is immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "receipt" SET "proviso" = '書き換え' WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/its body is immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "receipt" SET "issuer_snapshot" = '{}' WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/its body is immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM "receipt" WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/ledger guard: receipt .* cannot be deleted/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "receipt"`)).rejects.toThrow(
      /ledger guard: TRUNCATE on receipt is not allowed/,
    );
    await expect(
      prisma.$executeRaw`UPDATE "receipt" SET "voided_at" = now() WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/receipt_void_fields/);

    // A void receipt never changes again.
    await voidReceipt(prisma, receipt.id, { reason: "宛名の誤り" }, options);
    await expect(
      prisma.$executeRaw`UPDATE "receipt" SET "voided_at" = NULL, "void_reason" = NULL WHERE "id" = ${receipt.id}`,
    ).rejects.toThrow(/receipt .* is void and cannot change/);
    expect(
      settingsError(
        await rejectionOf(voidReceipt(prisma, receipt.id, { reason: "二度目" }, options)),
      ).message,
    ).toBe("この領収書はすでに無効です。画面を読み込み直してください");
  });

  it("is voided with a reason and issued again with a new number", async () => {
    const invoice = await paid();
    const first = await issueOn(invoice.id);
    const voided = await voidReceipt(prisma, first.id, { reason: "但し書きの誤り" }, options);
    expect(voided).toMatchObject({
      number: first.number,
      voided: true,
      voidReason: "但し書きの誤り",
    });
    const again = await issueOn(invoice.id, "2067-06-26", "保守料として");
    expect(again.number).not.toBe(first.number);
    const section = await getInvoiceReceipts(prisma, invoice.id, { today: TODAY });
    expect(section?.current?.id).toBe(again.id);
    expect(section?.voided.map((receipt) => [receipt.number, receipt.voidReason])).toEqual([
      [first.number, "但し書きの誤り"],
    ]);
    expect(section?.canIssue).toBe(false);
    // The PDF of the invoice takes the receipt in force, or the one asked for.
    expect((await getReceiptPdfData(prisma, invoice.id))?.receipt.id).toBe(again.id);
    expect(
      (await getReceiptPdfData(prisma, invoice.id, { receiptId: first.id }))?.receipt,
    ).toMatchObject({ voided: true, voidReason: "但し書きの誤り" });
  });

  it("blocks 入金の取消 and 無効 of the invoice while a receipt is in force", async () => {
    const invoice = await paid();
    const receipt = await issueOn(invoice.id);
    const detail = await getInvoiceDetail(prisma, invoice.id, { today: TODAY });
    const blocked = `領収書 ${receipt.number} を発行しています。先に領収書を無効にしてください`;
    expect(detail?.actions).toMatchObject({
      canVoid: false,
      canCancelPayment: false,
      blocked: { void: blocked, cancelPayment: blocked },
    });
    const paymentId = detail?.payments[0]?.id ?? "";
    expect(
      settingsError(
        await rejectionOf(
          cancelInvoicePayment(prisma, invoice.id, { paymentId, reason: "誤登録" }, options),
        ),
      ).message,
    ).toBe(blocked);
    expect(
      settingsError(await rejectionOf(voidInvoice(prisma, invoice.id, { reason: "誤り" }, options)))
        .message,
    ).toBe(blocked);

    // Once the receipt is void, the payment can be cancelled (and then the invoice voided).
    await voidReceipt(prisma, receipt.id, { reason: "入金の誤登録" }, options);
    const reopened = await cancelInvoicePayment(
      prisma,
      invoice.id,
      { paymentId, reason: "誤登録" },
      options,
    );
    expect(reopened.status).toBe("issued");
    // The void receipt stays in view (its PDF too), saying why none can be issued now.
    expect(await getInvoiceReceipts(prisma, invoice.id, { today: TODAY })).toMatchObject({
      available: true,
      current: null,
      voided: [{ id: receipt.id }],
      canIssue: false,
      blocked: "領収書を発行できるのは入金済みの請求書だけです",
    });
    expect(settingsError(await rejectionOf(issueOn(invoice.id))).message).toMatch(
      /入金済みの請求書だけ/,
    );
    await voidInvoice(prisma, invoice.id, { reason: "誤り" }, options);
  });

  it("keeps its copies when the settings change afterwards", async () => {
    const invoice = await paid();
    const receipt = await issueOn(invoice.id);
    const before = await getReceiptPdfData(prisma, invoice.id);
    await prisma.company.update({
      where: { id: company.id },
      data: { name: "架空変更後株式会社" },
    });
    await prisma.partner.update({ where: { id: partnerId }, data: { name: "架空改名株式会社" } });
    const after = await getReceiptPdfData(prisma, invoice.id);
    expect(after?.issuer).toEqual(before?.issuer);
    expect(after?.issuer.name).toBe(company.name);
    expect(after?.recipient).toEqual({ name: "架空受領株式会社", address: "架空県架空市 1-2-3" });
    expect(after).toMatchObject({
      receipt: { id: receipt.id, amount: 110_000n },
      invoice: { id: invoice.id, number: invoice.number, title: "架空アプリの保守" },
      amountExclusive: 100_000n,
      taxTotal: 10_000n,
      stampNote: "電子領収書につき収入印紙は不要です",
    });
    expect(after?.rates.map((rate) => [rate.label, rate.amountExclusive, rate.taxAmount])).toEqual([
      ["10%", 100_000n, 10_000n],
    ]);
    await prisma.company.update({ where: { id: company.id }, data: { name: company.name } });
    await prisma.partner.update({ where: { id: partnerId }, data: { name: "架空受領株式会社" } });

    // Below 50,000 円 without the tax: no stamp note.
    const small = await issued({
      lines: [
        {
          date: "",
          name: "相談",
          quantity: "1",
          unit: "",
          unitPrice: "45,000",
          taxCategoryCode: "sales_10",
        },
      ],
    });
    await recordInvoicePayment(
      prisma,
      small.id,
      {
        paidOn: "2067-06-20",
        walletId: bankWalletId,
        amount: "49,500",
        fee: "",
        walletTransactionId: "",
      },
      options,
    );
    await issueOn(small.id);
    expect((await getReceiptPdfData(prisma, small.id))?.stampNote).toBeNull();
    expect(
      (await getInvoiceReceipts(prisma, small.id, { today: TODAY }))?.defaults.stampHelp,
    ).toBeNull();
  });

  it("ties the stored PDF once and logs every write", async () => {
    const invoice = await paid();
    const receipt = await issueOn(invoice.id);
    const pdf = async () =>
      (
        await registerDocument(
          prisma,
          {
            storageKey: `documents/2067/06/${newId()}.pdf`,
            sha256: randomBytes(32).toString("hex"),
            mime: "application/pdf",
            byteSize: 2_048,
            originalName: "20670625-架空受領株式会社様_領収書.pdf",
            source: "generated",
            kind: "other",
          },
          options,
        )
      ).document;
    const copy = await pdf();
    const attached = await attachReceiptPdf(prisma, receipt.id, { documentId: copy.id }, options);
    expect(attached.pdfDocumentId).toBe(copy.id);
    // The same copy again changes nothing; another one is refused, and so is the DB.
    await attachReceiptPdf(prisma, receipt.id, { documentId: copy.id }, options);
    const other = await pdf();
    expect(
      settingsError(
        await rejectionOf(attachReceiptPdf(prisma, receipt.id, { documentId: other.id }, options)),
      ).message,
    ).toBe("この領収書の PDF はすでに証憑に保存しています");
    await expect(
      prisma.receipt.update({ where: { id: receipt.id }, data: { pdfDocumentId: other.id } }),
    ).rejects.toThrow(/pdf_document_id of receipt .* is already set/);
    const detail = await getInvoiceDetail(prisma, invoice.id, { today: TODAY });
    const paymentEntryId = detail?.payments[0]?.journalEntry?.id;
    const linked = await getDocumentDetail(prisma, copy.id);
    expect(linked?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invoice", id: invoice.id }),
        expect.objectContaining({ kind: "journal_entry", id: paymentEntryId }),
      ]),
    );

    await voidReceipt(prisma, receipt.id, { reason: "再発行のため" }, options);
    expect(
      settingsError(
        await rejectionOf(attachReceiptPdf(prisma, receipt.id, { documentId: other.id }, options)),
      ).message,
    ).toBe("無効の領収書には PDF を保存できません");

    const history = await loadInvoiceHistory(prisma, invoice.id);
    const receiptRows = history.filter((row) => row.entity === "receipt");
    expect(receiptRows.map((row) => row.action)).toEqual([
      "receipt.issue",
      "receipt.attach_pdf",
      "receipt.void",
    ]);
    expect(receiptRows[2]?.reason).toBe("再発行のため");
    expect(history.some((row) => row.action === "invoice.pay")).toBe(true);
    const names = await describeAuditTargets(prisma, [{ entity: "receipt", entityId: receipt.id }]);
    expect(names.get(`receipt:${receipt.id}`)).toBe(`領収書 ${receipt.number}`);
  });
});
