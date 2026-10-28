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
  type RuleAction,
  type RuleMatch,
  type Side,
} from "@niho-finance/ledger";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendAuditLog } from "./audit";
import { bootstrapStandardData } from "./bootstrap";
import { toDbDate } from "./dates";
import { newId } from "./ids";
import { postJournalEntryInTransaction, voidJournalEntryInTransaction } from "./journal";
import { ruleActionToJson, ruleMatchToJson } from "./rule-json";

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
  /** A book seeded before the statements existed got the rules and statement lines (no entries). */
  statementsAdded?: boolean;
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
  /** Names the posted entry for the seeded statement lines (`STATEMENT_LINES.entry`). */
  key?: string;
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

const PARTNERS: readonly {
  key: string;
  name: string;
  kind: "vendor" | "customer";
  nameKana?: string;
  defaults?: { account: string; segment: string; tax: string };
}[] = [
  { key: "cloud", name: "架空クラウド株式会社", kind: "vendor", nameKana: "カクウクラウド" },
  { key: "realty", name: "架空不動産株式会社", kind: "vendor", nameKana: "カクウフドウサン" },
  {
    key: "design",
    name: "架空デザイン合同会社",
    kind: "customer",
    nameKana: "カクウデザイン",
    defaults: { account: "4040", segment: "contract", tax: "sales_10" },
  },
];

