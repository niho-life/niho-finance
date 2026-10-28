import { randomBytes } from "node:crypto";
import {
  inclusiveTaxAmount,
  type CalendarDate,
  type JournalLineInput,
  type WalletTransactionStatus,
} from "@niho-finance/ledger";
import type { FiscalYear, Partner, PrismaClient, Wallet } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  newId,
  postJournalEntry,
  searchAll,
  searchKind,
  SEARCH_KINDS,
  toDbDate,
  voidJournalEntry,
  type SearchHit,
  type SearchKind,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/** 全体検索 (10 §7) on the seeded book plus the rows of its own year (第 85 期, 2085). */
describe.skipIf(!hasTestDatabase)("search", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let year: FiscalYear;
  let card: Wallet;
  let partner: Partner;
  let inactive: Partner;
  let registrationNumber: string;
  let slowest = 0;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year = await createFiscalYear(prisma, {
      no: 85,
      startDate: "2085-04-01",
      endDate: "2086-03-31",
    });
    card = await prisma.wallet.findFirstOrThrow({ where: { name: "架空カード" } });
    registrationNumber = `T${fictionalCorporateNumber("999999998501")}`;
    partner = await prisma.partner.create({
      data: {
        id: newId(),
        name: "架空ミナト探索株式会社",
        nameKana: "カクウミナトタンサク",
        kind: "vendor",
        invoiceRegistrationNumber: registrationNumber,
      },
    });
    inactive = await prisma.partner.create({
      data: { id: newId(), name: "架空ミナト探索商店", kind: "other", isActive: false },
    });
  });

  /** Every hit of a kind (one page as large as needed). */
  async function hitsOf(input: string, kind: SearchKind): Promise<SearchHit[]> {
    return (await searchKind(prisma, input, kind, { pageSize: 1_000 })).group.hits;
  }

  async function timedSearchAll(input: string, options?: { perKind?: number }) {
    const started = performance.now();
    const result = await searchAll(prisma, input, options);
    const elapsed = performance.now() - started;
    slowest = Math.max(slowest, elapsed);
    expect(elapsed, `searchAll("${input}")`).toBeLessThan(1_000);
    return result;
  }

  async function postEntry(options: {
    entryDate: CalendarDate;
    description: string;
    /** One debit line per amount (their sum is the debit total). */
    debits: bigint[];
    lineDescription?: string;
  }) {
    const total = options.debits.reduce((sum, amount) => sum + amount, 0n);
    const debits: JournalLineInput[] = options.debits.map((amount) => ({
      side: "debit",
      accountId: refs.account("5330"),
      amount,
      taxCategoryCode: "purchase_10",
      taxAmount: inclusiveTaxAmount(amount, 10),
      segmentId: refs.segment("corporate"),
      description: options.lineDescription ?? null,
    }));
    return postJournalEntry(
      prisma,
      {
        fiscalYearId: year.id,
        entryDate: options.entryDate,
        description: options.description,
        kind: "normal",
        sourceKind: "manual",
        lines: [
          ...debits,
          {
            side: "credit",
            accountId: refs.account("2100"),
            subAccountId: refs.subAccount("架空カード"),
            amount: total,
            taxCategoryCode: "na",
            taxAmount: 0n,
          },
        ],
      },
      { actor },
    );
  }

  async function addStatement(options: {
    txnDate: CalendarDate;
    descriptionRaw: string;
    amount: bigint;
    counterpartyRaw?: string;
    status?: WalletTransactionStatus;
  }) {
    return prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId: card.id,
        txnDate: toDbDate(options.txnDate),
        amount: options.amount,
        descriptionRaw: options.descriptionRaw,
        counterpartyRaw: options.counterpartyRaw ?? null,
        externalId: `test-search-${newId()}`,
        status: options.status ?? "pending",
      },
    });
  }

  async function addDocument(options: {
    originalName: string;
    partnerName?: string;
    note?: string;
    amount?: bigint;
    txnDate?: CalendarDate;
    voided?: boolean;
  }) {
    return prisma.document.create({
      data: {
        id: newId(),
        kind: "receipt",
        storageKey: `documents/2085/05/${newId()}.pdf`,
        sha256: randomBytes(32).toString("hex"),
        mime: "application/pdf",
        byteSize: 1_234,
        originalName: options.originalName,
        uploadedBy: actor,
        source: "upload",
        txnDate: options.txnDate ? toDbDate(options.txnDate) : null,
        amount: options.amount ?? null,
        partnerName: options.partnerName ?? null,
        note: options.note ?? null,
        ...(options.voided
          ? { status: "voided" as const, voidedAt: new Date(), voidReason: "差し替え" }
          : {}),
      },
    });
  }

  async function addInvoice(options: {
    id?: string;
    number: string;
    title: string | null;
    total: bigint;
    issueDate: CalendarDate;
    issued: boolean;
  }) {
    return prisma.invoice.create({
      data: {
        id: options.id ?? newId(),
        docType: "invoice",
        number: options.number,
        partnerId: partner.id,
        issueDate: toDbDate(options.issueDate),
        title: options.title,
        lines: [],
        subtotalByRate: [],
        taxByRate: [],
        total: options.total,
        status: options.issued ? "issued" : "draft",
        issuedAt: options.issued ? new Date() : null,
      },
    });
  }

  it("finds a part of a description, half-width kana by full-width and back", async () => {
    const halfWidth = await postEntry({
      entryDate: "2085-05-01",
      description: "ﾐﾅﾄﾀﾝｻｸ 利用料",
      debits: [2_200n],
    });
    const fullWidth = await postEntry({
      entryDate: "2085-05-02",
      description: "ミナトケンサク 会費",
      debits: [3_300n],
    });
    const byLine = await postEntry({
      entryDate: "2085-05-03",
      description: "書籍代",
      debits: [4_400n],
      lineDescription: "ミナト探索ノート",
    });

    const found = await timedSearchAll("ミナトタンサク");
    const entries = found.groups.find((group) => group.kind === "entry");
    expect(entries?.hits.map((hit) => hit.id)).toContain(halfWidth.id);
    expect(found.query).toMatchObject({ raw: "ミナトタンサク", text: "ミナトタンサク" });

    expect((await hitsOf("ﾐﾅﾄｹﾝｻｸ", "entry")).map((hit) => hit.id)).toContain(fullWidth.id);
    const lineHits = await hitsOf("探索ノート", "entry");
    expect(lineHits.map((hit) => hit.id)).toEqual([byLine.id]);
    expect(lineHits[0]).toMatchObject({
      kind: "entry",
      no: byLine.no,
      fiscalYearNo: 85,
      entryDate: "2085-05-03",
      description: "書籍代",
      amount: 4_400n,
      status: "posted",
    });

    const statement = await addStatement({
      txnDate: "2085-05-04",
      descriptionRaw: "振込 ﾐﾅﾄﾀﾝｻｸ(ｶ",
      amount: -2_200n,
    });
    const byCounterparty = await addStatement({
      txnDate: "2085-05-05",
      descriptionRaw: "振込",
      counterpartyRaw: "ミナトタンサク",
      amount: 5_500n,
    });
    const statements = await hitsOf("ﾐﾅﾄﾀﾝｻｸ", "statement");
    expect(statements.map((hit) => hit.id)).toEqual([byCounterparty.id, statement.id]);
    expect(statements[1]).toMatchObject({
      kind: "statement",
      walletId: card.id,
      walletName: "架空カード",
      txnDate: "2085-05-04",
      descriptionRaw: "振込 ﾐﾅﾄﾀﾝｻｸ(ｶ",
      amount: -2_200n,
      status: "pending",
    });
  });

  it("finds amounts: entries by their debit total, statements by |amount|", async () => {
    for (const input of ["1,650", "¥1650"]) {
      const result = await timedSearchAll(input);
      expect(result.query.amount).toBe(1_650n);
      const entries = await hitsOf(input, "entry");
      // The seeded クラウドサービス利用料 (第 1 期).
      expect(
        entries.some(
          (hit) =>
            hit.kind === "entry" &&
            hit.fiscalYearNo === 1 &&
            hit.description === "クラウドサービス利用料",
        ),
      ).toBe(true);
      for (const hit of entries) expect(hit.kind === "entry" && hit.amount).toBe(1_650n);
      const statements = await hitsOf(input, "statement");
      const amounts = new Set(statements.map((hit) => hit.kind === "statement" && hit.amount));
      expect(amounts).toEqual(new Set([1_650n, -1_650n]));
      expect(
        statements.some(
          (hit) => hit.kind === "statement" && hit.descriptionRaw === "口座振替 お支払い",
        ),
      ).toBe(true);
    }

    const split = await postEntry({
      entryDate: "2085-06-01",
      description: "分割の経費",
      debits: [20_000n, 23_219n],
    });
    expect((await hitsOf("43,219", "entry")).map((hit) => hit.id)).toContain(split.id);
    expect((await hitsOf("43,219", "entry"))[0]).toMatchObject({ amount: 43_219n });
    expect((await hitsOf("20,000", "entry")).map((hit) => hit.id)).not.toContain(split.id);

    const document = await addDocument({ originalName: "scan.pdf", amount: 43_219n });
    expect((await hitsOf("￥43,219円", "document")).map((hit) => hit.id)).toContain(document.id);
  });

  it("finds an entry by No. across the fiscal years and leaves the reversals out", async () => {
    const entry = await postEntry({
      entryDate: "2085-07-01",
      description: "ミナト取消テスト",
      debits: [6_600n],
    });
    // All fiscal years: the seeded 第 1 期 has an entry of the same No.
    const byNo = await hitsOf(`No.${entry.no}`, "entry");
    expect(byNo.map((hit) => hit.id)).toContain(entry.id);
    const years = byNo.flatMap((hit) =>
      hit.kind === "entry" && hit.no === entry.no ? [hit.fiscalYearNo] : [],
    );
    expect(years).toEqual(expect.arrayContaining([1, 85]));
    expect((await hitsOf(String(entry.no), "entry")).map((hit) => hit.id)).toContain(entry.id);

    const { reversal } = await voidJournalEntry(prisma, entry.id, { actor, reason: "二重登録" });
    expect(reversal.description).toContain("ミナト取消テスト");
    const hits = await hitsOf("ミナト取消テスト", "entry");
    expect(hits.map((hit) => hit.id)).toEqual([entry.id]);
    expect(hits[0]).toMatchObject({ status: "voided" });
    expect((await hitsOf(`No.${reversal.no}`, "entry")).map((hit) => hit.id)).not.toContain(
      reversal.id,
    );
  });

  it("finds partners by name, kana and registration number (inactive ones too)", async () => {
    const byName = await timedSearchAll("ミナト探索");
    const partners = byName.groups.find((group) => group.kind === "partner");
    expect(partners?.hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining([partner.id, inactive.id]),
    );
    expect(partners?.hits.find((hit) => hit.id === inactive.id)).toMatchObject({
      kind: "partner",
      name: "架空ミナト探索商店",
      partnerKind: "other",
      isActive: false,
    });
    expect((await hitsOf("ｶｸｳﾐﾅﾄﾀﾝｻｸ", "partner")).map((hit) => hit.id)).toEqual([partner.id]);

    const byNumber = await timedSearchAll(registrationNumber);
    expect(byNumber.query.registrationNumber).toBe(registrationNumber);
    const numberHits = byNumber.groups.find((group) => group.kind === "partner")?.hits ?? [];
    expect(numberHits).toEqual([
      expect.objectContaining({ id: partner.id, invoiceRegistrationNumber: registrationNumber }),
    ]);
  });

  it("finds invoices by number, title, partner name and total, never by a draft's placeholder", async () => {
    const issued = await addInvoice({
      number: "INV-2085-0001",
      title: "ウェブ制作",
      total: 330_000n,
      issueDate: "2085-08-01",
      issued: true,
    });
    const draftId = newId();
    const draft = await addInvoice({
      id: draftId,
      number: `INV-draft-${draftId}`,
      title: null,
      total: 12_345n,
      issueDate: "2085-08-02",
      issued: false,
    });

    const byNumber = await timedSearchAll("INV-2085-0001");
    expect(byNumber.groups.find((group) => group.kind === "invoice")?.hits).toEqual([
      {
        kind: "invoice",
        id: issued.id,
        docType: "invoice",
        number: "INV-2085-0001",
        title: "ウェブ制作",
        partnerName: "架空ミナト探索株式会社",
        total: 330_000n,
        issueDate: "2085-08-01",
        status: "issued",
      },
    ]);
    expect((await hitsOf("ｳｪﾌﾞ制作", "invoice")).map((hit) => hit.id)).toContain(issued.id);
    const byPartner = (await hitsOf("ミナト探索株式会社", "invoice")).map((hit) => hit.id);
    expect(byPartner).toEqual(expect.arrayContaining([issued.id, draft.id]));
    expect((await hitsOf("12,345", "invoice")).map((hit) => hit.id)).toContain(draft.id);
    // The placeholder holds the draft's id: neither 「draft」 nor the id finds it.
    expect((await hitsOf("draft", "invoice")).map((hit) => hit.id)).not.toContain(draft.id);
    expect((await hitsOf(draft.id, "invoice")).map((hit) => hit.id)).not.toContain(draft.id);
  });

  it("finds documents by file name, partner name and note, voided ones included", async () => {
    const receipt = await addDocument({
      originalName: "minato-receipt.pdf",
      partnerName: "ミナトブング",
      txnDate: "2085-09-01",
      amount: 3_980n,
    });
    const voided = await addDocument({
      originalName: "minato-receipt-old.pdf",
      note: "古いスキャン",
      voided: true,
    });
    const hits = await hitsOf("MINATO-RECEIPT", "document");
    expect(hits.map((hit) => hit.id)).toEqual(expect.arrayContaining([receipt.id, voided.id]));
    expect(hits.find((hit) => hit.id === voided.id)).toMatchObject({ status: "voided" });
    expect(hits.find((hit) => hit.id === receipt.id)).toEqual({
      kind: "document",
      id: receipt.id,
      documentKind: "receipt",
      originalName: "minato-receipt.pdf",
      txnDate: "2085-09-01",
      amount: 3_980n,
      partnerName: "ミナトブング",
      status: "inbox",
    });
    expect((await hitsOf("ﾌﾞﾝｸﾞ", "document")).map((hit) => hit.id)).toEqual([receipt.id]);
    expect((await hitsOf("古いスキャン", "document")).map((hit) => hit.id)).toEqual([voided.id]);
  });

  it("takes %, _ and \\ literally", async () => {
    const percent = await addStatement({
      txnDate: "2085-10-01",
      descriptionRaw: "ミナト割引10%OFF",
      amount: -100n,
    });
    await addStatement({
      txnDate: "2085-10-02",
      descriptionRaw: "ミナト割引10XOFF",
      amount: -100n,
    });
    const underscore = await addStatement({
      txnDate: "2085-10-03",
      descriptionRaw: "ミナト_記号",
      amount: -100n,
    });
    await addStatement({ txnDate: "2085-10-04", descriptionRaw: "ミナトA記号", amount: -100n });
    const backslash = await addStatement({
      txnDate: "2085-10-05",
      descriptionRaw: "ミナト\\記号",
      amount: -100n,
    });

    expect((await hitsOf("10%off", "statement")).map((hit) => hit.id)).toEqual([percent.id]);
    expect((await hitsOf("ト_記", "statement")).map((hit) => hit.id)).toEqual([underscore.id]);
    expect((await hitsOf("ト\\記", "statement")).map((hit) => hit.id)).toEqual([backslash.id]);
    expect((await timedSearchAll("%%")).groups).toEqual([]);
  });

  it("counts every match, shows perKind of them and pages one kind", async () => {
    const ids: string[] = [];
    for (let day = 1; day <= 7; day += 1) {
      const row = await addStatement({
        txnDate: `2085-11-0${day}` as CalendarDate,
        descriptionRaw: "ミナト件数テスト",
        amount: -BigInt(day),
      });
      ids.push(row.id);
    }
    const newestFirst = [...ids].reverse();

    const all = await timedSearchAll("ミナト件数テスト");
    expect(all.groups.map((group) => group.kind)).toEqual(["statement"]);
    expect(all.groups[0]).toMatchObject({ kind: "statement", total: 7, period: null });
    expect(all.groups[0]?.hits.map((hit) => hit.id)).toEqual(newestFirst.slice(0, 5));
    const three = await timedSearchAll("ミナト件数テスト", { perKind: 3 });
    expect(three.groups[0]?.hits.map((hit) => hit.id)).toEqual(newestFirst.slice(0, 3));

    const second = await searchKind(prisma, "ミナト件数テスト", "statement", {
      page: 2,
      pageSize: 5,
    });
    expect(second).toMatchObject({ page: 2, pageCount: 2, group: { total: 7 } });
    expect(second.group.hits.map((hit) => hit.id)).toEqual(newestFirst.slice(5));
    const past = await searchKind(prisma, "ミナト件数テスト", "statement", {
      page: 99,
      pageSize: 5,
    });
    expect(past.page).toBe(2);
    expect((await searchKind(prisma, "ミナト件数テスト", "entry")).group).toEqual({
      kind: "entry",
      total: 0,
      hits: [],
      period: null,
    });

    // The entries' group carries the dates of its first and last match (for 「すべて見る」).
    const entries = (await timedSearchAll("ミナト")).groups.find((group) => group.kind === "entry");
    expect(entries?.period).toEqual({ from: "2085-05-01", to: "2085-07-01" });
  });

  it("finds nothing for one character of text, and the order of the kinds is fixed", async () => {
    expect((await timedSearchAll("ミ")).groups).toEqual([]);
    expect((await timedSearchAll("")).groups).toEqual([]);
    const kinds = (await timedSearchAll("ミナト")).groups.map((group) => group.kind);
    expect(kinds).toEqual(SEARCH_KINDS.filter((kind) => kinds.includes(kind)));
    expect(kinds).toEqual(["entry", "statement", "document", "partner", "invoice"]);
  });

  it("reads only: the audit log does not grow, and each search stays under a second", async () => {
    const before = await prisma.auditLog.count();
    for (const input of ["ミナト", "1,650", "No.1", registrationNumber, "INV-2085", "カクウ"]) {
      await timedSearchAll(input);
      for (const kind of SEARCH_KINDS) await searchKind(prisma, input, kind, { page: 1 });
    }
    expect(await prisma.auditLog.count()).toBe(before);
    expect(slowest).toBeLessThan(1_000);
    console.info(`[search] slowest searchAll: ${slowest.toFixed(1)} ms`);
  });
});
