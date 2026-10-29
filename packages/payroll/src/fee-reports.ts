import { INPUT_TAX_ACCOUNT_CODE, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { StatementPayer } from "./statements";
import { digitsOnly, toFullWidth, toHalfWidth, warekiYear2 } from "./statements-csv";

/**
 * 報酬、料金、契約金及び賞金の支払調書 (22-payroll §12.2): the year's payments to individuals for
 * 所得税法第 204 条第 1 項 (税理士・弁護士・デザイン等), aggregated per payee from the journal lines of
 * 5410 支払報酬料 and 5110 業務委託費 and the 2300 預り金 of the same entries; the 合計表's rows; and
 * the e-Tax 309 CSV row (docs/research/etax-309-csv.md, 53 items). Pure: the database layer reads the
 * lines, the category (区分) is chosen on the report screen and never stored.
 */

/** The accounts whose lines are the payments (標準の勘定科目). */
export const FEE_ACCOUNT_CODES = ["5410", "5110"] as const;
export type FeeAccountCode = (typeof FEE_ACCOUNT_CODES)[number];

/** The 預り金 of the withholding (源泉所得税). */
export const FEE_WITHHOLDING_ACCOUNT_CODE = "2300";

/** 同じ人への年間の支払金額がこれを超えると支払調書を出す (所得税法施行規則第 84 条). */
export const FEE_REPORT_THRESHOLD = 50_000n;

/** 所得税法第 204 条第 1 項の号 (合計表の区分). */
export type FeeItemNo = 1 | 2;

export const FEE_ITEM_LABELS: Readonly<Record<FeeItemNo, string>> = {
  1: "原稿・デザイン等の報酬（1 号）",
  2: "弁護士・税理士等の報酬（2 号）",
};

/** 支払調書の 区分 (書面の記載要領の例) and its 号. */
export const FEE_CATEGORIES = {
  tax_accountant: { label: "税理士報酬", item: 2 },
  lawyer: { label: "弁護士報酬", item: 2 },
  judicial_scrivener: { label: "司法書士報酬", item: 2 },
  labor_consultant: { label: "社会保険労務士報酬", item: 2 },
  accountant: { label: "公認会計士報酬", item: 2 },
  patent_attorney: { label: "弁理士報酬", item: 2 },
  design: { label: "デザイン料", item: 1 },
  manuscript: { label: "原稿料", item: 1 },
  lecture: { label: "講演料", item: 1 },
  translation: { label: "翻訳料", item: 1 },
  photography: { label: "写真の報酬", item: 1 },
  other_item1: { label: "その他の報酬", item: 1 },
} as const satisfies Record<string, { label: string; item: FeeItemNo }>;
export type FeeCategory = keyof typeof FEE_CATEGORIES;
export const FEE_CATEGORY_KEYS = Object.keys(FEE_CATEGORIES) as FeeCategory[];

export function isFeeCategory(value: unknown): value is FeeCategory {
  return typeof value === "string" && Object.hasOwn(FEE_CATEGORIES, value);
}

/** The default 区分 by account: 5410 → 税理士等の報酬, 5110 → 原稿・デザイン等の報酬. */
export const FEE_DEFAULT_CATEGORIES: Readonly<Record<FeeAccountCode, FeeCategory>> = {
  "5410": "tax_accountant",
  "5110": "design",
};

/** One journal line of a payment account (signed: debit +, credit −), with its entry. */
export interface FeeJournalLine {
  entryId: string;
  entryNo: number;
  entryDate: CalendarDate;
  accountCode: FeeAccountCode;
  partnerId: string | null;
  /** 支払金額 (tax-inclusive, see `feeLinesOfEntries`), signed. */
  amount: Money;
}

/** A line of an entry with a payment line, as posted. */
export interface FeeEntryLine {
  accountCode: string;
  side: "debit" | "credit";
  /** Positive, as posted. */
  amount: Money;
  /** The consumption tax of the line (contained in it, or split off to 1400 仮払消費税). */
  taxAmount: Money;
  partnerId: string | null;
}

/** A posted entry (not voided, not a reversal) with at least one line of 5410 / 5110. */
export interface FeeEntry {
  id: string;
  no: number;
  date: CalendarDate;
  lines: readonly FeeEntryLine[];
}

const signedAmount = (line: FeeEntryLine) => (line.side === "debit" ? line.amount : -line.amount);

const isFeeAccount = (code: string): code is FeeAccountCode =>
  (FEE_ACCOUNT_CODES as readonly string[]).includes(code);

/**
 * The payment lines and the 預り金 of the entries (§12.2). The rule of 支払金額 (tax-inclusive):
 *
 *   a 5410 / 5110 line's own amount (debit +, credit −) + its share of the entry's 1400 仮払消費税
 *   lines (debit − credit), shared by the lines' `taxAmount`.
 *
 * It holds for both ways the books record a purchase: a 伝票 keeps the tax in the line (taxAmount
 * only, no 1400 line → the line's amount), a 支出 of a 税抜経理 year books the line without the tax and
 * the tax on a 1400 line (→ the line + that tax). As every entry balances, for an entry of only the
 * fee, its tax and the payment it is the same as the payment side's credits (口座・未払金) plus the
 * 2300 預り金 — but unlike that it stays right when the entry also books other costs. When the 1400
 * lines cannot be shared by `taxAmount` (no line carries one), they go to the fee lines only if every
 * other debit is a tax line, by the fee lines' amounts; otherwise they are left out.
 *
 * 源泉徴収税額 is the entry's 2300 預り金 (credit − debit), put to its payee by `aggregateFeePayments`.
 */
export function feeLinesOfEntries(entries: readonly FeeEntry[]): {
  lines: FeeJournalLine[];
  withholding: FeeWithholdingLine[];
} {
  const lines: FeeJournalLine[] = [];
  const withholding: FeeWithholdingLine[] = [];
  for (const entry of entries) {
    const fees = entry.lines.filter((line) => isFeeAccount(line.accountCode));
    const taxLines = entry.lines.filter((line) => line.accountCode === INPUT_TAX_ACCOUNT_CODE);
    const tax = taxLines.reduce((total, line) => total + signedAmount(line), 0n);
    const weightOf = (line: FeeEntryLine) =>
      line.side === "debit" ? line.taxAmount : -line.taxAmount;
    const weighted = entry.lines.filter(
      (line) => line.accountCode !== INPUT_TAX_ACCOUNT_CODE && line.taxAmount !== 0n,
    );
    const allWeight = weighted.reduce((total, line) => total + weightOf(line), 0n);
    let shares: Money[];
    if (tax === 0n || fees.length === 0) {
      shares = fees.map(() => 0n);
    } else if (allWeight !== 0n) {
      const feeWeight = fees.reduce((total, line) => total + weightOf(line), 0n);
      shares = splitByWeight((tax * feeWeight) / allWeight, fees.map(weightOf));
    } else if (
      entry.lines.every(
        (line) =>
          line.side === "credit" ||
          isFeeAccount(line.accountCode) ||
          line.accountCode === INPUT_TAX_ACCOUNT_CODE,
      )
    ) {
      shares = splitByWeight(tax, fees.map(signedAmount));
    } else {
      shares = fees.map(() => 0n);
    }
    fees.forEach((line, index) => {
      lines.push({
        entryId: entry.id,
        entryNo: entry.no,
        entryDate: entry.date,
        accountCode: line.accountCode as FeeAccountCode,
        partnerId: line.partnerId,
        amount: signedAmount(line) + (shares[index] ?? 0n),
      });
    });
    for (const line of entry.lines) {
      if (line.accountCode !== FEE_WITHHOLDING_ACCOUNT_CODE) continue;
      withholding.push({
        entryId: entry.id,
        partnerId: line.partnerId,
        amount: line.side === "credit" ? line.amount : -line.amount,
      });
    }
  }
  return { lines, withholding };
}

/** `total` split by `weights` (whole yen; the last weighted line takes the rest). */
function splitByWeight(total: Money, weights: readonly Money[]): Money[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n) return weights.map((_, index) => (index === weights.length - 1 ? total : 0n));
  const shares = weights.map((weight) => (total * weight) / sum);
  const rest = total - shares.reduce((acc, share) => acc + share, 0n);
  let last = -1;
  weights.forEach((weight, index) => {
    if (weight !== 0n) last = index;
  });
  if (last >= 0) shares[last] = (shares[last] ?? 0n) + rest;
  return shares;
}