const ENTRIES: SeedEntry[] = [
  {
    key: "capital",
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
    key: "cloud",
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
    key: "membership",
    date: "2026-11-20",
    description: "月会費",
    kind: "normal",
    lines: [
      { side: "debit", account: "1150", subAccount: "stripe", amount: 11_000n },
      { side: "credit", account: "4010", amount: 11_000n, tax: "sales_10", segment: "kamakura" },
    ],
  },
  {
    key: "stripeFee",
    date: "2026-11-20",
    description: "Stripe 決済手数料",
    kind: "normal",
    lines: [
      { side: "debit", account: "5400", amount: 396n, tax: "purchase_10", segment: "kamakura" },
      { side: "credit", account: "1150", subAccount: "stripe", amount: 396n },
    ],
  },
  {
    key: "payout",
    date: "2026-11-30",
    description: "Stripe からの入金",
    kind: "transfer",
    lines: [
      { side: "debit", account: "1100", subAccount: "bank", amount: 10_604n },
      { side: "credit", account: "1150", subAccount: "stripe", amount: 10_604n },
    ],
  },
  {
    key: "dropIn",
    date: "2026-12-01",
    description: "ドロップイン（現金）",
    kind: "normal",
    lines: [
      { side: "debit", account: "1000", subAccount: "cash", amount: 2_200n, segment: "kamakura" },
      { side: "credit", account: "4010", amount: 2_200n, tax: "sales_10", segment: "kamakura" },
    ],
  },
  {
    key: "bankFee",
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
    key: "books",
    date: "2026-12-15",
    description: "書籍代",
    kind: "normal",
    lines: [
      { side: "debit", account: "5420", amount: 1_980n, tax: "purchase_10", segment: "contract" },
      { side: "credit", account: "1100", subAccount: "bank", amount: 1_980n },
    ],
  },
  {
    key: "cardPayment",
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
    // A book seeded before the statements existed gets them once (no new entries).
    const statementsAdded = await seedStatementsIntoExistingBook(tx, existing.id);
    return {
      statementsAdded,
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
      nameKana: partner.nameKana ?? null,
      defaultAccountId: partner.defaults
        ? lookup(accountIds, partner.defaults.account, "account")
        : null,
      defaultSegmentId: partner.defaults
        ? lookup(segmentIds, partner.defaults.segment, "segment")
        : null,
      defaultTaxCategoryCode: partner.defaults?.tax ?? null,
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
  const entryIds = new Map<string, string>();
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
    if (seedEntry.key) entryIds.set(seedEntry.key, posted.id);
    if (seedEntry.voidReason) {
      await voidJournalEntryInTransaction(tx, posted.id, {
        reason: seedEntry.voidReason,
        actor: SEED_ACTOR,
      });
      entryCount += 1;
    }
  }

  const statements = await seedStatements(tx, {
    accountIds,
    segmentIds,
    partnerIds,
    entryIds,
    walletIds: new Map(
      (await tx.wallet.findMany({ select: { id: true, name: true } })).flatMap((row) => {
        const wallet = WALLETS.find((item) => item.name === row.name);
        return wallet ? [[wallet.sub, row.id] as const] : [];
      }),
    ),
  });

  await appendAuditLog(tx, {
    actor: SEED_ACTOR,
    action: "seed.apply",
    entity: "company",
    entityId: companyId,
    after: {
      fiscalYearId,
      accounts: CHART_TEMPLATE.length,
      entries: entryCount,
      rules: statements.rules,
      statementLines: statements.lines,
      pendingStatementLines: statements.pending,
    },
  });
  return { seeded: true, companyId, fiscalYearId, entryCount };
}

// ---------------------------------------------------------------------------
// 明細とルール (15-statements §12): settled lines linked to the entries above (no new entries, so
// the numbering and the trial balance stay as they are) and 12 pending lines that the keyboard
// settles with Enter and I alone (15 §6): rule ×4, partner ×1, history ×2, two transfer pairs, one
// posted transfer to match, one private purchase to ignore.
// ---------------------------------------------------------------------------

type SeedWallet = "bank" | "card" | "cash" | "stripe";

interface SeedRule {
  name: string;
  wallet: SeedWallet;
  match: Partial<RuleMatch>;
  action: {
    mode: RuleAction["mode"];
    account?: string;
    tax?: string;
    partner?: string;
    segment?: string;
    transferTo?: SeedWallet;
  };
  autoPost: boolean;
}

/** Created in this order (same priority: the older rule wins). */
const SEED_RULES: readonly SeedRule[] = [
  {
    name: "家賃",
    wallet: "bank",
    match: { descriptionContains: "カクウフドウサン", sign: "out" },
    action: {
      mode: "register",
      account: "5300",
      tax: "purchase_10",
      partner: "realty",
      segment: "kamakura",
    },
    autoPost: false,
  },
  {
    name: "Stripe の売上",
    wallet: "stripe",
    match: { descriptionContains: "決済", sign: "in" },
    action: { mode: "register", account: "4010", tax: "sales_10", segment: "kamakura" },
    autoPost: false,
  },
  {
    name: "振込手数料",
    wallet: "bank",
    match: { descriptionContains: "振込手数料", sign: "out" },
    action: { mode: "register", account: "5400", tax: "purchase_10", segment: "corporate" },
    autoPost: true,
  },
  {
    name: "Stripe の入金",
    wallet: "stripe",
    match: { descriptionContains: "入金（銀行へ）", sign: "out" },
    action: { mode: "transfer", transferTo: "bank" },
    autoPost: false,
  },
  {
    name: "ATM 引出",
    wallet: "bank",
    match: { descriptionContains: "ATM", sign: "out" },
    action: { mode: "transfer", transferTo: "cash" },
    autoPost: false,
  },
];

interface SeedStatementLine {
  wallet: SeedWallet;
  date: CalendarDate;
  amount: bigint;
  description: string;
  counterparty?: string;
  /** Stripe's `reporting_category`, as the imports store it (12-imports §4.3). */
  category?: string;
  /** Settled lines: the state and the seeded entry they point at. Left out → pending. */
  settled?: { status: "registered" | "transfer"; entry: string; rule?: number; auto?: boolean };
}

/**
 * Banks write half-width kana (「ｶ)ｶｸｳﾌﾄﾞｳｻﾝ」); the suggestions normalize it. Stripe lines are worded
 * as the Stripe sync writes them (「決済 …」「手数料 · 決済 …」「入金（銀行へ）」, 12-imports §4.3).
 */
const STATEMENT_LINES: readonly SeedStatementLine[] = [
  // Settled: linked to the sample entries.
  {
    wallet: "bank",
    date: "2026-11-02",
    amount: 50_000n,
    description: "振込 シホンキン ハライコミ",
    settled: { status: "registered", entry: "capital" },
  },
  {
    wallet: "card",
    date: "2026-11-05",
    amount: -1_650n,
    description: "カクウクラウド 利用料",
    settled: { status: "registered", entry: "cloud" },
  },
  {
    wallet: "stripe",
    date: "2026-11-20",
    amount: 11_000n,
    description: "決済 月会費 11月",
    category: "charge",
    settled: { status: "registered", entry: "membership", rule: 2 },
  },
  {
    wallet: "stripe",
    date: "2026-11-20",
    amount: -396n,
    description: "手数料 · 決済 月会費 11月",
    category: "fee",
    settled: { status: "registered", entry: "stripeFee" },
  },
  {
    wallet: "stripe",
    date: "2026-11-30",
    amount: -10_604n,
    description: "入金（銀行へ）",
    category: "payout",
    settled: { status: "transfer", entry: "payout" },
  },
  {
    wallet: "bank",
    date: "2026-11-30",
    amount: 10_604n,
    description: "振込 ｽﾄﾗｲﾌﾟｼﾞﾔﾊﾟﾝ(ｶ",
    settled: { status: "transfer", entry: "payout" },
  },
  {
    wallet: "cash",
    date: "2026-12-01",
    amount: 2_200n,
    description: "ドロップイン",
    settled: { status: "registered", entry: "dropIn" },
  },
  {
    wallet: "bank",
    date: "2026-12-10",
    amount: -145n,
    description: "振込手数料",
    settled: { status: "registered", entry: "bankFee", rule: 3, auto: true },
  },
  {
    wallet: "bank",
    date: "2026-12-15",
    amount: -1_980n,
    description: "Vデビット 架空書店",
    settled: { status: "registered", entry: "books" },
  },
  {
    wallet: "bank",
    date: "2026-12-27",
    amount: -1_650n,
    description: "カード引落 カクウカード",
    settled: { status: "transfer", entry: "cardPayment" },
  },
  // Pending (12).
  { wallet: "card", date: "2026-12-27", amount: 1_650n, description: "口座振替 お支払い" },
  { wallet: "card", date: "2027-01-05", amount: -1_650n, description: "カクウクラウド 利用料" },
  { wallet: "bank", date: "2027-01-05", amount: -88_000n, description: "振込 ｶ)ｶｸｳﾌﾄﾞｳｻﾝ" },
  { wallet: "card", date: "2027-01-08", amount: -1_200n, description: "コンビニ 私用" },
  {
    wallet: "bank",
    date: "2027-01-10",
    amount: 330_000n,
    description: "振込 ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ",
    counterparty: "ｶｸｳﾃﾞｻﾞｲﾝ(ﾄﾞ",
  },
  {
    wallet: "stripe",
    date: "2027-01-12",
    amount: 15_000n,
    description: "決済 月会費 1月",
    category: "charge",
  },
  {
    wallet: "stripe",
    date: "2027-01-12",
    amount: -540n,
    description: "手数料 · 決済 月会費 1月",
    category: "fee",
  },
  {
    wallet: "stripe",
    date: "2027-01-15",
    amount: -14_460n,
    description: "入金（銀行へ）",
    category: "payout",
  },
  { wallet: "bank", date: "2027-01-16", amount: 14_460n, description: "振込 ｽﾄﾗｲﾌﾟｼﾞﾔﾊﾟﾝ(ｶ" },
  { wallet: "bank", date: "2027-01-20", amount: -30_000n, description: "ATM 引出" },
  { wallet: "bank", date: "2027-01-27", amount: -9_870n, description: "カード引落 カクウカード" },
  { wallet: "card", date: "2027-01-27", amount: 9_870n, description: "口座振替 お支払い" },
];

async function seedStatements(
  tx: Prisma.TransactionClient,
  refs: {
    accountIds: ReadonlyMap<string, string>;
    segmentIds: ReadonlyMap<string, string>;
    partnerIds: ReadonlyMap<string, string>;
    entryIds: ReadonlyMap<string, string>;
    walletIds: ReadonlyMap<string, string>;
  },
): Promise<{ rules: number; lines: number; pending: number }> {
  const ruleIds: string[] = [];
  for (const rule of SEED_RULES) {
    const id = newId();
    const { action } = rule;
    const match: RuleMatch = {
      descriptionContains: null,
      descriptionRegex: null,
      counterpartyContains: null,
      amountMin: null,
      amountMax: null,
      sign: null,
      ...rule.match,
    };
    await tx.rule.create({
      data: {
        id,
        name: rule.name,
        walletId: lookup(refs.walletIds, rule.wallet, "wallet"),
        match: ruleMatchToJson(match),
        action: ruleActionToJson({
          mode: action.mode,
          accountId: action.account ? lookup(refs.accountIds, action.account, "account") : null,
          taxCategoryCode: action.tax ?? null,
          partnerId: action.partner ? lookup(refs.partnerIds, action.partner, "partner") : null,
          segmentId: action.segment ? lookup(refs.segmentIds, action.segment, "segment") : null,
          descriptionTemplate: null,
          transferToWalletId: action.transferTo
            ? lookup(refs.walletIds, action.transferTo, "wallet")
            : null,
          ignoredReason: null,
        }),
        autoPost: rule.autoPost,
      },
    });
    ruleIds.push(id);
  }

  const counters = new Map<SeedWallet, number>();
  let pending = 0;
  for (const line of STATEMENT_LINES) {
    const n = (counters.get(line.wallet) ?? 0) + 1;
    counters.set(line.wallet, n);
    const settled = line.settled;
    const ruleId = settled?.rule ? ruleIds[settled.rule - 1] : undefined;
    if (settled?.rule && !ruleId) throw new Error(`seed: unknown rule ${settled.rule}`);
    if (!settled) pending += 1;
    await tx.walletTransaction.create({
      data: {
        id: newId(),
        walletId: lookup(refs.walletIds, line.wallet, "wallet"),
        txnDate: toDbDate(line.date),
        amount: line.amount,
        descriptionRaw: line.description,
        counterpartyRaw: line.counterparty ?? null,
        category: line.category ?? null,
        externalId: `seed-${line.wallet}-${n}`,
        status: settled?.status ?? "pending",
        journalEntryId: settled ? lookup(refs.entryIds, settled.entry, "entry") : null,
        settledAt: settled ? new Date(`${line.date}T12:00:00+09:00`) : null,
        ruleId: ruleId ?? null,
        autoPosted: settled?.auto ?? false,
      },
    });
  }
  return { rules: ruleIds.length, lines: STATEMENT_LINES.length, pending };
}

/**
 * A book seeded before S5 (`seed.apply` without statements) gets the rules and the statement lines
 * once, so that `npm run db:seed` brings an existing development database up to date without a
 * reset. Only when it has no rule and no statement line yet and the sample wallets, partners and
 * entries are all still there; otherwise nothing is written. No entries are added.
 */
async function seedStatementsIntoExistingBook(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<boolean> {
  if ((await tx.rule.count()) > 0 || (await tx.walletTransaction.count()) > 0) return false;
  const accountIds = new Map(
    (await tx.account.findMany({ select: { id: true, code: true } })).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const segmentIds = new Map(
    (await tx.segment.findMany({ select: { id: true, code: true } })).map((row) => [
      row.code,
      row.id,
    ]),
  );
  const walletIds = new Map<string, string>();
  for (const row of await tx.wallet.findMany({ select: { id: true, name: true } })) {
    const wallet = WALLETS.find((item) => item.name === row.name);
    if (wallet) walletIds.set(wallet.sub, row.id);
  }
  const partnerIds = new Map<string, string>();
  for (const partner of PARTNERS) {
    const row = await tx.partner.findFirst({ where: { name: partner.name }, select: { id: true } });
    if (row) partnerIds.set(partner.key, row.id);
  }
  const entryIds = new Map<string, string>();
  for (const entry of ENTRIES) {
    if (!entry.key) continue;
    const row = await tx.journalEntry.findFirst({
      where: {
        entryDate: toDbDate(entry.date),
        description: entry.description,
        kind: entry.kind,
        status: "posted",
      },
      orderBy: { no: "asc" },
      select: { id: true },
    });
    if (row) entryIds.set(entry.key, row.id);
  }
  const wallets: readonly SeedWallet[] = ["bank", "card", "cash", "stripe"];
  const complete =
    wallets.every((key) => walletIds.has(key)) &&
    PARTNERS.every((partner) => partnerIds.has(partner.key)) &&
    ENTRIES.every((entry) => !entry.key || entryIds.has(entry.key));
  if (!complete) return false;

  // The kana and defaults the partner suggestion uses (15 §4), where the book has none yet.
  for (const partner of PARTNERS) {
    const id = lookup(partnerIds, partner.key, "partner");
    const row = await tx.partner.findUniqueOrThrow({ where: { id } });
    await tx.partner.update({
      where: { id },
      data: {
        nameKana: row.nameKana ?? partner.nameKana ?? null,
        defaultAccountId:
          row.defaultAccountId ??
          (partner.defaults ? (accountIds.get(partner.defaults.account) ?? null) : null),
        defaultSegmentId:
          row.defaultSegmentId ??
          (partner.defaults ? (segmentIds.get(partner.defaults.segment) ?? null) : null),
        defaultTaxCategoryCode: row.defaultTaxCategoryCode ?? partner.defaults?.tax ?? null,
      },
    });
  }
  const statements = await seedStatements(tx, {
    accountIds,
    segmentIds,
    partnerIds,
    entryIds,
    walletIds,
  });
  await appendAuditLog(tx, {
    actor: SEED_ACTOR,
    action: "seed.apply",
    entity: "company",
    entityId: companyId,
    after: {
      rules: statements.rules,
      statementLines: statements.lines,
      pendingStatementLines: statements.pending,
    },
  });
  return true;
}
