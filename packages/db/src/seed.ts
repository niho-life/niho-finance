/**
 * Fictional seed data for local development and tests. Everything here is made up:
 * no real company, account number, registration number or Stripe ID may appear in this file.
 */
import {
  CHART_TEMPLATE,
  inclusiveTaxAmount,
  resolveTaxRule,
  STANDARD_TAX_RATE_RULES,
  type CalendarDate,
  type EntryKind,
  type JournalLineInput,
  type Side,
} from "@niho-finance/ledger";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendAuditLog } from "./audit";
import { bootstrapStandardData } from "./bootstrap";
import { toDbDate } from "./dates";
import { newId } from "./ids";
import { postJournalEntryInTransaction, voidJournalEntryInTransaction } from "./journal";

export const SEED_ACTOR = "seed";

export const SEED_COMPANY = {
  name: "架空商会株式会社",
  nameKana: "カクウショウカイ",
  address: "東京都架空区見本町 1-2-3",
  representative: "代表取締役 架空 太郎",
  foundedOn: "2026-11-02" satisfies CalendarDate,
  fiscalYearStartMonth: 4,
} as const;

export const SEED_FISCAL_YEAR = {
  no: 1,
  startDate: "2026-11-02",
  endDate: "2027-03-31",
} as const satisfies { no: number; startDate: CalendarDate; endDate: CalendarDate };

export interface SeedResult {
  /** `false` when the database already had a company (the seed never runs twice). */
  seeded: boolean;
  companyId: string;
  fiscalYearId: string;
  entryCount: number;
}

interface SeedLine {
  side: Side;
  account: string;
  amount: bigint;
  tax?: string;
  segment?: string;
  subAccount?: string;
  partner?: string;
  description?: string;
}

interface SeedEntry {
  date: CalendarDate;
  description: string;
  kind: EntryKind;
  lines: SeedLine[];
  /** Voided right after posting (reason), to show a correction in the sample data. */
  voidReason?: string;
}

const SUB_ACCOUNTS = [
  { key: "bank", account: "1100", name: "架空銀行 普通" },
  { key: "card", account: "2100", name: "架空カード" },
  { key: "cash", account: "1000", name: "本社" },
  { key: "stripe", account: "1150", name: "platform" },
  { key: "owner", account: "2400", name: "役員立替" },
] as const;

const WALLETS = [
  { name: "架空銀行 普通", kind: "bank", sub: "bank", segment: undefined, importer: null },
  { name: "架空カード", kind: "card", sub: "card", segment: undefined, importer: null },
  { name: "現金", kind: "cash", sub: "cash", segment: "corporate", importer: null },
  {
    name: "Stripe platform",
    kind: "stripe",
    sub: "stripe",
    segment: "platform",
    importer: "stripe",
  },
  { name: "役員立替", kind: "owner", sub: "owner", segment: undefined, importer: null },
] as const;

const PARTNERS = [
  { key: "cloud", name: "架空クラウド株式会社", kind: "vendor" },
  { key: "realty", name: "架空不動産株式会社", kind: "vendor" },
  { key: "design", name: "架空デザイン合同会社", kind: "customer" },
] as const;

