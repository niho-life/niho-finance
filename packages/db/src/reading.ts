/**
 * Reading of documents (20-reader §5・§7.2): the provider's proposal is stored on the document
 * (`extraction`) with its checks, and only the items the owner chooses are saved, through
 * `updateDocument`. A reading never changes the items, the links or the entries: it writes the
 * extraction, one `external_api_usage` row per external call and `document.read`; saving the
 * proposal writes `document.update`. The provider and the registry are called outside any
 * transaction.
 */
import {
  registrationStatusAt,
  type NtaLookup,
  type NtaRegistration,
} from "@niho-finance/importers";
import {
  displayDate,
  DOCUMENT_KIND_LABELS,
  formatYen,
  isCalendarDate,
  isValidInvoiceRegistrationNumber,
  resolveTaxRule,
  STANDARD_TAX_RATE_RULES,
  type CalendarDate,
  type Money,
  type TaxRateRule,
} from "@niho-finance/ledger";
import {
  estimatePurchaseTaxCategory,
  fromStoredReading,
  isReadableMime,
  normalizeIssuerName,
  parseReading,
  READABLE_MIMES,
  READER_ERROR_MESSAGES,
  ReaderError,
  READING_ISSUE_CODES,
  readingCostNanoUsd,
  toStoredReading,
  validateReading,
  type EstimatedPurchaseTaxCategory,
  type ProviderUsage,
  type ReaderProvider,
  type Reading,
  type ReadingIssue,
  type ReadingIssueCode,
  type ReadingIssueField,
  type ReadingRatePercent,
  type ReadingRegistry,
  type RegistrationStatusAtDate,
  type StoredReading,
} from "@niho-finance/reader";
import { Prisma, type Partner } from "@prisma/client";
import { z } from "zod";
import { recordApiUsage, type ApiUsageCall } from "./api-usage";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDateOrNull, toDbDate, todayInJapan } from "./dates";
import { updateDocument, type DocumentDetail } from "./documents";
import { loadTaxRules } from "./entries";
import { SettingsError } from "./errors";
import {
  lookupErrors,
  lookupProvider,
  lookupRegistrations,
  partnerRegistrationAt,
  REGISTRY_LOOKUP_FAILED,
} from "./registry-check";
import {
  documentReadingApplySchema,
  documentReadingSchema,
  READING_PROPOSAL_FIELDS,
  type DocumentReadingApplyInput,
  type DocumentReadingInput,
  type DocumentUpdateInput,
  type ReadingProposalField,
} from "./schemas";
import type { WriteOptions } from "./settings";
import { runInTransaction, type Tx } from "./transaction";

export {
  API_USAGE_SERVICES,
  recordApiUsage,
  summarizeApiUsage,
  type ApiUsageCall,
  type ApiUsageRow,
  type ApiUsageService,
  type ApiUsageSummary,
} from "./api-usage";

const NOT_FOUND = "証憑が見つかりません。画面を読み込み直してください";
const VOIDED_IS_NOT_READ = "無効にした証憑は読み取れません";
const VOIDED_IS_FIXED = "無効にした証憑は変えられません。必要なら差し替えてください";
const NO_PROPOSAL = "保存できる提案がありません。読み取り直してください";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The registry lookup made while reading (20-reader §6). */
export interface StoredRegistry {
  number: string;
  /** `false`: the publication has no such number. */
  found: boolean;
  /** On the transaction date (the reading day when the date was not read). */
  status: "registered" | "not_registered";
  /** The published name. */
  name: string | null;
  registeredOn: CalendarDate | null;
  /** Expiry or revocation: not registered from this day. */
  endedOn: CalendarDate | null;
  endReason: "expired" | "revoked" | null;
  /** ISO 8601. */
  checkedAt: string;
}

/** `document.extraction`, version 1 (20-reader §7.1). Every key is present; absent ones are null. */
export interface DocumentExtraction {
  version: 1;
  status: "proposed" | "failed";
  /** ISO 8601. */
  readAt: string;
  provider: string;
  model: string;
  /** Set when proposed. */
  reading: StoredReading | null;
  issues: ReadingIssue[];
  /** `null`: not looked up (no application ID, a malformed number) or the lookup failed. */
  registry: StoredRegistry | null;
  registryError: string | null;
  /** Set when failed (owner-facing). */
  error: string | null;
}

