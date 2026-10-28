import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createFixtureNtaLookup,
  FIXTURE_NTA_REGISTRATIONS,
  type NtaLookup,
} from "@niho-finance/importers";
import { isValidInvoiceRegistrationNumber, type CalendarDate } from "@niho-finance/ledger";
import {
  createRecordedReader,
  loadRecordingFile,
  ReaderError,
  type ProviderResult,
  type ProviderUsage,
  type ReaderProvider,
} from "@niho-finance/reader";
import type { Partner, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyDocumentReading,
  buildReadingProposal,
  countUnreadInboxDocuments,
  findReadingDuplicates,
  getDocumentReading,
  listUnreadInboxDocuments,
  loadReadingStates,
  newId,
  performDocumentReading,
  recordApiUsage,
  recordDocumentReading,
  registerDocument,
  SettingsError,
  summarizeApiUsage,
  voidDocument,
  type DocumentReadingDeps,
  type DocumentRegisterInput,
  type ProposalRow,
  type ReadingProposal,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";

const actor = "tester@example.com";
const TODAY: CalendarDate = "2026-10-28";
const HAIKU_USAGE: ProviderUsage = { inputTokens: 2_000, outputTokens: 1_000 };
const RECEIPTS = new URL("../../reader/fixtures/receipts/", import.meta.url);

function newSha256(): string {
  return randomBytes(32).toString("hex");
}

/** `T` + a fictional corporate number (a base of 9s with its check digit). */
function fictionalRegistrationNumber(): string {
  return `T${fictionalCorporateNumber(`9999${String(randomInt(0, 100_000_000)).padStart(8, "0")}`)}`;
}

/** A unique yen total, so readings of different tests never look like duplicates. */
function uniqueTotal(): number {
  return 10_000 + randomInt(0, 80_000_000);
}

/** The provider's answer (20-reader §3) with one 10% line equal to the total. */
function answer(fields: {
  issuerName: string | null;
  totalAmount: number | null;
  registrationNumber?: string | null;
  transactionDate?: string | null;
  documentType?: "receipt" | "invoice" | "other";
  currency?: string;
  description?: string | null;
  rates?: { ratePercent: 10 | 8 | 0; amount: number; taxIncluded: boolean; taxAmount: null }[];
}): Record<string, unknown> {
  return {
    documentType: fields.documentType ?? "receipt",
    legible: true,
    issuerName: fields.issuerName,
    registrationNumber: fields.registrationNumber ?? null,
    transactionDate: fields.transactionDate === undefined ? "2026-10-05" : fields.transactionDate,
    currency: fields.currency ?? "JPY",
    totalAmount: fields.totalAmount,
    rates:
      fields.rates ??
      (fields.totalAmount === null
        ? []
        : [{ ratePercent: 10, amount: fields.totalAmount, taxIncluded: true, taxAmount: null }]),
    description: fields.description === undefined ? "会議用の弁当" : fields.description,
  };
}

type FakeReader = ReaderProvider & { calls: number };

/** A provider answering `result` (or throwing it) whatever the file. */
function fakeReader(
  result: () => ProviderResult,
  options: { provider?: "anthropic" | "recorded"; model?: string } = {},
): FakeReader {
  const reader: FakeReader = {
    provider: options.provider ?? "anthropic",
    model: options.model ?? "claude-haiku-5-5",
    calls: 0,
    read() {
      reader.calls += 1;
      return Promise.resolve().then(result);
    },
  };
  return reader;
}

function answering(raw: unknown, usage: ProviderUsage = HAIKU_USAGE): FakeReader {
  return fakeReader(() => ({ raw, usage }));
}

/** Records the numbers each lookup was asked for. */
function spyLookup(inner: NtaLookup): NtaLookup & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    lookup(numbers) {
      calls.push([...numbers]);
      return inner.lookup(numbers);
    },
  };
}

function rowOf(proposal: ReadingProposal | null, field: ProposalRow["field"]): ProposalRow {
  const row = proposal?.rows.find((candidate) => candidate.field === field);
  if (!row) throw new Error(`no ${field} row`);
  return row;
}

