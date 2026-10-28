import { randomBytes } from "node:crypto";
import {
  addDays,
  documentIndexCells,
  inclusiveTaxAmount,
  type CalendarDate,
  type JournalLineInput,
} from "@niho-finance/ledger";
import type { FiscalYear, Partner, PrismaClient, Wallet } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  attachImportBatchDocument,
  countDocuments,
  countInboxDocuments,
  documentSearchSchema,
  exportDocumentIndex,
  findDocumentBySha256,
  findImportBatchDocument,
  findLinkCandidates,
  getDocumentDetail,
  getDocumentFile,
  getRecordsPolicy,
  linkDocument,
  listDocumentLinks,
  loadDocumentIndex,
  newId,
  postJournalEntry,
  registerDocument,
  replaceDocument,
  saveRecordsPolicy,
  searchDocuments,
  SettingsError,
  todayInJapan,
  toDbDate,
  unlinkDocument,
  updateDocument,
  voidDocument,
  voidJournalEntry,
  type DocumentRegisterInput,
  type DocumentSearchInput,
} from "../src";
import { SEED_COMPANY } from "../src/seed";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function newSha256(): string {
  return randomBytes(32).toString("hex");
}

/** Evidence on the seeded book. Each test adds its own documents (other files share the database). */
describe.skipIf(!hasTestDatabase)("documents repository", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let year: FiscalYear;
  let card: Wallet;
  let bank: Wallet;
  let cloud: Partner;
  let design: Partner;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    // A year of its own: the seeded year 1 keeps its 13 entries and its trial balance.
    year = await createFiscalYear(prisma, {
      no: 60,
      startDate: "2040-04-01",
      endDate: "2041-03-31",
    });
    card = await prisma.wallet.findFirstOrThrow({ where: { name: "架空カード" } });
    bank = await prisma.wallet.findFirstOrThrow({ where: { name: "架空銀行 普通" } });
    cloud = await prisma.partner.findFirstOrThrow({ where: { name: "架空クラウド株式会社" } });
    design = await prisma.partner.findFirstOrThrow({ where: { name: "架空デザイン合同会社" } });
  });

  function fileInput(overrides: Partial<DocumentRegisterInput> = {}): DocumentRegisterInput {
    return {
      storageKey: `documents/2040/05/${newId()}.pdf`,
      sha256: newSha256(),
      mime: "application/pdf",
      byteSize: 12_345,
      originalName: "receipt.pdf",
      source: "upload",
      ...overrides,
    };
  }

  async function register(overrides: Partial<DocumentRegisterInput> = {}) {
    const result = await registerDocument(prisma, fileInput(overrides), { actor });
    expect(result.duplicate).toBe(false);
    return result.document;
  }

  async function actionsOf(entityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, actor: true },
    });
    for (const row of rows) expect(row.actor).toBe(actor);
    return rows.map((row) => row.action);
  }

  async function statementLine(
    wallet: Wallet,
    txnDate: CalendarDate,
    amount: bigint,
    status: "pending" | "registered" | "ignored" = "pending",
    counterpartyRaw: string | null = null,
  ) {
    return prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId: wallet.id,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw: "架空ストア",
        counterpartyRaw,
        externalId: `test-s6-${newId()}`,
        status,
      },
    });
  }

  /** An expense paid by card; one debit line per partner (the amount split between them). */
  async function postExpense(entryDate: CalendarDate, amount: bigint, partners: string[] = []) {
    const shares = partners.length === 2 ? [amount / 2n, amount - amount / 2n] : [amount];
    const debits: JournalLineInput[] = shares.map((share, index) => ({
      side: "debit",
      accountId: refs.account("5330"),
      amount: share,
      taxCategoryCode: "purchase_10",
      taxAmount: inclusiveTaxAmount(share, 10),
      segmentId: refs.segment("corporate"),
      partnerId: partners[index] ?? null,
    }));
    return postJournalEntry(
      prisma,
      {
        fiscalYearId: year.id,
        entryDate,
        description: "事務用品",
        kind: "normal",
        sourceKind: "manual",
        lines: [
          ...debits,
          {
            side: "credit",
            accountId: refs.account("2100"),
            subAccountId: refs.subAccount("架空カード"),
            amount,
            taxCategoryCode: "na",
            taxAmount: 0n,
          },
        ],
      },
      { actor },
    );
  }

  describe("registration", () => {
    it("registers a file as an inbox receipt and records document.create", async () => {
      const before = await countDocuments(prisma);
      const inboxBefore = await countInboxDocuments(prisma);
      const document = await register({ originalName: "lunch.pdf" });
      expect(document).toMatchObject({
        kind: "receipt",
        status: "inbox",
        source: "upload",
        mime: "application/pdf",
        byteSize: 12_345,
        originalName: "lunch.pdf",
        uploadedBy: actor,
        txnDate: null,
        amount: null,
        displayPartnerName: null,
        unsorted: true,
        links: [],
        supersedes: null,
        supersededBy: null,
      });
      expect(document.history.map((entry) => entry.action)).toEqual(["document.create"]);
      expect(document.history[0]?.after).toMatchObject({
        sha256: document.sha256,
        byteSize: 12_345,
      });
      expect(await countDocuments(prisma)).toEqual({
        inbox: before.inbox + 1,
        all: before.all + 1,
        voided: before.voided,
      });
      expect(await countInboxDocuments(prisma)).toBe(inboxBefore + 1);
    });

    it("returns the existing document for the same file and writes nothing", async () => {
      const sha256 = newSha256();
      const first = await register({ sha256 });
      const auditBefore = await prisma.auditLog.count();
      const again = await registerDocument(
        prisma,
        fileInput({ sha256: sha256.toUpperCase(), originalName: "same-file.pdf" }),
        { actor },
      );
      expect(again.duplicate).toBe(true);
      expect(again.document.id).toBe(first.id);
      expect(again.document.originalName).toBe("receipt.pdf");
      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect(await findDocumentBySha256(prisma, sha256.toUpperCase())).toMatchObject({
        id: first.id,
      });
      expect(await findDocumentBySha256(prisma, "not-a-hash")).toBeNull();

      // A voided document no longer counts: the same file can be stored again.
      await voidDocument(prisma, { id: first.id, reason: "誤って保存" }, { actor });
      expect(await findDocumentBySha256(prisma, sha256)).toBeNull();
      const stored = await register({ sha256 });
      expect(stored.id).not.toBe(first.id);
    });

    it("stores a file once when two uploads complete at the same time", async () => {
      const sha256 = newSha256();
      const results = await Promise.all([
        registerDocument(prisma, fileInput({ sha256 }), { actor }),
        registerDocument(prisma, fileInput({ sha256 }), { actor }),
      ]);
      expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.document.id)).size).toBe(1);
      expect(await prisma.document.count({ where: { sha256 } })).toBe(1);
    });

    it("validates the file and the items", async () => {
      const gif = await rejectionOf(
        registerDocument(prisma, fileInput({ mime: "image/gif" }), { actor }),
      );
      expect(gif).toBeInstanceOf(ZodError);
      expect((gif as ZodError).issues[0]?.message).toContain("この形式のファイルは保存できません");
      for (const byteSize of [0, 20 * 1024 * 1024 + 1, 1.5]) {
        expect(
          await rejectionOf(registerDocument(prisma, fileInput({ byteSize }), { actor })),
        ).toBeInstanceOf(ZodError);
      }
      expect(
        await rejectionOf(registerDocument(prisma, fileInput({ sha256: "abc" }), { actor })),
      ).toBeInstanceOf(ZodError);
      const negative = await rejectionOf(
        registerDocument(prisma, fileInput({ amount: "-1" }), { actor }),
      );
      expect((negative as ZodError).issues[0]?.message).toBe(
        "金額は 0 以上の円の整数で入力してください",
      );
      const unknownPartner = await rejectionOf(
        registerDocument(prisma, fileInput({ partnerId: newId() }), { actor }),
      );
      expect(unknownPartner).toBeInstanceOf(SettingsError);
      expect(unknownPartner).toMatchObject({ field: "partnerId" });
    });

    it("keeps one of the partner and the free-text name", async () => {
      const document = await register({
        partnerId: cloud.id,
        partnerName: "使われない名前",
        kind: "invoice_in",
        txnDate: "2040-05-02",
        amount: "１，６５０",
        invoiceRegistrationNumber: `t${fictionalCorporateNumber()}`,
      });
      expect(document).toMatchObject({
        kind: "invoice_in",
        partnerId: cloud.id,
        partnerName: null,
        displayPartnerName: "架空クラウド株式会社",
        txnDate: "2040-05-02",
        amount: 1_650n,
        invoiceRegistrationNumber: `T${fictionalCorporateNumber()}`,
        unsorted: false,
      });
    });
  });

  describe("items", () => {
    it("changes the given items only, records before / after, and skips no-op saves", async () => {
      const document = await register();
      const updated = await updateDocument(
        prisma,
        {
          id: document.id,
          kind: "invoice_in",
          txnDate: "2040-05-10",
          amount: "3,980",
          partnerName: "架空文具店",
          note: "備品",
        },
        { actor },
      );
      expect(updated).toMatchObject({
        kind: "invoice_in",
        txnDate: "2040-05-10",
        amount: 3_980n,
        partnerId: null,
        partnerName: "架空文具店",
        displayPartnerName: "架空文具店",
        note: "備品",
        originalName: "receipt.pdf",
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: document.id, action: "document.update" },
      });
      expect(audit.before).toMatchObject({ amount: null, note: null });
      expect(audit.after).toMatchObject({
        amount: "3980",
        note: "備品",
        partnerName: "架空文具店",
      });

      await updateDocument(prisma, { id: document.id, amount: "3980", note: "備品" }, { actor });
      expect(await actionsOf(document.id)).toEqual(["document.create", "document.update"]);

      const withPartner = await updateDocument(
        prisma,
        { id: document.id, partnerId: design.id },
        { actor },
      );
      expect(withPartner).toMatchObject({ partnerId: design.id, partnerName: null });
      const freeName = await updateDocument(
        prisma,
        { id: document.id, partnerName: "架空商店" },
        { actor },
      );
      expect(freeName).toMatchObject({ partnerId: null, partnerName: "架空商店" });
      const cleared = await updateDocument(prisma, { id: document.id, amount: "" }, { actor });
      expect(cleared).toMatchObject({ amount: null, txnDate: "2040-05-10", unsorted: true });
    });

    it("rejects an inactive partner and a malformed registration number", async () => {
      const inactive = await prisma.partner.create({
        data: { id: newId(), name: "架空休眠商事", kind: "vendor", isActive: false },
      });
      const document = await register();
      const error = await rejectionOf(
        updateDocument(prisma, { id: document.id, partnerId: inactive.id }, { actor }),
      );
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).message).toContain("無効にした取引先は選べません");
      const number = await rejectionOf(
        updateDocument(prisma, { id: document.id, invoiceRegistrationNumber: "T123" }, { actor }),
      );
      expect(number).toBeInstanceOf(ZodError);
      expect(
        await rejectionOf(updateDocument(prisma, { id: newId(), note: "x" }, { actor })),
      ).toBeInstanceOf(SettingsError);
    });
  });

  describe("void", () => {
    it("keeps a voided document with its reason, file and links, and freezes it", async () => {
      const line = await statementLine(card, "2040-05-21", -2_200n);
      const document = await register({
        storageKey: `documents/2040/05/${newId()}.jpg`,
        mime: "image/jpeg",
      });
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: document.id },
        { actor },
      );
      const counts = await countDocuments(prisma);
      const voided = await voidDocument(
        prisma,
        { id: document.id, reason: "別の取引の領収書" },
        { actor },
      );
      expect(voided).toMatchObject({ status: "voided", voidReason: "別の取引の領収書" });
      expect(voided.voidedAt).toBeInstanceOf(Date);
      // The file columns and the links stay as they were.
      expect(voided).toMatchObject({
        storageKey: document.storageKey,
        sha256: document.sha256,
        mime: "image/jpeg",
        byteSize: document.byteSize,
      });
      expect(voided.links).toHaveLength(1);
      expect(await getDocumentFile(prisma, document.id)).toMatchObject({
        storageKey: document.storageKey,
        status: "voided",
      });
      // Linked, but without a partner (the line has no counterparty): in the inbox until voided.
      expect(await countDocuments(prisma)).toEqual({
        inbox: counts.inbox - 1,
        all: counts.all,
        voided: counts.voided + 1,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: document.id, action: "document.void" },
      });
      expect(audit).toMatchObject({ reason: "別の取引の領収書", before: { status: "linked" } });

      const target = { kind: "wallet_transaction" as const, id: line.id, documentId: document.id };
      for (const write of [
        () => voidDocument(prisma, { id: document.id, reason: "もう一度" }, { actor }),
        () => updateDocument(prisma, { id: document.id, note: "x" }, { actor }),
        () => linkDocument(prisma, target, { actor }),
        () => unlinkDocument(prisma, target, { actor }),
      ]) {
        expect(await rejectionOf(write())).toBeInstanceOf(SettingsError);
      }
      const frozen = await rejectionOf(
        updateDocument(prisma, { id: document.id, note: "x" }, { actor }),
      );
      expect((frozen as SettingsError).message).toBe(
        "無効にした証憑は変えられません。必要なら差し替えてください",
      );

      // Still listed under the line, with the reason.
      expect(await listDocumentLinks(prisma, { kind: "wallet_transaction", id: line.id })).toEqual([
        expect.objectContaining({
          id: document.id,
          status: "voided",
          voidReason: "別の取引の領収書",
          linkedBy: actor,
        }),
      ]);
      expect(await actionsOf(document.id)).toEqual([
        "document.create",
        "document.link",
        "document.update",
        "document.void",
      ]);
    });
  });

  describe("search", () => {
    const tag = `s6search${Date.now().toString(36)}`;
    const ids: Record<string, string> = {};

    async function search(input: DocumentSearchInput) {
      const filters = documentSearchSchema.parse({ q: tag, ...input });
      const result = await searchDocuments(prisma, filters, { page: filters.page });
      return result.rows.map((row) => Object.keys(ids).find((key) => ids[key] === row.id));
    }

    beforeAll(async () => {
      const make = async (key: string, overrides: Partial<DocumentRegisterInput>) => {
        ids[key] = (await register({ originalName: `${tag}-${key}.pdf`, ...overrides })).id;
      };
      await make("may01", { txnDate: "2040-05-01", amount: 1_000n, partnerId: cloud.id });
      await make("may15", {
        txnDate: "2040-05-15",
        amount: 5_000n,
        partnerName: "架空文具店",
        kind: "invoice_in",
        note: `まとめ買い ${tag}N`,
      });
      await make("jun01", {
        txnDate: "2040-06-01",
        amount: 12_000n,
        partnerName: "架空クラウド サポート",
      });
      await make("undated", { amount: 3_000n });
      await make("noAmount", { txnDate: "2040-05-20" });
      await make("voided", { txnDate: "2040-05-03", amount: 1_000n });
      await voidDocument(prisma, { id: ids.voided ?? "", reason: "重複" }, { actor });
    });

    it("orders the inbox by upload time and the other tabs by date (empty first)", async () => {
      expect(await search({})).toEqual(["noAmount", "undated", "jun01", "may15", "may01"]);
      expect(await search({ tab: "all" })).toEqual([
        "undated",
        "jun01",
        "noAmount",
        "may15",
        "voided",
        "may01",
      ]);
      expect(await search({ tab: "voided" })).toEqual(["voided"]);
      const all = await searchDocuments(prisma, documentSearchSchema.parse({ q: tag, tab: "all" }));
      expect(all.rows.find((row) => row.id === ids.voided)).toMatchObject({
        status: "voided",
        voidReason: "重複",
      });
      // 未整理 includes an empty partner: the voided one has a date and an amount, but no partner.
      expect(
        all.rows.map((row) => [Object.keys(ids).find((key) => ids[key] === row.id), row.unsorted]),
      ).toEqual([
        ["undated", true],
        ["jun01", false],
        ["noAmount", true],
        ["may15", false],
        ["voided", true],
        ["may01", false],
      ]);
    });

    it("filters by a date range; undated documents drop out", async () => {
      expect(await search({ tab: "all", from: "2040-05-01", to: "2040-05-31" })).toEqual([
        "noAmount",
        "may15",
        "voided",
        "may01",
      ]);
      expect(await search({ tab: "all", from: "2040-05-15" })).toEqual([
        "jun01",
        "noAmount",
        "may15",
      ]);
    });

    it("filters by an amount range; documents without an amount drop out", async () => {
      expect(await search({ tab: "all", amountMin: "1,000", amountMax: "5000" })).toEqual([
        "undated",
        "may15",
        "voided",
        "may01",
      ]);
      expect(await search({ tab: "all", amountMin: "5001" })).toEqual(["jun01"]);
    });

    it("filters by the partner's name, the master's or the free-text one", async () => {
      expect(await search({ tab: "all", partner: "クラウド" })).toEqual(["jun01", "may01"]);
      expect(await search({ tab: "all", partner: "文具" })).toEqual(["may15"]);
    });

    it("combines two items and the kind", async () => {
      expect(
        await search({ tab: "all", from: "2040-05-01", to: "2040-05-31", amountMin: "2000" }),
      ).toEqual(["may15"]);
      expect(await search({ tab: "all", kind: "invoice_in" })).toEqual(["may15"]);
      expect(await search({ from: "2040-05-01", amountMax: "1000" })).toEqual(["may01"]);
    });

    it("finds a keyword in the note and the partner name", async () => {
      const byNote = await searchDocuments(prisma, documentSearchSchema.parse({ q: `${tag}N` }));
      expect(byNote.rows.map((row) => row.id)).toEqual([ids.may15]);
      const byPartner = await searchDocuments(
        prisma,
        documentSearchSchema.parse({ q: "サポート", from: "2040-01-01", to: "2040-12-31" }),
      );
      expect(byPartner.rows.map((row) => row.id)).toEqual([ids.jun01]);
    });

    it("pages the results and checks the ranges", async () => {
      const page = await searchDocuments(
        prisma,
        documentSearchSchema.parse({ q: tag, tab: "all" }),
        { page: 2, pageSize: 4 },
      );
      expect(page).toMatchObject({ total: 6, page: 2, pageSize: 4 });
      expect(page.rows.map((row) => row.id)).toEqual([ids.voided, ids.may01]);
      expect(documentSearchSchema.parse({}).page).toBe(1);
      const reversed = documentSearchSchema.safeParse({ from: "2040-05-02", to: "2040-05-01" });
      expect(reversed.success).toBe(false);
      const amounts = documentSearchSchema.safeParse({ amountMin: "10", amountMax: "9" });
      expect(amounts.error?.issues[0]?.path).toEqual(["amountMax"]);
    });
  });

  describe("links", () => {
    it("links a statement line, fills the empty items and is idempotent", async () => {
      const line = await statementLine(card, "2040-05-07", -3_980n);
      const document = await register();
      const linked = await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: document.id },
        { actor },
      );
      expect(linked).toMatchObject({
        status: "linked",
        txnDate: "2040-05-07",
        amount: 3_980n,
        partnerId: null,
        partnerName: null,
      });
      expect(linked.links).toEqual([
        expect.objectContaining({
          kind: "wallet_transaction",
          id: line.id,
          walletName: "架空カード",
          txnDate: "2040-05-07",
          amount: -3_980n,
          status: "pending",
          linkedBy: actor,
        }),
      ]);
      const fill = linked.history.find((entry) => entry.action === "document.update");
      expect(fill).toMatchObject({ reason: "紐づけた明細から補完" });
      expect(fill?.after).toMatchObject({ txnDate: "2040-05-07T00:00:00.000Z", amount: "3980" });
      const link = linked.history.find((entry) => entry.action === "document.link");
      expect(link?.after).toMatchObject({
        kind: "wallet_transaction",
        id: line.id,
        amount: "-3980",
      });

      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: document.id },
        { actor },
      );
      expect(await actionsOf(document.id)).toEqual([
        "document.create",
        "document.link",
        "document.update",
      ]);
      expect(await prisma.documentLink.count({ where: { documentId: document.id } })).toBe(1);
    });

    it("fills the partner name from the line's counterparty when the partner is empty", async () => {
      const line = await statementLine(
        card,
        "2040-05-25",
        -2_750n,
        "pending",
        "  架空ストア 本店  ",
      );
      const document = await register();
      const linked = await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: document.id },
        { actor },
      );
      expect(linked).toMatchObject({
        txnDate: "2040-05-25",
        amount: 2_750n,
        partnerId: null,
        partnerName: "架空ストア 本店",
        displayPartnerName: "架空ストア 本店",
        unsorted: false,
      });
      const fill = linked.history.find((entry) => entry.action === "document.update");
      expect(fill).toMatchObject({ reason: "紐づけた明細から補完" });
      expect(fill?.before).toMatchObject({ partnerName: null, amount: null });
      expect(fill?.after).toMatchObject({ partnerName: "架空ストア 本店", amount: "2750" });

      // A partner of the master stays as it is (no free-text name next to it).
      const withPartner = await register({ partnerId: cloud.id });
      const kept = await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: withPartner.id },
        { actor },
      );
      expect(kept).toMatchObject({ partnerId: cloud.id, partnerName: null, amount: 2_750n });

      // A blank counterparty fills nothing.
      const blank = await statementLine(card, "2040-05-26", -1_000n, "pending", "   ");
      const open = await register();
      const unfilled = await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: blank.id, documentId: open.id },
        { actor },
      );
      expect(unfilled).toMatchObject({
        partnerId: null,
        partnerName: null,
        amount: 1_000n,
        unsorted: true,
      });
    });

    it("fills the debit total and the only partner of an entry, never overwriting items", async () => {
      const entry = await postExpense("2040-05-08", 4_400n, [cloud.id]);
      const dated = await register({ txnDate: "2040-05-09" });
      const filled = await linkDocument(
        prisma,
        { kind: "journal_entry", id: entry.id, documentId: dated.id },
        { actor },
      );
      expect(filled).toMatchObject({ txnDate: "2040-05-09", amount: 4_400n, partnerId: cloud.id });
      expect(filled.links[0]).toMatchObject({
        kind: "journal_entry",
        fiscalYearNo: 60,
        no: entry.no,
        description: "事務用品",
        amount: 4_400n,
        status: "posted",
      });

      const named = await register({ partnerName: "架空商店", amount: 4_000n });
      const kept = await linkDocument(
        prisma,
        { kind: "journal_entry", id: entry.id, documentId: named.id },
        { actor },
      );
      expect(kept).toMatchObject({
        partnerId: null,
        partnerName: "架空商店",
        amount: 4_000n,
        txnDate: "2040-05-08",
      });

      const shared = await postExpense("2040-05-08", 6_000n, [cloud.id, design.id]);
      const open = await register();
      const two = await linkDocument(
        prisma,
        { kind: "journal_entry", id: shared.id, documentId: open.id },
        { actor },
      );
      expect(two).toMatchObject({ partnerId: null, amount: 6_000n });

      const complete = await register({
        txnDate: "2040-05-08",
        amount: 6_000n,
        partnerId: design.id,
      });
      await linkDocument(
        prisma,
        { kind: "journal_entry", id: shared.id, documentId: complete.id },
        { actor },
      );
      expect(await actionsOf(complete.id)).toEqual(["document.create", "document.link"]);
    });

    it("unlinks back to the inbox when the last link goes", async () => {
      const line = await statementLine(bank, "2040-05-12", -1_100n);
      const entry = await postExpense("2040-05-12", 1_100n);
      const document = await register();
      for (const target of [
        { kind: "wallet_transaction" as const, id: line.id },
        { kind: "journal_entry" as const, id: entry.id },
      ]) {
        await linkDocument(prisma, { ...target, documentId: document.id }, { actor });
      }
      const one = await unlinkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: document.id },
        { actor },
      );
      expect(one.status).toBe("linked");
      expect(one.links.map((link) => link.kind)).toEqual(["journal_entry"]);
      const none = await unlinkDocument(
        prisma,
        { kind: "journal_entry", id: entry.id, documentId: document.id },
        { actor },
      );
      expect(none).toMatchObject({ status: "inbox", links: [], amount: 1_100n });
      const unlink = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: document.id, action: "document.unlink" },
        orderBy: { id: "asc" },
      });
      expect(unlink.before).toMatchObject({
        kind: "wallet_transaction",
        id: line.id,
        walletName: "架空銀行 普通",
      });

      // Removing a link that is not there changes nothing.
      const auditBefore = await prisma.auditLog.count({ where: { entityId: document.id } });
      await unlinkDocument(
        prisma,
        { kind: "journal_entry", id: entry.id, documentId: document.id },
        { actor },
      );
      expect(await prisma.auditLog.count({ where: { entityId: document.id } })).toBe(auditBefore);
      expect(await listDocumentLinks(prisma, { kind: "journal_entry", id: entry.id })).toEqual([]);
    });

    it("rejects a missing target or document", async () => {
      const document = await register();
      const missingLine = await rejectionOf(
        linkDocument(
          prisma,
          { kind: "wallet_transaction", id: newId(), documentId: document.id },
          { actor },
        ),
      );
      expect(missingLine).toBeInstanceOf(SettingsError);
      expect(missingLine).toMatchObject({
        message: "紐づける先の明細が見つかりません。画面を読み込み直してください",
        field: "id",
      });
      const missingEntry = await rejectionOf(
        linkDocument(
          prisma,
          { kind: "journal_entry", id: newId(), documentId: document.id },
          { actor },
        ),
      );
      expect((missingEntry as SettingsError).message).toContain("紐づける先の仕訳");
      const missingInvoice = await rejectionOf(
        linkDocument(prisma, { kind: "invoice", id: newId(), documentId: document.id }, { actor }),
      );
      expect((missingInvoice as SettingsError).message).toContain("紐づける先の請求書");
      const missingDocument = await rejectionOf(
        linkDocument(
          prisma,
          { kind: "journal_entry", id: newId(), documentId: newId() },
          { actor },
        ),
      );
      expect((missingDocument as SettingsError).message).toBe(
        "証憑が見つかりません。画面を読み込み直してください",
      );
      expect(
        await rejectionOf(
          linkDocument(
            prisma,
            { kind: "other", id: newId(), documentId: document.id },
            {
              actor,
            },
          ),
        ),
      ).toBeInstanceOf(ZodError);
      expect((await getDocumentDetail(prisma, document.id))?.status).toBe("inbox");
    });
  });

  describe("inbox", () => {
    it("holds documents not linked yet and linked ones with an empty item, never voided ones", async () => {
      const tag = `s6inbox${Date.now().toString(36)}`;
      const before = await countDocuments(prisma);
      expect(await countInboxDocuments(prisma)).toBe(before.inbox);

      const waiting = await register({ originalName: `${tag}-waiting.pdf` });
      // Linked to a line without a counterparty: date and amount are filled, the partner is not.
      const partial = await register({ originalName: `${tag}-partial.pdf` });
      const nameless = await statementLine(card, "2040-06-10", -1_320n);
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: nameless.id, documentId: partial.id },
        { actor },
      );
      // Linked to a line with a counterparty: all three items are recorded.
      const complete = await register({ originalName: `${tag}-complete.pdf` });
      const named = await statementLine(card, "2040-06-11", -2_640n, "pending", "架空商店");
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: named.id, documentId: complete.id },
        { actor },
      );
      const voided = await register({ originalName: `${tag}-voided.pdf` });
      await voidDocument(prisma, { id: voided.id, reason: "重複" }, { actor });

      const inbox = async () =>
        (await searchDocuments(prisma, documentSearchSchema.parse({ q: tag }))).rows.map((row) => [
          row.id,
          row.status,
          row.unsorted,
        ]);
      // By upload time: the partly recorded one stays although it is linked.
      expect(await inbox()).toEqual([
        [partial.id, "linked", true],
        [waiting.id, "inbox", true],
      ]);
      expect(await getDocumentDetail(prisma, complete.id)).toMatchObject({
        status: "linked",
        unsorted: false,
      });

      const counts = await countDocuments(prisma);
      expect(counts).toEqual({
        inbox: before.inbox + 2,
        all: before.all + 4,
        voided: before.voided + 1,
      });
      expect(await countInboxDocuments(prisma)).toBe(counts.inbox);
      const tab = await searchDocuments(prisma, documentSearchSchema.parse({}), { pageSize: 1 });
      expect(tab.total).toBe(counts.inbox);

      // Recording the partner takes it out of the inbox; it stays linked.
      await updateDocument(prisma, { id: partial.id, partnerName: "架空商店" }, { actor });
      expect(await inbox()).toEqual([[waiting.id, "inbox", true]]);
      expect(await countInboxDocuments(prisma)).toBe(counts.inbox - 1);
      expect((await countDocuments(prisma)).inbox).toBe(counts.inbox - 1);
    });
  });

  describe("candidates", () => {
    it("lists lines and entries of the same amount within ±7 days, nearest first", async () => {
      const amount = 7_777n;
      const document = await register({ txnDate: "2040-07-10", amount });
      const near = await statementLine(card, "2040-07-12", -amount);
      const edge = await statementLine(card, "2040-07-03", -amount);
      const registered = await statementLine(bank, "2040-07-10", amount, "registered");
      await statementLine(card, "2040-07-18", -amount); // 8 days
      await statementLine(card, "2040-07-11", -(amount + 1n)); // another amount
      await statementLine(card, "2040-07-10", -amount, "ignored");
      const close = await postExpense("2040-07-09", amount);
      const late = await postExpense("2040-07-17", amount);
      const cancelled = await postExpense("2040-07-10", amount);
      await voidJournalEntry(prisma, cancelled.id, { actor, reason: "二重登録" });
      await postExpense("2040-07-10", 7_000n);

      const candidates = await findLinkCandidates(prisma, { documentId: document.id });
      expect(candidates.basis).toBe("amount");
      expect(
        candidates.walletTransactions.map((line) => [line.id, line.status, line.daysApart]),
      ).toEqual([
        [near.id, "pending", 2],
        [edge.id, "pending", 7],
        [registered.id, "registered", 0],
      ]);
      expect(candidates.walletTransactions[0]).toMatchObject({
        walletName: "架空カード",
        amount: -amount,
        description: "架空ストア",
      });
      expect(candidates.journalEntries.map((entry) => [entry.id, entry.daysApart])).toEqual([
        [close.id, 1],
        [late.id, 7],
      ]);
      expect(candidates.journalEntries[0]).toMatchObject({
        fiscalYearNo: 60,
        no: close.no,
        amount,
      });

      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: near.id, documentId: document.id },
        { actor },
      );
      await linkDocument(
        prisma,
        { kind: "journal_entry", id: close.id, documentId: document.id },
        { actor },
      );
      const after = await findLinkCandidates(prisma, { documentId: document.id });
      expect(after.walletTransactions.map((line) => line.id)).toEqual([edge.id, registered.id]);
      expect(after.journalEntries.map((entry) => entry.id)).toEqual([late.id]);
    });

    it("without an amount, lists pending lines of any amount within ±7 days of the date", async () => {
      const document = await register({ txnDate: "2040-11-10" });
      const same = await statementLine(card, "2040-11-10", -500n);
      const laterDeposit = await statementLine(bank, "2040-11-13", 12_000n);
      const earlier = await statementLine(card, "2040-11-07", -9_999n);
      const edge = await statementLine(card, "2040-11-17", -100n);
      await statementLine(card, "2040-11-11", -500n, "registered");
      await statementLine(card, "2040-11-11", -500n, "ignored");
      await statementLine(card, "2040-11-18", -500n); // 8 days after
      await statementLine(card, "2040-11-02", -500n); // 8 days before
      await postExpense("2040-11-10", 500n);
      // An already linked line is left out (linking filled the amount; it is cleared again).
      const linked = await statementLine(card, "2040-11-12", -700n);
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: linked.id, documentId: document.id },
        { actor },
      );
      await updateDocument(prisma, { id: document.id, amount: "" }, { actor });

      const candidates = await findLinkCandidates(prisma, { documentId: document.id });
      expect(candidates.basis).toBe("date");
      // Nearest first; at the same distance the newer first.
      expect(
        candidates.walletTransactions.map((line) => [line.id, line.status, line.daysApart]),
      ).toEqual([
        [same.id, "pending", 0],
        [laterDeposit.id, "pending", 3],
        [earlier.id, "pending", 3],
        [edge.id, "pending", 7],
      ]);
      expect(candidates.walletTransactions[1]).toMatchObject({
        walletName: "架空銀行 普通",
        amount: 12_000n,
      });
      expect(candidates.journalEntries).toEqual([]);
    });

    it("puts lines and entries another document already evidences last, marked", async () => {
      const amount = 6_543n;
      const document = await register({ txnDate: "2040-08-10", amount });
      const evidenced = await statementLine(card, "2040-08-10", -amount);
      const plain = await statementLine(card, "2040-08-13", -amount);
      const voidedOnly = await statementLine(card, "2040-08-14", -amount);
      const evidencedEntry = await postExpense("2040-08-10", amount);
      const plainEntry = await postExpense("2040-08-12", amount);
      const other = await register({ txnDate: "2040-08-10", amount });
      for (const [kind, id] of [
        ["wallet_transaction", evidenced.id],
        ["journal_entry", evidencedEntry.id],
      ] as const) {
        await linkDocument(prisma, { kind, id, documentId: other.id }, { actor });
      }
      // A voided document does not count as evidence.
      const gone = await register({ txnDate: "2040-08-14", amount });
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: voidedOnly.id, documentId: gone.id },
        { actor },
      );
      await voidDocument(prisma, { id: gone.id, reason: "誤り" }, { actor });

      const candidates = await findLinkCandidates(prisma, { documentId: document.id });
      expect(candidates.walletTransactions.map((line) => [line.id, line.documentCount])).toEqual([
        [plain.id, 0],
        [voidedOnly.id, 0],
        [evidenced.id, 1],
      ]);
      expect(candidates.journalEntries.map((entry) => [entry.id, entry.documentCount])).toEqual([
        [plainEntry.id, 0],
        [evidencedEntry.id, 1],
      ]);

      // Without an amount the same order holds among the pending lines.
      await updateDocument(prisma, { id: document.id, amount: "" }, { actor });
      const byDate = await findLinkCandidates(prisma, { documentId: document.id });
      expect(byDate.basis).toBe("date");
      expect(byDate.walletTransactions.at(-1)).toMatchObject({
        id: evidenced.id,
        documentCount: 1,
      });
    });

    it("shows at most 10 lines", async () => {
      const document = await register({ txnDate: "2041-01-15" });
      const byOffset = new Map<number, string>();
      for (let offset = -6; offset <= 5; offset += 1) {
        const line = await statementLine(
          card,
          addDays("2041-01-15", offset),
          -(1_000n + BigInt(offset + 6)),
        );
        byOffset.set(offset, line.id);
      }
      const candidates = await findLinkCandidates(prisma, { documentId: document.id });
      expect(candidates.walletTransactions.map((line) => line.id)).toEqual(
        [0, 1, -1, 2, -2, 3, -3, 4, -4, 5].map((offset) => byOffset.get(offset)),
      );
    });

    it("uses the upload day without a date: 30 days back with an amount, 7 back to the next day without", async () => {
      const today = todayInJapan();
      const line = (days: number, amount: bigint, status?: "registered") =>
        statementLine(card, addDays(today, days), amount, status);
      await line(-31, -8_888n);
      const eightBefore = await line(-8, -8_888n);
      const sevenBefore = await line(-7, -1_234n);
      const fiveBefore = await line(-5, -8_888n);
      const sameDay = await line(0, 500n);
      const nextDay = await line(1, -8_888n);
      await line(2, -300n);
      const registered = await line(-1, -8_888n, "registered");

      const priced = await register({ amount: 8_888n });
      const byAmount = await findLinkCandidates(prisma, { documentId: priced.id });
      expect(byAmount.basis).toBe("amount");
      expect(byAmount.walletTransactions.map((item) => [item.id, item.daysApart])).toEqual([
        [fiveBefore.id, 5],
        [eightBefore.id, 8],
        [registered.id, 1],
      ]);

      const unpriced = await register();
      const byDate = await findLinkCandidates(prisma, { documentId: unpriced.id });
      expect(byDate.basis).toBe("date");
      expect(byDate.walletTransactions.map((item) => [item.id, item.daysApart])).toEqual([
        [sameDay.id, 0],
        [nextDay.id, 1],
        [fiveBefore.id, 5],
        [sevenBefore.id, 7],
      ]);
      expect(byDate.journalEntries).toEqual([]);

      await voidDocument(prisma, { id: priced.id, reason: "重複" }, { actor });
      expect(await findLinkCandidates(prisma, { documentId: priced.id })).toEqual({
        basis: "amount",
        walletTransactions: [],
        journalEntries: [],
      });
      expect(await rejectionOf(findLinkCandidates(prisma, { documentId: newId() }))).toBeInstanceOf(
        SettingsError,
      );
    });
  });

  describe("replacement", () => {
    it("inherits the items and the links, voids the original and chains", async () => {
      const line = await statementLine(card, "2040-08-05", -9_900n);
      const entry = await postExpense("2040-08-05", 9_900n);
      const registrationNumber = `T${fictionalCorporateNumber("999999999998")}`;
      const original = await register({
        kind: "invoice_in",
        txnDate: "2040-08-05",
        amount: 9_900n,
        partnerName: "架空印刷所",
        invoiceRegistrationNumber: registrationNumber,
        note: "名刺",
        originalName: "invoice-v1.pdf",
      });
      for (const target of [
        { kind: "wallet_transaction" as const, id: line.id },
        { kind: "journal_entry" as const, id: entry.id },
      ]) {
        await linkDocument(prisma, { ...target, documentId: original.id }, { actor });
      }

      const replaced = await replaceDocument(
        prisma,
        {
          id: original.id,
          reason: "取引先からの再発行",
          replacement: {
            storageKey: `documents/2040/08/${newId()}.pdf`,
            sha256: newSha256(),
            mime: "application/pdf",
            byteSize: 23_456,
            originalName: "invoice-v2.pdf",
            source: "upload",
          },
        },
        { actor },
      );
      expect(replaced.duplicate).toBe(false);
      const second = replaced.document;
      expect(second).toMatchObject({
        kind: "invoice_in",
        status: "linked",
        txnDate: "2040-08-05",
        amount: 9_900n,
        partnerName: "架空印刷所",
        invoiceRegistrationNumber: registrationNumber,
        note: "名刺",
        originalName: "invoice-v2.pdf",
        byteSize: 23_456,
        supersedes: { id: original.id, originalName: "invoice-v1.pdf" },
        supersededBy: null,
      });
      expect(second.links.map((link) => [link.kind, link.id])).toEqual([
        ["wallet_transaction", line.id],
        ["journal_entry", entry.id],
      ]);
      expect(second.history.map((item) => [item.action, item.reason])).toEqual([
        ["document.create", "差し替え: 取引先からの再発行"],
        ["document.link", null],
        ["document.link", null],
      ]);

      const voided = await getDocumentDetail(prisma, original.id);
      expect(voided).toMatchObject({
        status: "voided",
        voidReason: "差し替え: 取引先からの再発行",
        supersededBy: { id: second.id, originalName: "invoice-v2.pdf" },
      });
      expect(voided?.links).toHaveLength(2);
      expect(voided?.history.at(-1)).toMatchObject({
        action: "document.void",
        reason: "差し替え: 取引先からの再発行",
      });

      // The replacement's items win; the chain goes on.
      const third = (
        await replaceDocument(
          prisma,
          {
            id: second.id,
            reason: "金額の訂正版",
            replacement: {
              storageKey: `documents/2040/08/${newId()}.png`,
              sha256: newSha256(),
              mime: "image/png",
              byteSize: 999,
              originalName: "invoice-v3.png",
              source: "camera",
              amount: "9,800",
              partnerId: cloud.id,
            },
          },
          { actor },
        )
      ).document;
      expect(third).toMatchObject({
        amount: 9_800n,
        partnerId: cloud.id,
        partnerName: null,
        kind: "invoice_in",
        source: "camera",
        supersedes: { id: second.id },
      });
      expect(await getDocumentDetail(prisma, second.id)).toMatchObject({
        status: "voided",
        supersedes: { id: original.id },
        supersededBy: { id: third.id },
      });

      const again = await rejectionOf(
        replaceDocument(
          prisma,
          {
            id: original.id,
            reason: "x",
            replacement: {
              storageKey: `documents/2040/08/${newId()}.pdf`,
              sha256: newSha256(),
              mime: "application/pdf",
              byteSize: 1,
              source: "upload",
            },
          },
          { actor },
        ),
      );
      expect(again).toBeInstanceOf(SettingsError);
      expect((again as SettingsError).message).toContain("無効にした証憑は差し替えられません");
    });

    it("returns the existing document for a file already stored, writing nothing", async () => {
      const other = await register();
      const target = await register();
      const auditBefore = await prisma.auditLog.count();
      const result = await replaceDocument(
        prisma,
        {
          id: target.id,
          reason: "再発行",
          replacement: {
            storageKey: `documents/2040/08/${newId()}.pdf`,
            sha256: other.sha256,
            mime: "application/pdf",
            byteSize: other.byteSize,
            source: "upload",
          },
        },
        { actor },
      );
      expect(result).toMatchObject({ duplicate: true, document: { id: other.id } });
      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect((await getDocumentDetail(prisma, target.id))?.status).toBe("inbox");
      const missingReason = await rejectionOf(
        replaceDocument(
          prisma,
          {
            id: target.id,
            reason: " ",
            replacement: {
              storageKey: `documents/2040/08/${newId()}.pdf`,
              sha256: newSha256(),
              mime: "application/pdf",
              byteSize: 1,
              source: "upload",
            },
          },
          { actor },
        ),
      );
      expect((missingReason as ZodError).issues[0]?.message).toBe("理由を入力してください");
    });
  });

  describe("index", () => {
    it("loads the rows with the entry numbers and the lines, and records the export", async () => {
      const tag = `s6index${Date.now().toString(36)}`;
      const line = await statementLine(card, "2040-09-01", -5_500n);
      const entry = await postExpense("2040-09-01", 5_500n, [design.id]);
      const linked = await register({ originalName: `${tag}-linked.pdf`, note: "会議費" });
      await linkDocument(
        prisma,
        { kind: "wallet_transaction", id: line.id, documentId: linked.id },
        { actor },
      );
      await linkDocument(
        prisma,
        { kind: "journal_entry", id: entry.id, documentId: linked.id },
        { actor },
      );
      const voided = await register({ originalName: `${tag}-voided.pdf` });
      await voidDocument(prisma, { id: voided.id, reason: "重複" }, { actor });

      const filters = documentSearchSchema.parse({ q: tag });
      const rows = await loadDocumentIndex(prisma, filters);
      expect(rows.map((row) => row.id)).toEqual([voided.id, linked.id]);
      const [voidedRow, linkedRow] = rows;
      expect(linkedRow).toMatchObject({
        storageKey: linked.storageKey,
        txnDate: "2040-09-01",
        amount: 5_500n,
        // Filled from the entry's only partner when it was linked.
        partnerName: "架空デザイン合同会社",
        status: "linked",
        journalEntries: [{ fiscalYearNo: 60, no: entry.no }],
        walletTransactions: [{ walletName: "架空カード", txnDate: "2040-09-01", amount: -5_500n }],
        uploadedBy: actor,
        note: "会議費",
      });
      expect(voidedRow).toMatchObject({ status: "voided", voidReason: "重複" });
      const cells = documentIndexCells(linkedRow!);
      expect(cells[8]).toBe(`第60期 No.${entry.no}`);
      expect(cells[9]).toBe("架空カード 2040/09/01 5,500");

      expect(
        await loadDocumentIndex(prisma, documentSearchSchema.parse({ q: tag, tab: "inbox" })),
      ).toEqual([]);
      const exported = await exportDocumentIndex(prisma, filters, { actor });
      expect(exported).toHaveLength(2);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "document.export" },
        orderBy: { id: "desc" },
      });
      expect(audit).toMatchObject({ actor, entity: "document", entityId: null });
      expect(audit.after).toEqual({
        filters: {
          tab: "all",
          from: null,
          to: null,
          amountMin: null,
          amountMax: null,
          partner: null,
          kind: null,
          q: tag,
        },
        count: 2,
      });
    });
  });

  describe("records policy", () => {
    it("puts the policy in force with defaults and records records_policy.save", async () => {
      const company = await prisma.company.findFirstOrThrow();
      expect(await getRecordsPolicy(prisma)).toEqual({
        effectiveOn: null,
        manager: null,
        operator: null,
        version: null,
        companyName: SEED_COMPANY.name,
        representative: SEED_COMPANY.representative,
      });
      const saved = await saveRecordsPolicy(
        prisma,
        { effectiveOn: "2026-11-10", version: "2026-10" },
        { actor },
      );
      expect(saved).toMatchObject({
        effectiveOn: "2026-11-10",
        manager: SEED_COMPANY.representative,
        operator: SEED_COMPANY.representative,
        version: "2026-10",
      });
      const audits = () =>
        prisma.auditLog.findMany({
          where: { entityId: company.id, action: "records_policy.save" },
          orderBy: { id: "asc" },
        });
      const [first] = await audits();
      expect(first).toMatchObject({
        actor,
        entity: "company",
        before: { effectiveOn: null, manager: null, operator: null, version: null },
        after: {
          effectiveOn: "2026-11-10",
          manager: SEED_COMPANY.representative,
          version: "2026-10",
        },
      });

      await saveRecordsPolicy(prisma, { effectiveOn: "2026-11-10", version: "2026-10" }, { actor });
      expect(await audits()).toHaveLength(1);

      const changed = await saveRecordsPolicy(
        prisma,
        { effectiveOn: "2026-11-10", manager: "架空 花子", operator: "", version: "2026-10" },
        { actor },
      );
      expect(changed).toMatchObject({ manager: "架空 花子", operator: "架空 花子" });
      expect(await audits()).toHaveLength(2);
      expect(
        await rejectionOf(
          saveRecordsPolicy(prisma, { effectiveOn: "", version: "2026-10" }, { actor }),
        ),
      ).toBeInstanceOf(ZodError);
    });
  });

  describe("files of imports (S4)", () => {
    async function importBatch(wallet: Wallet, periodTo: CalendarDate | null) {
      return prisma.importBatch.create({
        data: {
          id: newId(),
          walletId: wallet.id,
          source: "csv",
          importer: "generic",
          originalName: "statement.csv",
          fileSha256: newSha256(),
          fileBytes: Buffer.from("日付,金額\n2040-09-15,-500\n"),
          periodFrom: periodTo ? toDbDate(addDays(periodTo, -29)) : null,
          periodTo: periodTo ? toDbDate(periodTo) : null,
          executedBy: actor,
        },
      });
    }

    const csvFile = (): Partial<DocumentRegisterInput> => ({
      storageKey: `documents/2040/10/${newId()}.csv`,
      mime: "text/csv",
      kind: "statement",
      originalName: "statement.csv",
    });

    it("keeps an import's CSV as a linked document, out of the inbox", async () => {
      const batch = await importBatch(card, "2040-09-30");
      const document = await register(csvFile());
      const before = await countInboxDocuments(prisma);

      const attached = await attachImportBatchDocument(
        prisma,
        { batchId: batch.id, documentId: document.id },
        { actor },
      );
      expect(attached).toMatchObject({
        status: "linked",
        txnDate: "2040-09-30",
        amount: null,
        partnerId: null,
        partnerName: "架空カード",
        unsorted: false,
      });
      expect(attached.importBatches).toEqual([
        {
          id: batch.id,
          walletName: "架空カード",
          periodFrom: "2040-09-01",
          periodTo: "2040-09-30",
          importedCount: 0,
        },
      ]);
      expect(await countInboxDocuments(prisma)).toBe(before - 1);
      expect(await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject(
        { documentId: document.id, fileBytes: null },
      );
      expect(await findImportBatchDocument(prisma, batch.id)).toMatchObject({ id: document.id });
      const link = attached.history.find((entry) => entry.action === "document.link");
      expect(link?.after).toMatchObject({ kind: "import_batch", id: batch.id });
      const fill = attached.history.find((entry) => entry.action === "document.update");
      expect(fill).toMatchObject({ reason: "取込の明細から補完" });

      // Attaching the same file again changes nothing; another file for the batch is refused.
      await attachImportBatchDocument(
        prisma,
        { batchId: batch.id, documentId: document.id },
        { actor },
      );
      expect(await actionsOf(document.id)).toEqual([
        "document.create",
        "document.link",
        "document.update",
      ]);
      const other = await register();
      expect(
        await rejectionOf(
          attachImportBatchDocument(prisma, { batchId: batch.id, documentId: other.id }, { actor }),
        ),
      ).toBeInstanceOf(SettingsError);

      // Removing its last statement-line link keeps it linked: the import still holds it.
      const line = await statementLine(card, "2040-09-15", -500n);
      const target = { kind: "wallet_transaction" as const, id: line.id, documentId: document.id };
      await linkDocument(prisma, target, { actor });
      expect((await unlinkDocument(prisma, target, { actor })).status).toBe("linked");
    });

    it("moves an import's file to its replacement", async () => {
      const batch = await importBatch(bank, null);
      const document = await register(csvFile());
      const attached = await attachImportBatchDocument(
        prisma,
        { batchId: batch.id, documentId: document.id },
        { actor },
      );
      expect(attached).toMatchObject({ txnDate: null, partnerName: "架空銀行 普通" });

      const { document: replacement } = await replaceDocument(
        prisma,
        {
          id: document.id,
          reason: "取り直した明細",
          replacement: {
            storageKey: `documents/2040/10/${newId()}.csv`,
            sha256: newSha256(),
            mime: "text/csv",
            byteSize: 40,
            source: "upload",
          },
        },
        { actor },
      );
      expect(replacement).toMatchObject({ status: "linked", kind: "statement", unsorted: false });
      expect(replacement.importBatches.map((item) => item.id)).toEqual([batch.id]);
      expect(await findImportBatchDocument(prisma, batch.id)).toMatchObject({
        id: replacement.id,
      });
      expect(await getDocumentDetail(prisma, document.id)).toMatchObject({
        status: "voided",
        importBatches: [],
      });
    });
  });

  describe("DB guards of documents", () => {
    it("never restores a voided document nor rewrites its void", async () => {
      const document = await register();
      await voidDocument(prisma, { id: document.id, reason: "誤り" }, { actor });
      await expect(
        prisma.document.update({
          where: { id: document.id },
          data: { status: "inbox", voidedAt: null, voidReason: null },
        }),
      ).rejects.toThrow(/ledger guard: document .* is voided and cannot be restored/);
      await expect(
        prisma.document.update({ where: { id: document.id }, data: { voidReason: "別の理由" } }),
      ).rejects.toThrow(/ledger guard: void_reason of document .* is already set/);
      await expect(
        prisma.document.update({ where: { id: document.id }, data: { voidedAt: new Date() } }),
      ).rejects.toThrow(/ledger guard: voided_at of document .* is already set/);
      // Items of a voided document are the repository's to freeze; the guard keeps the void.
      await prisma.document.update({ where: { id: document.id }, data: { note: "直接" } });
    });

    it("requires the void fields together (CHECK document_void_fields)", async () => {
      const document = await register();
      await expect(
        prisma.document.update({
          where: { id: document.id },
          data: { status: "voided", voidedAt: new Date() },
        }),
      ).rejects.toThrow(/document_void_fields/);
      await expect(
        prisma.document.update({
          where: { id: document.id },
          data: { status: "voided", voidReason: "理由" },
        }),
      ).rejects.toThrow(/document_void_fields/);
      await expect(
        prisma.document.update({ where: { id: document.id }, data: { voidedAt: new Date() } }),
      ).rejects.toThrow(/document_void_fields/);
    });

    it("keeps the replaced document once set", async () => {
      const original = await register();
      const other = await register();
      const replacement = await replaceDocument(
        prisma,
        {
          id: original.id,
          reason: "再発行",
          replacement: {
            storageKey: `documents/2040/10/${newId()}.pdf`,
            sha256: newSha256(),
            mime: "application/pdf",
            byteSize: 10,
            source: "upload",
          },
        },
        { actor },
      );
      await expect(
        prisma.document.update({
          where: { id: replacement.document.id },
          data: { supersedesId: other.id },
        }),
      ).rejects.toThrow(/ledger guard: supersedes_id of document .* is already set/);
      await expect(
        prisma.document.delete({ where: { id: replacement.document.id } }),
      ).rejects.toThrow(/document .* cannot be deleted/);
    });
  });
});