/** One 2300 預り金 line of the same entries (signed: credit +, debit −). */
export interface FeeWithholdingLine {
  entryId: string;
  partnerId: string | null;
  amount: Money;
}

/** A partner as the report needs it. */
export interface FeePartner {
  id: string;
  name: string;
  address: string | null;
  /** 個人 / 法人 / 未確認 (`null`). Only 個人 get a 支払調書. */
  isIndividual: boolean | null;
}

/** One 支払内容 (区分 by account) of a payee. */
export interface FeePayeeItem {
  accountCode: FeeAccountCode;
  category: FeeCategory;
  paid: Money;
  withheld: Money;
}

export interface FeePayee {
  partner: FeePartner;
  items: FeePayeeItem[];
  paid: Money;
  withheld: Money;
  /** The entries the amounts came from (仕訳 No.). */
  entries: { id: string; no: number; date: CalendarDate }[];
  /** 個人 and paid > 5 万円: a 支払調書 is made. */
  reportable: boolean;
}

export interface FeeAggregation {
  /** Every partner paid through the accounts in the year, by name. */
  payees: FeePayee[];
  /** Lines without a partner (the owner sets one on the entry). */
  unassigned: { entryId: string; entryNo: number; amount: Money }[];
  /** Entries whose 預り金 could not be put to one payee (several payees, no partner on the line). */
  ambiguousWithholding: { entryId: string; entryNo: number; amount: Money }[];
}