const ENTRIES: SeedEntry[] = [
  {
    date: "2026-11-02",
    description: "資本金の払込",
    kind: "opening",
    lines: [
      { side: "debit", account: "1100", subAccount: "bank", amount: 50_000n },
      { side: "credit", account: "3000", amount: 50_000n },
    ],
  },
  {
    date: "2026-11-02",
    description: "設立費用（役員立替）",
    kind: "opening",
    lines: [
      {
        side: "debit",
        account: "1700",
        amount: 150_000n,
        tax: "purchase_out",
        description: "登録免許税",
      },
      {
        side: "debit",
        account: "1700",
        amount: 15_000n,
        tax: "purchase_exempt",
        description: "定款認証",
      },
      { side: "credit", account: "2400", subAccount: "owner", amount: 165_000n },
    ],
  },
  {
    date: "2026-11-05",
    description: "クラウドサービス利用料",
    kind: "normal",
    lines: [
      {
        side: "debit",
        account: "5320",
        amount: 1_650n,
        tax: "purchase_10",
        segment: "platform",
        partner: "cloud",
      },
      { side: "credit", account: "2100", subAccount: "card", amount: 1_650n },
    ],
  },
  {
    date: "2026-11-10",
    description: "事務用品（役員立替）",
    kind: "normal",
    lines: [
      { side: "debit", account: "5330", amount: 3_300n, tax: "purchase_10", segment: "corporate" },
      { side: "credit", account: "2400", subAccount: "owner", amount: 3_300n },
    ],
  },
  {
    date: "2026-11-20",
    description: "月会費",
    kind: "normal",
    lines: [
      { side: "debit", account: "1150", subAccount: "stripe", amount: 11_000n },
      { side: "credit", account: "4010", amount: 11_000n, tax: "sales_10", segment: "kamakura" },
    ],
  },
  {
    date: "2026-11-20",
    description: "Stripe 決済手数料",
    kind: "normal",
    lines: [
      { side: "debit", account: "5400", amount: 396n, tax: "purchase_10", segment: "kamakura" },
      { side: "credit", account: "1150", subAccount: "stripe", amount: 396n },
    ],
  },
  {
    date: "2026-11-30",
    description: "Stripe からの入金",
    kind: "transfer",
    lines: [
      { side: "debit", account: "1100", subAccount: "bank", amount: 10_604n },
      { side: "credit", account: "1150", subAccount: "stripe", amount: 10_604n },
    ],
  },
  {
    date: "2026-12-01",
    description: "ドロップイン（現金）",
    kind: "normal",
    lines: [
      { side: "debit", account: "1000", subAccount: "cash", amount: 2_200n, segment: "kamakura" },
      { side: "credit", account: "4010", amount: 2_200n, tax: "sales_10", segment: "kamakura" },
    ],
  },
  {
    date: "2026-12-10",
    description: "振込手数料",
    kind: "normal",
    lines: [
      { side: "debit", account: "5400", amount: 145n, tax: "purchase_10", segment: "corporate" },
      { side: "credit", account: "1100", subAccount: "bank", amount: 145n },
    ],
  },
  {
    date: "2026-12-15",
    description: "書籍代",
    kind: "normal",
    voidReason: "金額の誤り",
    lines: [
      { side: "debit", account: "5420", amount: 2_000n, tax: "purchase_10", segment: "contract" },
      { side: "credit", account: "1100", subAccount: "bank", amount: 2_000n },
    ],
  },
  {
    date: "2026-12-15",
    description: "書籍代",
    kind: "normal",
    lines: [
      { side: "debit", account: "5420", amount: 1_980n, tax: "purchase_10", segment: "contract" },
      { side: "credit", account: "1100", subAccount: "bank", amount: 1_980n },
    ],
  },
  {
    date: "2026-12-27",
    description: "カード引落",
    kind: "transfer",
    lines: [
      { side: "debit", account: "2100", subAccount: "card", amount: 1_650n },
      { side: "credit", account: "1100", subAccount: "bank", amount: 1_650n },
    ],
  },
];

function lookup<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`seed: unknown ${what} "${key}"`);
  return value;
}

/**
 * Seeds an empty database in one transaction: company, first fiscal year, tax categories and
 * rules, segments, the standard chart, sub-accounts, wallets, partners and sample entries
 * (posted through `postJournalEntry`, so the ledger rules and numbering apply).
 */
export async function seedDatabase(prisma: PrismaClient): Promise<SeedResult> {
  return prisma.$transaction((tx) => seedInTransaction(tx), { maxWait: 10_000, timeout: 120_000 });
}