/** Readings on the seeded book. Each test adds its own documents and partners. */
describe.skipIf(!hasTestDatabase)("reading repository", () => {
  let prisma: PrismaClient;
  /** Matched by its registration number. */
  let numbered: Partner;
  /** Matched by its name (`株式会社` and spaces aside). */
  let named: Partner;
  let suffix: string;

  beforeAll(async () => {
    prisma = testPrisma();
    suffix = newId().slice(-6);
    numbered = await prisma.partner.create({
      data: {
        id: newId(),
        name: `架空読取商事${suffix}`,
        kind: "vendor",
        invoiceRegistrationNumber: fictionalRegistrationNumber(),
      },
    });
    named = await prisma.partner.create({
      data: { id: newId(), name: `株式会社 架空読取食堂${suffix}`, kind: "vendor" },
    });
  });

  function fileInput(overrides: Partial<DocumentRegisterInput> = {}): DocumentRegisterInput {
    return {
      storageKey: `documents/2026/10/${newId()}.jpg`,
      sha256: newSha256(),
      mime: "image/jpeg",
      byteSize: 12_345,
      originalName: `receipt-${newId()}.jpg`,
      source: "upload",
      ...overrides,
    };
  }

  async function register(overrides: Partial<DocumentRegisterInput> = {}) {
    const result = await registerDocument(prisma, fileInput(overrides), { actor });
    expect(result.duplicate).toBe(false);
    return result.document;
  }

  function deps(
    reader: ReaderProvider,
    registry: NtaLookup | null = null,
    bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff]),
  ): DocumentReadingDeps {
    return { reader, registry, today: TODAY, readFile: () => Promise.resolve(bytes) };
  }

  async function read(
    documentId: string,
    reader: ReaderProvider,
    registry: NtaLookup | null = null,
  ) {
    return performDocumentReading(prisma, deps(reader, registry), { documentId }, { actor });
  }

  async function actionsOf(entityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { entity: "document", entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => row.action);
  }

  async function usageOf(documentId: string) {
    return prisma.externalApiUsage.findMany({ where: { documentId }, orderBy: { id: "asc" } });
  }

  async function itemsOf(documentId: string) {
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { links: true },
    });
    return {
      kind: row.kind,
      status: row.status,
      txnDate: row.txnDate,
      amount: row.amount,
      partnerId: row.partnerId,
      partnerName: row.partnerName,
      invoiceRegistrationNumber: row.invoiceRegistrationNumber,
      note: row.note,
      voidedAt: row.voidedAt,
      links: row.links.length,
    };
  }

  describe("reading", () => {
    it("stores the proposal, one usage row and document.read, and changes no item", async () => {
      const document = await register({ note: "既存のメモ" });
      const before = await itemsOf(document.id);
      const issuer = `架空読取弁当${suffix}`;
      const total = uniqueTotal();

      const result = await read(
        document.id,
        answering(answer({ issuerName: issuer, totalAmount: total })),
      );

      expect(result).toEqual({ status: "proposed", issues: [] });
      expect(await itemsOf(document.id)).toEqual(before);
      const extraction = await getDocumentReading(prisma, document.id);
      expect(extraction).toMatchObject({
        version: 1,
        status: "proposed",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        registry: null,
        registryError: null,
        error: null,
        issues: [],
      });
      expect(extraction?.reading).toMatchObject({
        issuerName: issuer,
        transactionDate: "2026-10-05",
        totalAmount: String(total),
      });
      expect(await actionsOf(document.id)).toEqual(["document.create", "document.read"]);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: document.id, action: "document.read" },
      });
      expect(audit.actor).toBe(actor);
      expect(audit.after).toEqual({
        status: "proposed",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        issues: [],
        reading: {
          transactionDate: "2026-10-05",
          totalAmount: String(total),
          currency: "JPY",
          registrationNumber: null,
          issuerName: issuer,
        },
      });

      const usage = await usageOf(document.id);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        service: "reader",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        outcome: "ok",
        error: null,
        requestCount: 1,
        inputTokens: 2_000,
        outputTokens: 1_000,
        // 2,000 × 100 + 1,000 × 500 (10⁻⁹ USD)
        costNanoUsd: 700_000n,
        actor,
      });

      // The note is not empty, so its proposal is shown but not checked.
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(rowOf(proposal, "note")).toMatchObject({
        proposed: "会議用の弁当",
        current: "既存のメモ",
        selectable: true,
        defaultChecked: false,
      });
      expect(rowOf(proposal, "kind")).toMatchObject({
        proposed: "receipt",
        proposedLabel: "領収書",
        same: true,
        selectable: false,
      });
      expect(rowOf(proposal, "amount")).toMatchObject({
        proposed: String(total),
        current: null,
        defaultChecked: true,
      });
    });

    it("reads the gold set with the recorded provider and the fixture registry", async () => {
      const bytes = new Uint8Array(readFileSync(new URL("r09.pdf", RECEIPTS)));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const document = await register({
        sha256,
        mime: "application/pdf",
        storageKey: `documents/2026/10/${newId()}.pdf`,
        originalName: "r09.pdf",
      });
      const reader = createRecordedReader({
        recordings: loadRecordingFile(new URL("recorded.json", RECEIPTS)),
      });
      const registry = createFixtureNtaLookup(FIXTURE_NTA_REGISTRATIONS);

      const result = await performDocumentReading(
        prisma,
        deps(reader, registry, bytes),
        { documentId: document.id },
        { actor },
      );

      expect(result).toEqual({ status: "proposed", issues: [] });
      const extraction = await getDocumentReading(prisma, document.id);
      expect(extraction?.registry).toMatchObject({
        number: "T1999999999908",
        found: true,
        status: "registered",
        name: "架空印刷株式会社",
        registeredOn: "2023-10-01",
      });
      const usage = await usageOf(document.id);
      expect(usage.map((row) => [row.service, row.provider, row.model, row.outcome])).toEqual([
        ["reader", "recorded", "synthetic", "ok"],
        ["registry", "nta", null, "ok"],
      ]);
      // Recorded answers cost nothing; the registry row counts one request for one number.
      expect(usage[0]).toMatchObject({ inputTokens: 2_304, outputTokens: 563, costNanoUsd: 0n });
      expect(usage[1]).toMatchObject({ requestCount: 1, itemCount: 1, costNanoUsd: 0n });

      const proposal = await buildReadingProposal(prisma, document.id);
      expect(rowOf(proposal, "kind")).toMatchObject({
        proposed: "invoice_in",
        proposedLabel: "受領した請求書",
        current: "receipt",
        selectable: true,
        defaultChecked: false,
      });
      expect(rowOf(proposal, "txnDate")).toMatchObject({
        proposed: "2026-10-23",
        proposedLabel: "2026/10/23",
      });
      expect(rowOf(proposal, "amount")).toMatchObject({
        proposed: "25300",
        proposedLabel: "25,300",
      });
      expect(proposal?.rates).toEqual([
        {
          ratePercent: 10,
          inclusiveAmount: 25_300n,
          taxAmount: 2_300n,
          estimatedTaxCategory: "purchase_10",
          deductiblePercent: 100,
        },
      ]);
    });

    it("refuses a voided document, an unreadable format and a missing one", async () => {
      const csv = await register({
        mime: "text/csv",
        storageKey: `documents/2026/10/${newId()}.csv`,
      });
      const reader = answering(answer({ issuerName: "架空", totalAmount: uniqueTotal() }));
      const unreadable = await rejectionOf(read(csv.id, reader));
      expect(unreadable).toBeInstanceOf(SettingsError);
      expect((unreadable as Error).message).toBe(
        "この形式は読み取れません（画像は JPEG・PNG・WebP、または PDF）",
      );
      expect(reader.calls).toBe(0);
      expect(await getDocumentReading(prisma, csv.id)).toBeNull();
      expect(await usageOf(csv.id)).toEqual([]);

      const document = await register();
      await voidDocument(prisma, { id: document.id, reason: "重複" }, { actor });
      expect(await rejectionOf(read(document.id, reader))).toBeInstanceOf(SettingsError);
      expect(reader.calls).toBe(0);
      expect(await rejectionOf(read(newId(), reader))).toBeInstanceOf(SettingsError);
    });

    it("records a ReaderError as a failed reading with what it cost", async () => {
      const document = await register();
      const unreadBefore = await countUnreadInboxDocuments(prisma);
      const refusal = fakeReader(() => {
        throw new ReaderError("refusal", undefined, { inputTokens: 1_500, outputTokens: 20 });
      });

      const result = await read(document.id, refusal);

      expect(result).toEqual({
        status: "failed",
        issues: [],
        error: "読み取りを断られました。項目は手で入れてください",
      });
      expect(await getDocumentReading(prisma, document.id)).toMatchObject({
        status: "failed",
        reading: null,
        error: "読み取りを断られました。項目は手で入れてください",
      });
      const [usage] = await usageOf(document.id);
      expect(usage).toMatchObject({
        service: "reader",
        outcome: "failed",
        error: "読み取りを断られました。項目は手で入れてください",
        inputTokens: 1_500,
        outputTokens: 20,
        costNanoUsd: 1_500n * 100n + 20n * 500n,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: document.id, action: "document.read" },
      });
      expect(audit.after).toEqual({
        status: "failed",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        error: "読み取りを断られました。項目は手で入れてください",
      });
      // Read (and failed): no longer counted as unread, shown as 読み取れず.
      expect(await countUnreadInboxDocuments(prisma)).toBe(unreadBefore - 1);
      expect(await loadReadingStates(prisma, [document.id])).toEqual(
        new Map([[document.id, "failed"]]),
      );
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(proposal).toMatchObject({ status: "failed", allSaved: false, rates: [] });
      expect(proposal?.rows.every((row) => row.proposed === null && !row.selectable)).toBe(true);
      expect(
        await rejectionOf(
          applyDocumentReading(prisma, { documentId: document.id, fields: ["amount"] }, { actor }),
        ),
      ).toBeInstanceOf(SettingsError);
    });

    it("counts a malformed answer with the provider's usage, and rethrows other errors", async () => {
      const document = await register();
      const malformed = answering(
        { documentType: "receipt" },
        { inputTokens: 900, outputTokens: 5 },
      );
      expect(await read(document.id, malformed)).toMatchObject({ status: "failed" });
      expect(await usageOf(document.id)).toMatchObject([
        { outcome: "failed", inputTokens: 900, outputTokens: 5 },
      ]);

      const other = await register();
      const broken = fakeReader(() => {
        throw new Error("socket hang up");
      });
      expect(await rejectionOf(read(other.id, broken))).toMatchObject({
        message: "socket hang up",
      });
      expect(await getDocumentReading(prisma, other.id)).toBeNull();
      expect(await usageOf(other.id)).toEqual([]);
      expect(await actionsOf(other.id)).toEqual(["document.create"]);
    });

    it("looks up the number at the registry as of the transaction date", async () => {
      const registry = spyLookup(createFixtureNtaLookup(FIXTURE_NTA_REGISTRATIONS));

      // 架空失効株式会社: expired on 2025-03-31.
      const expired = await register();
      const result = await read(
        expired.id,
        answering(
          answer({
            issuerName: "架空失効株式会社",
            registrationNumber: "T6999999999911",
            totalAmount: 2_180,
            rates: [
              { ratePercent: 10, amount: 1_100, taxIncluded: true, taxAmount: null },
              { ratePercent: 8, amount: 1_080, taxIncluded: true, taxAmount: null },
            ],
            description: null,
            transactionDate: "2026-10-04",
          }),
        ),
        registry,
      );
      expect(result.issues.map((issue) => issue.code)).toEqual(["registration_inactive"]);
      const proposal = await buildReadingProposal(prisma, expired.id);
      expect(proposal?.registry).toMatchObject({
        found: true,
        status: "not_registered",
        endedOn: "2025-03-31",
        endReason: "expired",
      });
      expect(proposal?.registrationStatus).toBe("not_registered");
      // 経過措置: 2026-10-01〜2028-09-30 is 70%.
      expect(
        proposal?.rates.map((rate) => [rate.estimatedTaxCategory, rate.deductiblePercent]),
      ).toEqual([
        ["purchase_10_ni", 70],
        ["purchase_8r_ni", 70],
      ]);
      // A warning does not block the item.
      expect(rowOf(proposal, "invoiceRegistrationNumber")).toMatchObject({
        selectable: true,
        defaultChecked: true,
      });
      expect(await loadReadingStates(prisma, [expired.id])).toEqual(
        new Map([[expired.id, "needs_review"]]),
      );

      // Not published at all.
      expect(isValidInvoiceRegistrationNumber("T9999999999909")).toBe(true);
      const unpublished = await register();
      const missing = await read(
        unpublished.id,
        answering(
          answer({
            issuerName: `架空未登録${suffix}`,
            registrationNumber: "T9999999999909",
            totalAmount: uniqueTotal(),
          }),
        ),
        registry,
      );
      expect(missing.issues.map((issue) => issue.code)).toEqual(["registration_not_found"]);
      expect(await getDocumentReading(prisma, unpublished.id)).toMatchObject({
        registry: { found: false, status: "not_registered", name: null },
      });
      expect(registry.calls).toEqual([["T6999999999911"], ["T9999999999909"]]);
    });

    it("keeps reading when the registry fails, and checks only the format then", async () => {
      const failing: NtaLookup = {
        lookup: (numbers) =>
          Promise.resolve({
            registrations: new Map(),
            requestCount: 1,
            failures: [
              {
                numbers: [...numbers],
                message: "国税庁の公表サイトに接続できませんでした（HTTP 503）",
              },
            ],
          }),
      };
      const document = await register();
      const result = await read(
        document.id,
        answering(
          answer({
            issuerName: `架空照合失敗${suffix}`,
            registrationNumber: "T9999999999909",
            totalAmount: uniqueTotal(),
          }),
        ),
        failing,
      );
      expect(result).toEqual({ status: "proposed", issues: [] });
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(proposal).toMatchObject({
        registry: null,
        registryError: "国税庁の公表サイトに接続できませんでした（HTTP 503）",
        registrationStatus: "unknown",
      });
      expect(proposal?.rates.map((rate) => rate.estimatedTaxCategory)).toEqual([null]);
      expect((await usageOf(document.id)).map((row) => [row.service, row.outcome])).toEqual([
        ["reader", "ok"],
        ["registry", "failed"],
      ]);

      const throwing: NtaLookup = { lookup: () => Promise.reject(new Error("boom")) };
      const other = await register();
      await read(
        other.id,
        answering(
          answer({
            issuerName: `架空照合例外${suffix}`,
            registrationNumber: "T9999999999909",
            totalAmount: uniqueTotal(),
          }),
        ),
        throwing,
      );
      expect(await getDocumentReading(prisma, other.id)).toMatchObject({
        registry: null,
        registryError: "国税庁の公表サイトに接続できませんでした",
      });
    });
  });

  describe("proposal and saving", () => {
    it("saves only the chosen items with document.update, and no entry", async () => {
      const document = await register();
      const number = fictionalRegistrationNumber();
      const total = uniqueTotal();
      await read(
        document.id,
        answering(
          answer({
            issuerName: `架空読取食堂${suffix}`,
            registrationNumber: number,
            totalAmount: total,
            description: "打ち合わせの昼食",
          }),
        ),
      );
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(proposal?.allSaved).toBe(false);
      expect(rowOf(proposal, "partner")).toMatchObject({
        proposed: named.id,
        proposedLabel: named.name,
        partnerMatch: "name",
        defaultChecked: true,
      });
      expect(proposal?.rows.filter((row) => row.defaultChecked).map((row) => row.field)).toEqual([
        "txnDate",
        "amount",
        "partner",
        "invoiceRegistrationNumber",
        "note",
      ]);
      expect(await loadReadingStates(prisma, [document.id])).toEqual(
        new Map([[document.id, "proposed"]]),
      );

      const entriesBefore = await prisma.journalEntry.count();
      const detail = await applyDocumentReading(
        prisma,
        { documentId: document.id, fields: ["txnDate", "amount", "partner"] },
        { actor },
      );
      expect(detail).toMatchObject({
        txnDate: "2026-10-05",
        amount: BigInt(total),
        partnerId: named.id,
        partnerName: null,
        invoiceRegistrationNumber: null,
        note: null,
        kind: "receipt",
      });
      expect(await prisma.journalEntry.count()).toBe(entriesBefore);
      expect(await actionsOf(document.id)).toEqual([
        "document.create",
        "document.read",
        "document.update",
      ]);

      const after = await buildReadingProposal(prisma, document.id);
      expect(after?.rows.filter((row) => row.same).map((row) => row.field)).toEqual([
        "kind",
        "txnDate",
        "amount",
        "partner",
      ]);
      expect(after?.allSaved).toBe(false);

      // An item equal to the current value cannot be chosen.
      const same = await rejectionOf(
        applyDocumentReading(prisma, { documentId: document.id, fields: ["kind"] }, { actor }),
      );
      expect(same).toBeInstanceOf(SettingsError);
      expect((same as SettingsError).field).toBe("kind");

      await applyDocumentReading(
        prisma,
        { documentId: document.id, fields: ["invoiceRegistrationNumber", "note"] },
        { actor },
      );
      expect((await buildReadingProposal(prisma, document.id))?.allSaved).toBe(true);
      expect(await loadReadingStates(prisma, [document.id])).toEqual(
        new Map([[document.id, "saved"]]),
      );
      expect(await itemsOf(document.id)).toMatchObject({
        invoiceRegistrationNumber: number,
        note: "打ち合わせの昼食",
        links: 0,
      });
    });

    it("validates the chosen items", async () => {
      const document = await register();
      await read(
        document.id,
        answering(answer({ issuerName: "架空", totalAmount: uniqueTotal() })),
      );
      for (const fields of [[], ["amount", "amount"], ["total"]]) {
        await expect(
          applyDocumentReading(prisma, { documentId: document.id, fields }, { actor }),
        ).rejects.toThrow();
      }
      expect(await actionsOf(document.id)).toEqual(["document.create", "document.read"]);
    });

    it("never offers a number whose check digit is wrong", async () => {
      const wrong = "T1234567890123";
      expect(isValidInvoiceRegistrationNumber(wrong)).toBe(false);
      const registry = spyLookup(createFixtureNtaLookup(FIXTURE_NTA_REGISTRATIONS));
      const document = await register();
      const result = await read(
        document.id,
        answering(
          answer({
            issuerName: `架空誤番号${suffix}`,
            registrationNumber: wrong,
            totalAmount: uniqueTotal(),
          }),
        ),
        registry,
      );

      expect(result.issues).toMatchObject([
        { code: "registration_check_digit", severity: "error", field: "registrationNumber" },
      ]);
      // Not sent to the registry.
      expect(registry.calls).toEqual([]);
      expect((await usageOf(document.id)).map((row) => row.service)).toEqual(["reader"]);
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(rowOf(proposal, "invoiceRegistrationNumber")).toMatchObject({
        proposed: wrong,
        selectable: false,
        defaultChecked: false,
      });
      const error = await rejectionOf(
        applyDocumentReading(
          prisma,
          { documentId: document.id, fields: ["amount", "invoiceRegistrationNumber"] },
          { actor },
        ),
      );
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).field).toBe("invoiceRegistrationNumber");
      // Nothing was saved, not even the valid item.
      expect(await itemsOf(document.id)).toMatchObject({ amount: null });
      expect(await actionsOf(document.id)).toEqual(["document.create", "document.read"]);
    });

    it("shows a voided document's proposal read-only and refuses to save it", async () => {
      const document = await register();
      const extraction = {
        version: 1 as const,
        status: "proposed" as const,
        readAt: new Date().toISOString(),
        provider: "recorded",
        model: "synthetic",
        reading: {
          documentType: "receipt" as const,
          legible: true,
          issuerName: `架空無効${suffix}`,
          registrationNumber: null,
          registrationNumberAsPrinted: null,
          transactionDate: "2026-10-05" as CalendarDate,
          transactionDateAsPrinted: "2026-10-05",
          currency: "JPY",
          totalAmount: String(uniqueTotal()),
          rates: [],
          description: null,
        },
        issues: [],
        registry: null,
        registryError: null,
        error: null,
      };
      await recordDocumentReading(
        prisma,
        {
          documentId: document.id,
          extraction,
          usage: [{ service: "reader", provider: "recorded", model: "synthetic", outcome: "ok" }],
          today: TODAY,
        },
        { actor },
      );
      expect((await getDocumentReading(prisma, document.id))?.issues.map((i) => i.code)).toEqual([
        "rates_missing",
      ]);
      await voidDocument(prisma, { id: document.id, reason: "撮り直し" }, { actor });

      const proposal = await buildReadingProposal(prisma, document.id);
      expect(proposal?.voided).toBe(true);
      expect(proposal?.rows.some((row) => row.selectable)).toBe(false);
      expect(
        await rejectionOf(
          applyDocumentReading(prisma, { documentId: document.id, fields: ["amount"] }, { actor }),
        ),
      ).toBeInstanceOf(SettingsError);
      expect(
        await rejectionOf(
          recordDocumentReading(
            prisma,
            { documentId: document.id, extraction, usage: [] },
            { actor },
          ),
        ),
      ).toBeInstanceOf(SettingsError);
    });
  });

  describe("partner matching and duplicates", () => {
    it("matches by registration number, then by name, else proposes the issuer's name", async () => {
      const inactive = await prisma.partner.create({
        data: { id: newId(), name: `架空休止${suffix}`, kind: "vendor", isActive: false },
      });
      const cases = [
        {
          raw: answer({
            issuerName: "どこかの店",
            registrationNumber: numbered.invoiceRegistrationNumber,
            totalAmount: uniqueTotal(),
          }),
          expected: { proposed: numbered.id, partnerMatch: "registration_number" },
        },
        {
          raw: answer({ issuerName: `架空読取食堂 ${suffix}`, totalAmount: uniqueTotal() }),
          expected: { proposed: named.id, partnerMatch: "name" },
        },
        {
          raw: answer({ issuerName: inactive.name, totalAmount: uniqueTotal() }),
          expected: { proposed: inactive.name, partnerMatch: null },
        },
      ];
      for (const { raw, expected } of cases) {
        const document = await register();
        await read(document.id, answering(raw));
        expect(rowOf(await buildReadingProposal(prisma, document.id), "partner")).toMatchObject(
          expected,
        );
      }

      // A free-text proposal is saved as the partner's name.
      const free = await register();
      await read(free.id, answering(answer({ issuerName: `架空自由${suffix}`, totalAmount: 1 })));
      const detail = await applyDocumentReading(
        prisma,
        { documentId: free.id, fields: ["partner"] },
        { actor },
      );
      expect(detail).toMatchObject({ partnerId: null, partnerName: `架空自由${suffix}` });
    });

    it("estimates from the matched partner's stored registration without a lookup", async () => {
      await prisma.partner.update({
        where: { id: numbered.id },
        data: {
          invoiceRegistrationStatus: "verified",
          invoiceRegisteredOn: new Date("2023-10-01T00:00:00Z"),
          invoiceRegistrationCheckedAt: new Date(),
        },
      });
      const document = await register();
      await read(
        document.id,
        answering(
          answer({
            issuerName: numbered.name,
            registrationNumber: numbered.invoiceRegistrationNumber,
            totalAmount: uniqueTotal(),
          }),
        ),
      );
      const proposal = await buildReadingProposal(prisma, document.id);
      expect(proposal).toMatchObject({ registry: null, registrationStatus: "registered" });
      expect(proposal?.rates.map((rate) => rate.estimatedTaxCategory)).toEqual(["purchase_10"]);
    });

    it("finds other documents with the same issuer, date and total", async () => {
      const total = uniqueTotal();
      const issuer = `架空重複商店${suffix}`;
      const number = fictionalRegistrationNumber();
      // By its items: the free-text name.
      const byItems = await register({
        originalName: "receipt-1005.jpg",
        txnDate: "2026-10-05",
        amount: BigInt(total),
        // A full-width space (U+3000) between the legal form and the name.
        partnerName: `株式会社\u3000${issuer}`,
      });
      // By its items: the registration number (another name).
      const byNumber = await register({
        txnDate: "2026-10-05",
        amount: BigInt(total),
        partnerName: "別の名前",
        invoiceRegistrationNumber: number,
      });
      // Not: voided, another date, another issuer.
      const voided = await register({
        txnDate: "2026-10-05",
        amount: BigInt(total),
        partnerName: issuer,
      });
      await voidDocument(prisma, { id: voided.id, reason: "重複" }, { actor });
      await register({ txnDate: "2026-10-06", amount: BigInt(total), partnerName: issuer });
      await register({ txnDate: "2026-10-05", amount: BigInt(total), partnerName: "架空他社" });
      // By its reading only (its items are still empty).
      const byReading = await register({ originalName: null });
      await read(byReading.id, answering(answer({ issuerName: issuer, totalAmount: total })));

      const document = await register();
      const found = await findReadingDuplicates(prisma, {
        documentId: document.id,
        txnDate: "2026-10-05",
        amount: BigInt(total),
        registrationNumber: number,
        issuerName: issuer,
      });
      expect(found).toEqual([
        { documentId: byItems.id, label: "receipt-1005.jpg" },
        { documentId: byNumber.id, label: byNumber.originalName },
        { documentId: byReading.id, label: "領収書 2026/10/05" },
      ]);

      const result = await read(
        document.id,
        answering(answer({ issuerName: issuer, registrationNumber: number, totalAmount: total })),
      );
      expect(result.issues).toMatchObject([{ code: "duplicate", severity: "warning" }]);
      expect(result.issues[0]?.message).toContain("receipt-1005.jpg");
      // Without a date or a total there is nothing to compare.
      expect(
        await findReadingDuplicates(prisma, {
          documentId: document.id,
          txnDate: null,
          amount: BigInt(total),
          registrationNumber: number,
          issuerName: issuer,
        }),
      ).toEqual([]);
    });
  });

  describe("inbox and states", () => {
    it("lists the unread inbox documents a provider can read, oldest first", async () => {
      const countBefore = await countUnreadInboxDocuments(prisma);
      const first = await register();
      const second = await register({ mime: "application/pdf" });
      await register({ mime: "image/heic", storageKey: `documents/2026/10/${newId()}.heic` });
      await register({ mime: "text/csv", storageKey: `documents/2026/10/${newId()}.csv` });
      const voided = await register();
      await voidDocument(prisma, { id: voided.id, reason: "重複" }, { actor });

      expect(await countUnreadInboxDocuments(prisma)).toBe(countBefore + 2);
      const listed = await listUnreadInboxDocuments(prisma, { limit: 1_000 });
      const ids = listed.map((row) => row.id);
      expect(ids.indexOf(first.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      expect(ids).not.toContain(voided.id);
      expect(listed.find((row) => row.id === second.id)).toEqual({
        id: second.id,
        originalName: second.originalName,
        mime: "application/pdf",
      });
      expect(await listUnreadInboxDocuments(prisma, { limit: 1 })).toHaveLength(1);

      await read(first.id, answering(answer({ issuerName: "架空", totalAmount: uniqueTotal() })));
      expect(await countUnreadInboxDocuments(prisma)).toBe(countBefore + 1);
      expect(
        (await listUnreadInboxDocuments(prisma, { limit: 1_000 })).map((r) => r.id),
      ).not.toContain(first.id);
      // Unread documents have no state.
      expect(await loadReadingStates(prisma, [first.id, second.id])).toEqual(
        new Map([[first.id, "proposed"]]),
      );
      expect(await loadReadingStates(prisma, [])).toEqual(new Map());
    });
  });

  describe("external API usage", () => {
    it("sums one service's calls in a period", async () => {
      // The last row is outside the period (`to` is exclusive).
      const rows = [
        {
          at: "2001-01-05T00:00:00Z",
          service: "reader",
          outcome: "ok",
          tokens: 2_000,
          cost: 700_000n,
        },
        {
          at: "2001-01-20T00:00:00Z",
          service: "reader",
          outcome: "failed",
          tokens: 100,
          cost: 10_000n,
        },
        { at: "2001-01-21T00:00:00Z", service: "registry", outcome: "ok", tokens: 0, cost: 0n },
        { at: "2001-02-01T00:00:00Z", service: "reader", outcome: "ok", tokens: 6, cost: 1n },
      ];
      for (const row of rows) {
        await prisma.externalApiUsage.create({
          data: {
            id: newId(),
            at: new Date(row.at),
            service: row.service,
            provider: row.service === "reader" ? "anthropic" : "nta",
            outcome: row.outcome,
            requestCount: row.service === "reader" ? 1 : 3,
            itemCount: row.service === "reader" ? 0 : 25,
            inputTokens: row.tokens,
            outputTokens: row.tokens / 2,
            costNanoUsd: row.cost,
            actor,
          },
        });
      }
      const january = {
        from: new Date("2001-01-01T00:00:00Z"),
        to: new Date("2001-02-01T00:00:00Z"),
      };
      expect(await summarizeApiUsage(prisma, { service: "reader", ...january })).toEqual({
        count: 2,
        ok: 1,
        failed: 1,
        requestCount: 2,
        itemCount: 0,
        inputTokens: 2_100,
        outputTokens: 1_050,
        costNanoUsd: 710_000n,
      });
      expect(await summarizeApiUsage(prisma, { service: "registry", ...january })).toMatchObject({
        count: 1,
        ok: 1,
        requestCount: 3,
        itemCount: 25,
        costNanoUsd: 0n,
      });
      expect(
        await summarizeApiUsage(prisma, {
          service: "reader",
          from: new Date("2000-01-01T00:00:00Z"),
          to: new Date("2000-02-01T00:00:00Z"),
        }),
      ).toEqual({
        count: 0,
        ok: 0,
        failed: 0,
        requestCount: 0,
        itemCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0n,
      });
    });

    it("is append-only and checks its values", async () => {
      await recordApiUsage(prisma, {
        service: "registry",
        provider: "fixture",
        outcome: "ok",
        itemCount: 2,
        actor,
      });
      const row = await prisma.externalApiUsage.findFirstOrThrow({
        where: { provider: "fixture", actor },
        orderBy: { id: "desc" },
      });
      expect(row).toMatchObject({
        service: "registry",
        model: null,
        documentId: null,
        requestCount: 1,
        itemCount: 2,
        inputTokens: 0,
        costNanoUsd: 0n,
      });
      await expect(
        prisma.externalApiUsage.update({ where: { id: row.id }, data: { itemCount: 3 } }),
      ).rejects.toThrow(/ledger guard: external_api_usage is append-only \(UPDATE/);
      await expect(prisma.externalApiUsage.delete({ where: { id: row.id } })).rejects.toThrow(
        /ledger guard: external_api_usage is append-only \(DELETE/,
      );
      await expect(
        recordApiUsage(prisma, {
          service: "reader",
          provider: "x",
          outcome: "maybe" as "ok",
          actor,
        }),
      ).rejects.toThrow(/external_api_usage_outcome/);
      await expect(
        recordApiUsage(prisma, {
          service: "other" as "reader",
          provider: "x",
          outcome: "ok",
          actor,
        }),
      ).rejects.toThrow(/external_api_usage_service/);
      await expect(
        recordApiUsage(prisma, {
          service: "reader",
          provider: "x",
          outcome: "ok",
          costNanoUsd: -1n,
          actor,
        }),
      ).rejects.toThrow(/external_api_usage_counts_nonnegative/);
    });
  });
});