/**
 * Aggregates the year's lines per partner and account (§12.2): the payment is the sum of the 5410 /
 * 5110 lines' 支払金額 (`feeLinesOfEntries`; posted entries, a voided entry and its reversal both left
 * out by the caller), the 源泉徴収税額 is the net credit of 2300 預り金 of the same entries — put to the
 * line's partner when it has one, else to the entry's only payee (and that payee's largest account).
 * `categories` picks the 区分 per `<partnerId>.<accountCode>` (default by account).
 */
export function aggregateFeePayments(input: {
  lines: readonly FeeJournalLine[];
  withholding: readonly FeeWithholdingLine[];
  partners: readonly FeePartner[];
  categories?: Readonly<Record<string, FeeCategory>>;
}): FeeAggregation {
  const partners = new Map(input.partners.map((partner) => [partner.id, partner]));
  const amounts = new Map<string, { paid: Money; withheld: Money }>();
  const entries = new Map<string, Map<string, { id: string; no: number; date: CalendarDate }>>();
  const unassigned: FeeAggregation["unassigned"] = [];
  const ambiguousWithholding: FeeAggregation["ambiguousWithholding"] = [];
  const key = (partnerId: string, accountCode: string) => `${partnerId}.${accountCode}`;
  const byEntry = new Map<string, FeeJournalLine[]>();
  for (const line of input.lines) {
    if (line.partnerId === null || !partners.has(line.partnerId)) {
      unassigned.push({ entryId: line.entryId, entryNo: line.entryNo, amount: line.amount });
      continue;
    }
    const slot = amounts.get(key(line.partnerId, line.accountCode)) ?? { paid: 0n, withheld: 0n };
    slot.paid += line.amount;
    amounts.set(key(line.partnerId, line.accountCode), slot);
    byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
    const seen =
      entries.get(line.partnerId) ??
      new Map<string, { id: string; no: number; date: CalendarDate }>();
    seen.set(line.entryId, { id: line.entryId, no: line.entryNo, date: line.entryDate });
    entries.set(line.partnerId, seen);
  }
  for (const line of input.withholding) {
    const feeLines = byEntry.get(line.entryId) ?? [];
    const payees = [...new Set(feeLines.map((fee) => fee.partnerId as string))];
    const partnerId =
      line.partnerId !== null && payees.includes(line.partnerId)
        ? line.partnerId
        : payees.length === 1
          ? payees[0]!
          : null;
    if (partnerId === null) {
      const first = feeLines[0];
      if (first) {
        ambiguousWithholding.push({
          entryId: line.entryId,
          entryNo: first.entryNo,
          amount: line.amount,
        });
      }
      continue;
    }
    const own = feeLines.filter((fee) => fee.partnerId === partnerId);
    const largest = own.reduce((best, fee) => (fee.amount > best.amount ? fee : best), own[0]!);
    const slot = amounts.get(key(partnerId, largest.accountCode));
    if (slot) slot.withheld += line.amount;
  }
  const payees: FeePayee[] = [];
  for (const [partnerId, partner] of partners) {
    const items: FeePayeeItem[] = FEE_ACCOUNT_CODES.flatMap((accountCode) => {
      const slot = amounts.get(key(partnerId, accountCode));
      if (!slot || (slot.paid === 0n && slot.withheld === 0n)) return [];
      const chosen = input.categories?.[key(partnerId, accountCode)];
      return [
        {
          accountCode,
          category: chosen ?? FEE_DEFAULT_CATEGORIES[accountCode],
          paid: slot.paid,
          withheld: slot.withheld,
        },
      ];
    });
    if (items.length === 0) continue;
    const paid = items.reduce((total, item) => total + item.paid, 0n);
    const withheld = items.reduce((total, item) => total + item.withheld, 0n);
    payees.push({
      partner,
      items,
      paid,
      withheld,
      entries: [...(entries.get(partnerId)?.values() ?? [])].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.no - b.no,
      ),
      reportable: partner.isIndividual === true && paid > FEE_REPORT_THRESHOLD,
    });
  }
  payees.sort((a, b) => a.partner.name.localeCompare(b.partner.name, "ja"));
  return { payees, unassigned, ambiguousWithholding };
}