export interface DocumentReadingDeps {
  reader: ReaderProvider;
  /** The stored file (the storage's `read`). */
  readFile: (storageKey: string) => Promise<Uint8Array>;
  /** `null` without the application ID: only the format and the check digit are checked. */
  registry: NtaLookup | null;
  /** Defaults to today in Japan (the validation's 未来 / 2 年以上前). */
  today?: CalendarDate;
}

export interface DocumentReadingResult {
  status: "proposed" | "failed";
  issues: ReadingIssue[];
  /** Why it failed (owner-facing). */
  error?: string;
}

export interface DocumentReadingRecord {
  documentId: string;
  extraction: DocumentExtraction;
  /** The external calls of this reading (the provider's, the registry's). */
  usage: readonly ApiUsageCall[];
  /** Defaults to today in Japan. */
  today?: CalendarDate;
}

export interface ReadingDuplicate {
  documentId: string;
  /** The file name, else 種別 and date. */
  label: string;
}

/** A row of the proposal table (20-reader §10.1). Values are canonical strings. */
export interface ProposalRow {
  field: ReadingProposalField;
  /**
   * kind: the code; txnDate: YYYY-MM-DD; amount: decimal yen; partner: a partner's ID, or the
   * free-text name when `partnerMatch` is `null`; invoiceRegistrationNumber: T + 13 digits; note.
   */
  proposed: string | null;
  current: string | null;
  /** As shown: 種別の名前, `2026/10/05`, `3,980`, the partner's name, the number, the note. */
  proposedLabel: string | null;
  currentLabel: string | null;
  same: boolean;
  /** Proposed, different from the current value, without an `error` issue, not voided. */
  selectable: boolean;
  /** Selectable and the current value is empty. */
  defaultChecked: boolean;
  /** How the partner was matched (partner row only). */
  partnerMatch: "registration_number" | "name" | null;
}

export interface ProposalRate {
  ratePercent: ReadingRatePercent;
  inclusiveAmount: Money;
  taxAmount: Money | null;
  estimatedTaxCategory: EstimatedPurchaseTaxCategory | null;
  /** The deductible ratio of the estimated category on the transaction date. */
  deductiblePercent: number | null;
}

export interface ReadingProposal {
  status: "proposed" | "failed";
  readAt: Date;
  provider: string;
  model: string;
  error: string | null;
  issues: ReadingIssue[];
  rows: ProposalRow[];
  rates: ProposalRate[];
  registry: StoredRegistry | null;
  registryError: string | null;
  /** What the estimate used: the lookup, else the matched partner's stored registration. */
  registrationStatus: RegistrationStatusAtDate;
  /** Every proposed item equals the current value (提案はすべて保存済みです). */
  allSaved: boolean;
  voided: boolean;
}

/** 一覧の状態の欄: 提案あり / 要確認 / 読み取れず, and 保存済み when nothing is left to save. */
export type ReadingState = "proposed" | "needs_review" | "failed" | "saved";

export interface UnreadInboxDocument {
  id: string;
  originalName: string | null;
  mime: string;
}

export const READING_PROPOSAL_FIELD_LABELS: Readonly<Record<ReadingProposalField, string>> = {
  kind: "種別",
  txnDate: "取引年月日",
  amount: "金額",
  partner: "取引先",
  invoiceRegistrationNumber: "登録番号",
  note: "メモ",
};

// ---------------------------------------------------------------------------
// The stored extraction
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = [
  "documentType",
  "transactionDate",
  "totalAmount",
  "rates",
  "registrationNumber",
  "issuerName",
  "currency",
] as const satisfies readonly ReadingIssueField[];

/** The proposal item an issue blocks when it is an `error`. */
const PROPOSAL_FIELD_OF_ISSUE: Readonly<Record<ReadingIssueField, ReadingProposalField | null>> = {
  documentType: "kind",
  transactionDate: "txnDate",
  totalAmount: "amount",
  currency: "amount",
  rates: null,
  registrationNumber: "invoiceRegistrationNumber",
  issuerName: "partner",
};

/**
 * Warnings that make an item's proposal doubtful (a misread year, a total the rate lines do not
 * add up to, a number the registry does not know): the item stays selectable but is not checked
 * by default, so that 提案を保存 never saves it without the owner looking.
 */