async function seedInTransaction(tx: Prisma.TransactionClient): Promise<SeedResult> {
  const existing = await tx.company.findFirst({ select: { id: true } });
  if (existing) {
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: { companyId: existing.id },
      orderBy: { no: "asc" },
    });
    return {
      seeded: false,
      companyId: existing.id,
      fiscalYearId: fiscalYear?.id ?? "",
      entryCount: 0,
    };
  }

  const companyId = newId();
  await tx.company.create({
    data: { id: companyId, ...SEED_COMPANY, foundedOn: toDbDate(SEED_COMPANY.foundedOn) },
  });
  const fiscalYearId = newId();
  await tx.fiscalYear.create({
    data: {
      id: fiscalYearId,
      companyId,
      no: SEED_FISCAL_YEAR.no,
      startDate: toDbDate(SEED_FISCAL_YEAR.startDate),
      endDate: toDbDate(SEED_FISCAL_YEAR.endDate),
      status: "open",
      consumptionTax: "exempt",
      accountingMethod: "tax_inclusive",
    },
  });

  // Tax categories, rate rules, segments and the chart: the same standard data as the setup's Step 3.
  await bootstrapStandardData(tx, { actor: SEED_ACTOR });
  const segmentIds = new Map(
    (await tx.segment.findMany({ select: { id: true, code: true } })).map((segment) => [
      segment.code,
      segment.id,
    ]),
  );
  const accountIds = new Map(
    (await tx.account.findMany({ select: { id: true, code: true } })).map((account) => [
      account.code,
      account.id,
    ]),
  );

  const subAccountIds = new Map<string, string>(SUB_ACCOUNTS.map((sub) => [sub.key, newId()]));
  await tx.subAccount.createMany({
    data: SUB_ACCOUNTS.map((sub) => ({
      id: lookup(subAccountIds, sub.key, "sub-account"),
      accountId: lookup(accountIds, sub.account, "account"),
      name: sub.name,
    })),
  });

  const subAccountByKey = new Map<string, (typeof SUB_ACCOUNTS)[number]>(
    SUB_ACCOUNTS.map((sub) => [sub.key, sub]),
  );
  await tx.wallet.createMany({
    data: WALLETS.map((wallet) => {
      const subAccount = lookup(subAccountByKey, wallet.sub, "sub-account");
      return {
        id: newId(),
        name: wallet.name,
        kind: wallet.kind,
        accountId: lookup(accountIds, subAccount.account, "account"),
        subAccountId: lookup(subAccountIds, wallet.sub, "sub-account"),
        importer: wallet.importer,
        defaultSegmentId: wallet.segment ? lookup(segmentIds, wallet.segment, "segment") : null,
      };
    }),
  });

  const partnerIds = new Map<string, string>(PARTNERS.map((partner) => [partner.key, newId()]));
  await tx.partner.createMany({
    data: PARTNERS.map((partner) => ({
      id: lookup(partnerIds, partner.key, "partner"),
      name: partner.name,
      kind: partner.kind,
    })),
  });

  await tx.memoTag.create({ data: { id: newId(), name: "設立" } });
  await tx.user.create({
    data: { id: newId(), email: "owner@example.com", name: "架空 太郎", role: "owner" },
  });
  await tx.calendarItem.create({
    data: {
      id: newId(),
      fiscalYearId,
      kind: "filing",
      title: "法人税等の確定申告・納付",
      dueDate: toDbDate("2027-05-31"),
      ruleKey: "corporate_tax_return",
    },
  });

  let entryCount = 0;
  for (const seedEntry of ENTRIES) {
    const lines: JournalLineInput[] = seedEntry.lines.map((line) => {
      const taxCategoryCode = line.tax ?? "na";
      const rule = resolveTaxRule(taxCategoryCode, seedEntry.date, STANDARD_TAX_RATE_RULES);
      return {
        side: line.side,
        accountId: lookup(accountIds, line.account, "account"),
        subAccountId: line.subAccount
          ? lookup(subAccountIds, line.subAccount, "sub-account")
          : null,
        amount: line.amount,
        taxCategoryCode,
        // Tax-inclusive (exempt) year: keep the contained tax for reference reports only.
        taxAmount: rule ? inclusiveTaxAmount(line.amount, rule.ratePercent) : 0n,
        segmentId: line.segment ? lookup(segmentIds, line.segment, "segment") : null,
        partnerId: line.partner ? lookup(partnerIds, line.partner, "partner") : null,
        description: line.description ?? null,
      };
    });
    const posted = await postJournalEntryInTransaction(
      tx,
      {
        fiscalYearId,
        entryDate: seedEntry.date,
        description: seedEntry.description,
        kind: seedEntry.kind,
        sourceKind: "manual",
        lines,
      },
      { actor: SEED_ACTOR },
    );
    entryCount += 1;
    if (seedEntry.voidReason) {
      await voidJournalEntryInTransaction(tx, posted.id, {
        reason: seedEntry.voidReason,
        actor: SEED_ACTOR,
      });
      entryCount += 1;
    }
  }

  await appendAuditLog(tx, {
    actor: SEED_ACTOR,
    action: "seed.apply",
    entity: "company",
    entityId: companyId,
    after: { fiscalYearId, accounts: CHART_TEMPLATE.length, entries: entryCount },
  });
  return { seeded: true, companyId, fiscalYearId, entryCount };
}