/** One row of 報酬、料金、契約金及び賞金の支払調書合計表 (人員・支払金額・源泉徴収税額). */
export interface FeeTotalsRow {
  people: number;
  paid: Money;
  withheld: Money;
  /** うち 支払調書を提出するもの. */
  reported: { people: number; paid: Money };
}

export interface FeeTotals {
  /** By 区分 (the categories chosen). */
  byCategory: { category: FeeCategory; row: FeeTotalsRow }[];
  /** By 号 (合計表の区分). */
  byItem: { item: FeeItemNo; row: FeeTotalsRow }[];
  total: FeeTotalsRow;
}

const emptyFeeRow = (): FeeTotalsRow => ({
  people: 0,
  paid: 0n,
  withheld: 0n,
  reported: { people: 0, paid: 0n },
});

/**
 * The 合計表's rows of the individual payees (§12.2): per 区分 and per 号, the people, the payments
 * and the tax, and of them the ones with a 支払調書 (> 5 万円). A payee with two 区分 counts once in
 * each row it is in.
 */
export function feeReportTotals(payees: readonly FeePayee[]): FeeTotals {
  const byCategory = new Map<FeeCategory, FeeTotalsRow>();
  const byItem = new Map<FeeItemNo, FeeTotalsRow>();
  const total = emptyFeeRow();
  const add = (row: FeeTotalsRow, paid: Money, withheld: Money, reportable: boolean) => {
    row.people += 1;
    row.paid += paid;
    row.withheld += withheld;
    if (reportable) {
      row.reported.people += 1;
      row.reported.paid += paid;
    }
  };
  for (const payee of payees) {
    if (payee.partner.isIndividual !== true) continue;
    add(total, payee.paid, payee.withheld, payee.reportable);
    const items = new Map<FeeItemNo, { paid: Money; withheld: Money }>();
    for (const line of payee.items) {
      const row = byCategory.get(line.category) ?? emptyFeeRow();
      add(row, line.paid, line.withheld, payee.reportable);
      byCategory.set(line.category, row);
      const item = FEE_CATEGORIES[line.category].item;
      const sum = items.get(item) ?? { paid: 0n, withheld: 0n };
      sum.paid += line.paid;
      sum.withheld += line.withheld;
      items.set(item, sum);
    }
    for (const [item, sum] of items) {
      const row = byItem.get(item) ?? emptyFeeRow();
      add(row, sum.paid, sum.withheld, payee.reportable);
      byItem.set(item, row);
    }
  }
  return {
    byCategory: FEE_CATEGORY_KEYS.flatMap((category) => {
      const row = byCategory.get(category);
      return row ? [{ category, row }] : [];
    }),
    byItem: ([1, 2] as const).flatMap((item) => {
      const row = byItem.get(item);
      return row ? [{ item, row }] : [];
    }),
    total,
  };
}