const DOUBTFUL_FIELD_OF_ISSUE: Readonly<Partial<Record<ReadingIssueCode, ReadingProposalField>>> = {
  date_future: "txnDate",
  date_old: "txnDate",
  total_range: "amount",
  rates_sum: "amount",
  registration_not_found: "invoiceRegistrationNumber",
};

const calendarDateSchema = z.custom<CalendarDate>((value) => isCalendarDate(value));

const storedIssueSchema = z.object({
  code: z.enum(READING_ISSUE_CODES),
  severity: z.enum(["error", "warning"]),
  field: z.enum(ISSUE_FIELDS).nullable(),
  message: z.string(),
});

const storedRegistrySchema = z.object({
  number: z.string(),
  found: z.boolean(),
  status: z.enum(["registered", "not_registered"]),
  name: z.string().nullable(),
  registeredOn: calendarDateSchema.nullable(),
  endedOn: calendarDateSchema.nullable(),
  endReason: z.enum(["expired", "revoked"]).nullable(),
  checkedAt: z.string(),
});

const extractionSchema = z.object({
  version: z.literal(1),
  status: z.enum(["proposed", "failed"]),
  readAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  provider: z.string(),
  model: z.string(),
  reading: z.unknown().optional(),
  issues: z.array(storedIssueSchema).optional(),
  registry: storedRegistrySchema.nullish(),
  registryError: z.string().nullish(),
  error: z.string().nullish(),
});

/** Checks `document.extraction`; `null` when it is missing, of another version or broken. */
export function parseDocumentExtraction(json: unknown): DocumentExtraction | null {
  const parsed = extractionSchema.safeParse(json);
  if (!parsed.success) return null;
  const value = parsed.data;
  let reading: StoredReading | null = null;
  if (value.reading !== undefined && value.reading !== null) {
    const restored = fromStoredReading(value.reading);
    if (!restored) return null;
    reading = toStoredReading(restored);
  }
  if (value.status === "proposed" && reading === null) return null;
  if (value.status === "failed" && !value.error) return null;
  return {
    version: 1,
    status: value.status,
    readAt: value.readAt,
    provider: value.provider,
    model: value.model,
    reading,
    issues: value.issues ?? [],
    registry: value.registry ?? null,
    registryError: value.registryError ?? null,
    error: value.error ?? null,
  };
}

function readingOf(extraction: DocumentExtraction): Reading | null {
  return extraction.reading === null ? null : fromStoredReading(extraction.reading);
}

/** The validation's view of the lookup: `undefined` not looked up, `null` not published. */
function readingRegistryOf(registry: StoredRegistry | null): ReadingRegistry | null | undefined {
  if (registry === null) return undefined;
  if (!registry.found) return null;
  return {
    status: registry.status,
    name: registry.name,
    registeredOn: registry.registeredOn,
    endedOn: registry.endedOn,
    endReason: registry.endReason,
  };
}

function toStoredRegistry(
  number: string,
  registration: NtaRegistration | null,
  date: CalendarDate,
  checkedAt: Date,
): StoredRegistry {
  return {
    number,
    found: registration !== null,
    status: registrationStatusAt(registration, date),
    name: registration?.name ?? null,
    registeredOn: registration?.registeredOn ?? null,
    endedOn: registration?.endedOn ?? null,
    endReason: registration?.endReason ?? null,
    checkedAt: checkedAt.toISOString(),
  };
}

/** `document.read`: what was read, never the whole proposal (the next reading overwrites it). */
function readingAuditSummary(extraction: DocumentExtraction): Record<string, unknown> {
  const head = {
    status: extraction.status,
    provider: extraction.provider,
    model: extraction.model,
  };
  const { reading } = extraction;
  if (extraction.status === "failed" || reading === null)
    return { ...head, error: extraction.error };
  return {
    ...head,
    issues: extraction.issues.map((issue) => issue.code),
    reading: {
      transactionDate: reading.transactionDate,
      totalAmount: reading.totalAmount,
      currency: reading.currency,
      registrationNumber: reading.registrationNumber,
      issuerName: reading.issuerName,
    },
    ...(extraction.registryError === null ? {} : { registryError: extraction.registryError }),
  };
}