// ---------------------------------------------------------------------------------------------
// e-Tax 309 CSV (53 items)
// ---------------------------------------------------------------------------------------------

export const FEE_CSV_FIELD_COUNT = 53;

/** 支払内容 per record (more go to another record of the same payee). */
export const FEE_CSV_ITEMS_PER_RECORD = 6;

export interface FeeCsvOptions {
  /** 訂正表示: `1` makes the record void (無効とするレコード); default 0. */
  correction?: 0 | 1;
  /** 支払を受ける者の個人番号 (12 digits, padded to 13 with a leading 0) or 法人番号 (13), typed on the form. */
  payeeNumber?: string;
  /** 摘要 (全角 100). */
  remarks?: string;
}

/** A 個人番号 (12) or 法人番号 (13) as the 309 CSV records it: 13 digits, else empty. */
function numberOf(value: string | null | undefined): string {
  const digits = digitsOnly(value ?? "");
  if (digits.length === 12) return `0${digits}`;
  return digits.length === 13 ? digits : "";
}

/**
 * The records of one payee in the e-Tax 309 CSV (docs/research/etax-309-csv.md): 53 items each, up
 * to 6 支払内容 (区分・細目・支払金額・未払金額・源泉徴収税額・未徴収税額) per record, more in another
 * record. 年分 in 和暦 2 digits; 全角 / 半角 per item; the payee's number only from `options`.
 */
export function feeReportCsvRows(
  year: number,
  payer: StatementPayer,
  payee: FeePayee,
  options: FeeCsvOptions = {},
): string[][] {
  const chunks: FeePayeeItem[][] = [];
  for (let index = 0; index < payee.items.length; index += FEE_CSV_ITEMS_PER_RECORD) {
    chunks.push(payee.items.slice(index, index + FEE_CSV_ITEMS_PER_RECORD));
  }
  return chunks.map((items) => {
    const contents = Array.from({ length: FEE_CSV_ITEMS_PER_RECORD }, (_, index) => {
      const item = items[index];
      if (!item) return ["", "", "", "", "", ""];
      return [
        toFullWidth(FEE_CATEGORIES[item.category].label),
        "",
        item.paid.toString(),
        "",
        item.withheld.toString(),
        "",
      ];
    }).flat();
    const fields = [
      /* 1 法定資料の種類 */ "309",
      /* 2 整理番号 1 */ "",
      /* 3 本支店等区分番号 */ "",
      /* 4 提出義務者の住所又は所在地 */ toFullWidth(payer.address),
      /* 5 提出義務者の氏名又は名称 */ toFullWidth(payer.name),
      /* 6 提出義務者の電話番号 */ toHalfWidth(payer.phone ?? ""),
      /* 7 整理番号 2 */ "",
      /* 8 提出者の住所 */ "",
      /* 9 提出者の氏名又は名称 */ "",
      /* 10 訂正表示 */ String(options.correction ?? 0),
      /* 11 年分 */ warekiYear2(year),
      /* 12 支払を受ける者－住所又は所在地 */ toFullWidth(payee.partner.address ?? ""),
      /* 13 支払を受ける者－国外住所表示 */ "0",
      /* 14 支払を受ける者－氏名又は名称 */ toFullWidth(payee.partner.name),
      /* 15〜50 支払内容 (1)〜(6) */ ...contents,
      /* 51 摘要 */ toFullWidth(options.remarks ?? ""),
      /* 52 提出義務者の個人番号又は法人番号 */ numberOf(payer.corporateNumber),
      /* 53 支払を受ける者の個人番号又は法人番号 */ numberOf(options.payeeNumber),
    ];
    if (fields.length !== FEE_CSV_FIELD_COUNT) {
      throw new Error(`feeReportCsvRows: ${fields.length} items instead of ${FEE_CSV_FIELD_COUNT}`);
    }
    return fields;
  });
}