function resultOf(extraction: DocumentExtraction): DocumentReadingResult {
  return {
    status: extraction.status,
    issues: extraction.issues,
    ...(extraction.error === null ? {} : { error: extraction.error }),
  };
}

// ---------------------------------------------------------------------------
// Documents and partners
// ---------------------------------------------------------------------------

const proposalDocumentSelect = {
  id: true,
  kind: true,
  status: true,
  txnDate: true,
  amount: true,
  partnerId: true,
  partnerName: true,
  invoiceRegistrationNumber: true,
  note: true,
  extraction: true,
  partner: { select: { name: true } },
} satisfies Prisma.DocumentSelect;

type ProposalDocument = Prisma.DocumentGetPayload<{ select: typeof proposalDocumentSelect }>;

/** Locks the document row until the transaction ends (as `updateDocument` does). */
async function lockProposalDocument(tx: Tx, id: string): Promise<ProposalDocument> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "document" WHERE "id" = ${id} FOR UPDATE`;
  const row =
    locked.length > 0
      ? await tx.document.findUnique({ where: { id }, select: proposalDocumentSelect })
      : null;
  if (!row) throw new SettingsError(NOT_FOUND);
  return row;
}

const matchablePartnerSelect = {
  id: true,
  name: true,
  invoiceRegistrationNumber: true,
  invoiceRegistrationStatus: true,
  invoiceRegisteredOn: true,
  invoiceRegistrationEndedOn: true,
} satisfies Prisma.PartnerSelect;

export type MatchablePartner = Pick<
  Partner,
  | "id"
  | "name"
  | "invoiceRegistrationNumber"
  | "invoiceRegistrationStatus"
  | "invoiceRegisteredOn"
  | "invoiceRegistrationEndedOn"
>;

export interface ReadingPartnerMatch {
  partner: MatchablePartner;
  by: "registration_number" | "name";
}

async function loadMatchablePartners(db: Db): Promise<MatchablePartner[]> {
  return db.partner.findMany({
    where: { isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: matchablePartnerSelect,
  });
}

/**
 * The partner of the master the issuer is (20-reader §5.1): ① an active partner with the same
 * registration number, ② one whose name is the same after `normalizeIssuerName`; else `null`
 * (the issuer's name is proposed as free text).
 */
export function matchReadingPartner(
  reading: Pick<StoredReading, "registrationNumber" | "issuerName">,
  partners: readonly MatchablePartner[],
): ReadingPartnerMatch | null {
  const number = reading.registrationNumber;
  if (number !== null) {
    const partner = partners.find((candidate) => candidate.invoiceRegistrationNumber === number);
    if (partner) return { partner, by: "registration_number" };
  }
  const name = reading.issuerName === null ? "" : normalizeIssuerName(reading.issuerName);
  if (name !== "") {
    const partner = partners.find((candidate) => normalizeIssuerName(candidate.name) === name);
    if (partner) return { partner, by: "name" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

interface FieldValue {
  value: string | null;
  label: string | null;
}

const NONE: FieldValue = { value: null, label: null };

function dateValue(date: CalendarDate | null): FieldValue {
  return date === null ? NONE : { value: date, label: displayDate(date) };
}

function amountValue(amount: string | null): FieldValue {
  return amount === null ? NONE : { value: amount, label: formatYen(BigInt(amount)) };
}

function textValue(text: string | null): FieldValue {
  return { value: text, label: text };
}

function proposedValues(
  reading: StoredReading,
  match: ReadingPartnerMatch | null,
): Record<ReadingProposalField, FieldValue> {
  const kind =
    reading.documentType === "receipt"
      ? "receipt"
      : reading.documentType === "invoice"
        ? "invoice_in"
        : null;
  return {
    kind: kind === null ? NONE : { value: kind, label: DOCUMENT_KIND_LABELS[kind] },
    txnDate: dateValue(reading.transactionDate),
    // Amounts in another currency are not proposed (the owner converts them).
    amount: amountValue(reading.currency === "JPY" ? reading.totalAmount : null),
    partner: match
      ? { value: match.partner.id, label: match.partner.name }
      : textValue(reading.issuerName),
    invoiceRegistrationNumber: textValue(reading.registrationNumber),
    note: textValue(reading.description),
  };
}

function currentValues(document: ProposalDocument): Record<ReadingProposalField, FieldValue> {
  return {
    kind: { value: document.kind, label: DOCUMENT_KIND_LABELS[document.kind] },
    txnDate: dateValue(fromDbDateOrNull(document.txnDate)),
    amount: amountValue(document.amount === null ? null : document.amount.toString()),
    partner: {
      value: document.partnerId ?? document.partnerName,
      label: document.partner?.name ?? document.partnerName,
    },
    invoiceRegistrationNumber: textValue(document.invoiceRegistrationNumber),
    note: textValue(document.note),
  };
}

function proposalRows(
  document: ProposalDocument,
  extraction: DocumentExtraction,
  match: ReadingPartnerMatch | null,
): ProposalRow[] {
  const blocked = new Set<ReadingProposalField>();
  const doubtful = new Set<ReadingProposalField>();
  for (const issue of extraction.issues) {
    const unsure = DOUBTFUL_FIELD_OF_ISSUE[issue.code];
    if (unsure) doubtful.add(unsure);
    if (issue.severity !== "error" || issue.field === null) continue;
    const field = PROPOSAL_FIELD_OF_ISSUE[issue.field];
    if (field) blocked.add(field);
  }
  const voided = document.status === "voided";
  const current = currentValues(document);
  const proposed = extraction.reading ? proposedValues(extraction.reading, match) : null;
  return READING_PROPOSAL_FIELDS.map((field) => {
    const offer = proposed?.[field] ?? NONE;
    const now = current[field];
    const same = offer.value !== null && offer.value === now.value;
    const selectable = offer.value !== null && !same && !blocked.has(field) && !voided;
    return {
      field,
      proposed: offer.value,
      current: now.value,
      proposedLabel: offer.label,
      currentLabel: now.label,
      same,
      selectable,
      defaultChecked: selectable && now.value === null && !doubtful.has(field),
      partnerMatch: field === "partner" && offer.value !== null ? (match?.by ?? null) : null,
    };
  });
}

function isAllSaved(rows: readonly ProposalRow[]): boolean {
  const proposed = rows.filter((row) => row.proposed !== null);
  return proposed.length > 0 && proposed.every((row) => row.same);
}

function proposalRates(
  reading: StoredReading,
  status: RegistrationStatusAtDate,
  date: CalendarDate,
  rules: Iterable<TaxRateRule>,
): ProposalRate[] {
  return reading.rates.map((rate) => {
    const estimated = estimatePurchaseTaxCategory(rate.ratePercent, status);
    const rule = estimated === null ? undefined : resolveTaxRule(estimated, date, rules);
    return {
      ratePercent: rate.ratePercent,
      inclusiveAmount: BigInt(rate.inclusiveAmount),
      taxAmount: rate.taxAmount === null ? null : BigInt(rate.taxAmount),
      estimatedTaxCategory: estimated,
      deductiblePercent: rule?.deductiblePercent ?? null,
    };
  });
}

async function proposalOf(db: Db, document: ProposalDocument): Promise<ReadingProposal | null> {
  const extraction = parseDocumentExtraction(document.extraction);
  if (!extraction) return null;
  const { reading } = extraction;
  const match = reading ? matchReadingPartner(reading, await loadMatchablePartners(db)) : null;
  const rows = proposalRows(document, extraction, match);

  let rates: ProposalRate[] = [];
  let registrationStatus: RegistrationStatusAtDate = "unknown";
  if (reading) {
    const date = reading.transactionDate ?? todayInJapan();
    if (extraction.registry) registrationStatus = extraction.registry.status;
    else if (match) registrationStatus = partnerRegistrationAt(match.partner, date);
    const stored = await loadTaxRules(db);
    rates = proposalRates(
      reading,
      registrationStatus,
      date,
      stored.length > 0 ? stored : STANDARD_TAX_RATE_RULES,
    );
  }
  return {
    status: extraction.status,
    readAt: new Date(extraction.readAt),
    provider: extraction.provider,
    model: extraction.model,
    error: extraction.error,
    issues: extraction.issues,
    rows,
    rates,
    registry: extraction.registry,
    registryError: extraction.registryError,
    registrationStatus,
    allSaved: isAllSaved(rows),
    voided: document.status === "voided",
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The stored extraction of a document, checked; `null` when missing, old or broken. */
export async function getDocumentReading(
  db: Db,
  documentId: string,
): Promise<DocumentExtraction | null> {
  const row = await db.document.findUnique({
    where: { id: documentId },
    select: { extraction: true },
  });
  return row ? parseDocumentExtraction(row.extraction) : null;
}

/** The proposal section of the detail (20-reader §10.1); `null` when the document was not read. */
export async function buildReadingProposal(
  db: Db,
  documentId: string,
): Promise<ReadingProposal | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: proposalDocumentSelect,
  });
  return document ? proposalOf(db, document) : null;
}

/**
 * Other documents (not voided) with the same date and total and the same issuer (20-reader §4):
 * the same registration number, or the same name after `normalizeIssuerName`. A document counts
 * by its items (取引先・登録番号, the partner's number) or by its own reading.
 */
export async function findReadingDuplicates(
  db: Db,
  input: {
    documentId: string;
    txnDate: CalendarDate | null;
    amount: Money | null;
    registrationNumber: string | null;
    issuerName: string | null;
  },
): Promise<ReadingDuplicate[]> {
  const { txnDate, amount, registrationNumber } = input;
  const name = input.issuerName === null ? "" : normalizeIssuerName(input.issuerName);
  if (txnDate === null || amount === null || (registrationNumber === null && name === "")) {
    return [];
  }
  const rows = await db.document.findMany({
    where: {
      id: { not: input.documentId },
      status: { not: "voided" },
      OR: [
        { txnDate: toDbDate(txnDate), amount },
        {
          AND: [
            { extraction: { path: ["reading", "transactionDate"], equals: txnDate } },
            { extraction: { path: ["reading", "totalAmount"], equals: amount.toString() } },
            { extraction: { path: ["reading", "currency"], equals: "JPY" } },
          ],
        },
      ],
    },
    orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      originalName: true,
      partnerName: true,
      invoiceRegistrationNumber: true,
      extraction: true,
      partner: { select: { name: true, invoiceRegistrationNumber: true } },
    },
  });
  return rows
    .filter((row) => {
      const read = parseDocumentExtraction(row.extraction)?.reading ?? null;
      const numbers = [
        row.invoiceRegistrationNumber,
        row.partner?.invoiceRegistrationNumber,
        read?.registrationNumber,
      ];
      if (registrationNumber !== null && numbers.includes(registrationNumber)) return true;
      const names = [row.partner?.name, row.partnerName, read?.issuerName];
      return (
        name !== "" &&
        names.some((other) => typeof other === "string" && normalizeIssuerName(other) === name)
      );
    })
    .map((row) => ({
      documentId: row.id,
      label: row.originalName ?? `${DOCUMENT_KIND_LABELS[row.kind]} ${displayDate(txnDate)}`,
    }));
}

/**
 * The inbox of S6: not voided, unlinked or unsorted, never the file of an import. The same
 * condition as `INBOX_WHERE` of `documents.ts` (`countInboxDocuments`).
 */
const INBOX_WHERE: Prisma.DocumentWhereInput = {
  importBatches: { none: {} },
  OR: [
    { status: "inbox" },
    {
      status: "linked",
      OR: [{ txnDate: null }, { amount: null }, { partnerId: null, partnerName: null }],
    },
  ],
};

/** Inbox documents the provider can read and that were never read (failed readings count as read). */
const UNREAD_INBOX_WHERE: Prisma.DocumentWhereInput = {
  AND: [
    INBOX_WHERE,
    { mime: { in: [...READABLE_MIMES] } },
    { extraction: { equals: Prisma.AnyNull } },
  ],
};

/** 受信箱の一括読み取り (20-reader §10.2): oldest upload first. */
export async function listUnreadInboxDocuments(
  db: Db,
  options: { limit: number },
): Promise<UnreadInboxDocument[]> {
  return db.document.findMany({
    where: UNREAD_INBOX_WHERE,
    orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.trunc(options.limit)),
    select: { id: true, originalName: true, mime: true },
  });
}

export async function countUnreadInboxDocuments(db: Db): Promise<number> {
  return db.document.count({ where: UNREAD_INBOX_WHERE });
}

/** The reading state of each read document of `ids` (unread ones are absent). */
export async function loadReadingStates(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, ReadingState>> {
  const states = new Map<string, ReadingState>();
  if (ids.length === 0) return states;
  const documents = await db.document.findMany({
    where: { id: { in: [...ids] } },
    select: proposalDocumentSelect,
  });
  let partners: MatchablePartner[] | null = null;
  for (const document of documents) {
    const extraction = parseDocumentExtraction(document.extraction);
    if (!extraction) continue;
    if (extraction.status === "failed" || extraction.reading === null) {
      states.set(document.id, "failed");
      continue;
    }
    partners ??= await loadMatchablePartners(db);
    const match = matchReadingPartner(extraction.reading, partners);
    let state: ReadingState = extraction.issues.length > 0 ? "needs_review" : "proposed";
    if (isAllSaved(proposalRows(document, extraction, match))) state = "saved";
    states.set(document.id, state);
  }
  return states;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Stores a reading (20-reader §5.2) in one transaction: the document row is locked (a voided one is
 * refused), a proposal is checked (`validateReading` with the duplicates and the stored lookup),
 * `extraction` is written (no other item), then one usage row per call and `document.read`.
 */
export async function recordDocumentReading(
  db: Db,
  input: DocumentReadingRecord,
  options: WriteOptions,
): Promise<DocumentReadingResult> {
  const parsed = parseDocumentExtraction(input.extraction);
  if (!parsed) throw new TypeError("recordDocumentReading: not a version 1 extraction");
  const today = input.today ?? todayInJapan();
  return runInTransaction(db, async (tx) => {
    const document = await lockProposalDocument(tx, input.documentId);
    if (document.status === "voided") throw new SettingsError(VOIDED_IS_NOT_READ);

    let extraction = parsed;
    const reading = readingOf(parsed);
    if (parsed.status === "proposed" && reading) {
      const duplicates = await findReadingDuplicates(tx, {
        documentId: document.id,
        txnDate: reading.transactionDate,
        amount: reading.currency === "JPY" ? reading.totalAmount : null,
        registrationNumber: reading.registrationNumber,
        issuerName: reading.issuerName,
      });
      const issues = validateReading(reading, {
        today,
        duplicates,
        registry: readingRegistryOf(parsed.registry),
      });
      extraction = { ...parsed, issues };
    }

    await tx.document.update({
      where: { id: document.id },
      data: { extraction: toAuditJson(extraction) },
    });
    for (const call of input.usage) {
      await recordApiUsage(tx, { ...call, documentId: document.id, actor: options.actor });
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "document.read",
      entity: "document",
      entityId: document.id,
      after: readingAuditSummary(extraction),
    });
    return resultOf(extraction);
  });
}

/**
 * 読み取る (20-reader §5.1): the file is read, sent to the provider, checked and looked up at the
 * registry (when there is a lookup and the number is valid) outside any transaction, then stored
 * with `recordDocumentReading`. A `ReaderError` (refusal, truncation, …) is stored as a failed
 * reading with what it cost; any other error is thrown.
 */
export async function performDocumentReading(
  db: Db,
  deps: DocumentReadingDeps,
  input: DocumentReadingInput,
  options: WriteOptions,
): Promise<DocumentReadingResult> {
  const { documentId } = documentReadingSchema.parse(input);
  const today = deps.today ?? todayInJapan();
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, status: true, mime: true, storageKey: true, sha256: true },
  });
  if (!document) throw new SettingsError(NOT_FOUND);
  if (document.status === "voided") throw new SettingsError(VOIDED_IS_NOT_READ);
  if (!isReadableMime(document.mime)) {
    throw new SettingsError(READER_ERROR_MESSAGES.unsupported_mime);
  }

  const { reader } = deps;
  const readerCall = (
    outcome: "ok" | "failed",
    usage: ProviderUsage | null,
    error: string | null,
  ): ApiUsageCall => ({
    service: "reader",
    provider: reader.provider,
    model: reader.model,
    outcome,
    error,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costNanoUsd: usage ? readingCostNanoUsd(reader, usage) : 0n,
  });
  const head = { version: 1 as const, provider: reader.provider, model: reader.model };

  const bytes = await deps.readFile(document.storageKey);
  let usage: ProviderUsage | null = null;
  let reading: Reading;
  try {
    const answer = await reader.read({ bytes, mime: document.mime, sha256: document.sha256 });
    usage = answer.usage;
    reading = parseReading(answer.raw);
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    // A malformed answer was still billed: its usage is the provider's answer's.
    const billed = error.usage ?? usage;
    const extraction: DocumentExtraction = {
      ...head,
      status: "failed",
      readAt: new Date().toISOString(),
      reading: null,
      issues: [],
      registry: null,
      registryError: null,
      error: error.message,
    };
    return recordDocumentReading(
      db,
      { documentId, extraction, usage: [readerCall("failed", billed, error.message)], today },
      options,
    );
  }
  const readAt = new Date();
  const calls: ApiUsageCall[] = [readerCall("ok", usage, null)];

  let registry: StoredRegistry | null = null;
  let registryError: string | null = null;
  const number = reading.registrationNumber;
  if (deps.registry && number !== null && isValidInvoiceRegistrationNumber(number)) {
    const lookedUp = await lookupRegistrations(deps.registry, [number]);
    const registration = lookedUp.registrations.get(number);
    const errors = lookupErrors(lookedUp);
    if (errors.length > 0 || registration === undefined) {
      registryError = errors[0] ?? REGISTRY_LOOKUP_FAILED;
    } else {
      registry = toStoredRegistry(
        number,
        registration,
        reading.transactionDate ?? today,
        new Date(),
      );
    }
    calls.push({
      service: "registry",
      provider: lookupProvider(deps.registry),
      outcome: registryError === null ? "ok" : "failed",
      error: registryError,
      requestCount: lookedUp.requestCount,
      itemCount: 1,
    });
  }

  const extraction: DocumentExtraction = {
    ...head,
    status: "proposed",
    readAt: readAt.toISOString(),
    reading: toStoredReading(reading),
    issues: [],
    registry,
    registryError,
    error: null,
  };
  return recordDocumentReading(db, { documentId, extraction, usage: calls, today }, options);
}

function notSelectable(field: ReadingProposalField, row: ProposalRow | undefined): SettingsError {
  const label = READING_PROPOSAL_FIELD_LABELS[field];
  if (!row || row.proposed === null) {
    return new SettingsError(`${label}の提案はありません。画面を読み込み直してください`, {
      field,
    });
  }
  if (row.same) {
    return new SettingsError(`${label}は提案と同じ値です。画面を読み込み直してください`, {
      field,
    });
  }
  return new SettingsError(
    `${label}の提案は読み違いの可能性があるため保存できません。証憑を見て、項目の変更で入れてください`,
    { field },
  );
}

/**
 * 提案を保存 (20-reader §5.4): in one transaction the proposal is rebuilt from the stored reading
 * (the client sends only which items), each chosen item must be selectable, and the values are
 * saved with `updateDocument` (`document.update`). A voided document is refused.
 */
export async function applyDocumentReading(
  db: Db,
  input: DocumentReadingApplyInput,
  options: WriteOptions,
): Promise<DocumentDetail> {
  const data = documentReadingApplySchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const document = await lockProposalDocument(tx, data.documentId);
    if (document.status === "voided") throw new SettingsError(VOIDED_IS_FIXED);
    const proposal = await proposalOf(tx, document);
    if (!proposal || proposal.status === "failed") throw new SettingsError(NO_PROPOSAL);

    const patch: DocumentUpdateInput = { id: document.id };
    for (const field of data.fields) {
      const row = proposal.rows.find((candidate) => candidate.field === field);
      if (!row || !row.selectable || row.proposed === null) throw notSelectable(field, row);
      const value = row.proposed;
      switch (field) {
        case "kind":
          patch.kind = value;
          break;
        case "txnDate":
          patch.txnDate = value;
          break;
        case "amount":
          patch.amount = BigInt(value);
          break;
        case "partner":
          if (row.partnerMatch === null) patch.partnerName = value;
          else patch.partnerId = value;
          break;
        case "invoiceRegistrationNumber":
          patch.invoiceRegistrationNumber = value;
          break;
        case "note":
          patch.note = value;
          break;
      }
    }
    return updateDocument(tx, patch, options);
  });
}
