/**
 * 消費税の集計 (17-financial-statements §8): sales and purchases per tax category and estimates of
 * both 本則課税 and 簡易課税, as material for checking and deciding (the return itself is the tax
 * accountant's, 09 D6).
 *
 * The lines are those of the year with a sales / purchase category (voided entries and their
 * reversals both included, the year's closing entries left out). Sales count credit-positive,
 * purchases debit-positive, so returns are netted. In tax-exclusive years the tax comes from the
 * 仮受消費税 (2310) / 仮払消費税 (1400) lines, allocated to the taxable lines of the same direction in
 * the same entry by their tax (largest remainder); a tax line in an entry without such a line (the
 * year-end settlement) is left out. In tax-inclusive years (exempt ones too) it is the line's
 * `taxAmount`, and 経過措置 purchases count `deductiblePercent` of it.
 */
import {
  getTaxCategory,
  INPUT_TAX_ACCOUNT_CODE,
  OUTPUT_TAX_ACCOUNT_CODE,
  resolveTaxRule,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type Money,
  type TaxRateRule,
} from "@niho-finance/ledger";
import { csvText, encodeCsv } from "../csv";
import { reportFileName, slashDate } from "../format";
import type { ReportEntry, ReportLine } from "../source";
import {
  DEEMED_PURCHASE_PERCENT,
  DEFAULT_SIMPLIFIED_TAX_CLASS,
  SIMPLIFIED_TAX_CLASS_LABELS,
  type SimplifiedTaxClass,
} from "./settings";
import {
  requireFiscalYear,
  yearEntries,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsSource,
} from "./source";

export type ConsumptionTaxDirection = "sales" | "purchase";
/** 標準税率 10% / 軽減税率 8% */
export type TaxRateKey = "standard" | "reduced";

export const TAX_RATE_KEYS: readonly TaxRateKey[] = ["standard", "reduced"];
export const TAX_RATE_LABELS: Readonly<Record<TaxRateKey, string>> = {
  standard: "標準税率 10%",
  reduced: "軽減税率 8%",
};

export interface ConsumptionTaxCategoryRow {
  code: string;
  name: string;
  direction: ConsumptionTaxDirection;
  /** 件数: lines counted. */
  lineCount: number;
  /** 税込金額 */
  amountInclusive: Money;
  /** 税抜金額 */
  amountExclusive: Money;
  /** 消費税額 (purchases: the creditable tax). */
  taxAmount: Money;
}

export interface ConsumptionTaxSubtotal {
  lineCount: number;
  amountInclusive: Money;
  amountExclusive: Money;
  taxAmount: Money;
}

/** 課税売上割合 as a fraction (計算は分数のまま). */
export interface TaxableSalesRatio {
  numerator: Money;
  denominator: Money;
  /** 「99.99%」, truncated to 2 decimals; 「—」 without sales. */
  label: string;
  /** < 95% */
  belowNinetyFivePercent: boolean;
}

/** One row of 本則 / 簡易: per rate, and the total. */
export interface EstimateRow {
  key: "taxableBase" | "consumptionTax" | "deductibleTax" | "netTax" | "localTax" | "payable";
  label: string;
  /** Per rate (`null` for the rows computed on the total only). */
  byRate: Readonly<Record<TaxRateKey, Money>> | null;
  total: Money;
}

export interface ConsumptionTaxEstimate {
  method: "general" | "simplified";
  label: string;
  /** This year's method (この期の方式). */
  current: boolean;
  rows: EstimateRow[];
  /** 簡易: the 事業区分 used. */
  simplifiedTaxClass?: SimplifiedTaxClass;
  /** What the estimate does not compute (簡易: 2 種類以上の事業). */
  note: string | null;
}

export interface ConsumptionTaxSummary {
  fiscalYear: FinancialStatementsFiscalYear;
  method: ConsumptionTaxMethod;
  /** 「免税」/「本則課税」/「簡易課税」 */
  methodLabel: string;
  accountingMethodLabel: string;
  /** 免税の期: the figures are 参考 (no tax is paid). */
  reference: boolean;
  referenceNote: string | null;
  /** Lines before this date were left out (インボイス登録日 within a taxable year). */
  excludedBefore: CalendarDate | null;
  categories: ConsumptionTaxCategoryRow[];
  sales: ConsumptionTaxSubtotal;
  purchases: ConsumptionTaxSubtotal;
  ratio: TaxableSalesRatio;
  general: ConsumptionTaxEstimate;
  simplified: ConsumptionTaxEstimate;
  /** Tax-exclusive years: 2310 / 1400 of the entries with taxable lines (the settlement left out). */
  taxAccounts: { output: Money; input: Money } | null;
  /** 仮受・仮払 lines in entries without a taxable line of their direction (left out). */
  excludedTaxLines: { output: Money; input: Money };
  /** Warnings (the self-check, missing rules, taxable lines without a 2310 / 1400 line). */
  issues: string[];
  /** 「概算です。…」 */
  disclaimer: string;
}

export const CONSUMPTION_TAX_DISCLAIMER =
  "概算です。申告書は税理士が作ります。返還等対価・貸倒れ・特定課税仕入れは個別に確かめます";
export const EXEMPT_REFERENCE_NOTE =
  "免税事業者の期です。下の数字は課税事業者だった場合の参考値で、納付はありません";
export const SIMPLIFIED_NOTE =
  "2 種類以上の事業があるときの按分・75% 特例は計算していません。税理士に確かめます";

const METHOD_LABELS: Readonly<Record<ConsumptionTaxMethod, string>> = {
  exempt: "免税",
  general: "本則課税",
  simplified: "簡易課税",
};

const ACCOUNTING_LABELS = { tax_inclusive: "税込経理", tax_exclusive: "税抜経理" } as const;

/** 10% / 8% by the category code (the 1% food rate is not handled, 17 §8.4). */
export function taxRateKeyOf(code: string): TaxRateKey | null {
  if (code === "sales_10" || code === "purchase_10" || code === "purchase_10_ni") return "standard";
  if (code === "sales_8r" || code === "purchase_8r" || code === "purchase_8r_ni") return "reduced";
  return null;
}

function isTransitional(code: string): boolean {
  return code === "purchase_10_ni" || code === "purchase_8r_ni";
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Truncation toward zero to a multiple of `unit`. */
function truncateTo(value: Money, unit: bigint): Money {
  return (value / unit) * unit;
}

/**
 * Splits `total` over `weights` in proportion (largest remainder; ties to the earlier weight). The
 * parts add up to `total` exactly. Zero total weight → equal weights.
 */
export function allocateByWeights(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) return [];
  let used = weights;
  let sum = used.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    used = weights.map(() => 1n);
    sum = BigInt(weights.length);
  }
  const sign = sum < 0n ? -1n : 1n;
  const denominator = sum * sign;
  const parts = used.map((weight) => {
    const numerator = total * weight * sign;
    const floor = floorDiv(numerator, denominator);
    return { floor, remainder: numerator - floor * denominator };
  });
  let rest = total - parts.reduce((a, part) => a + part.floor, 0n);
  const order = parts
    .map((part, i) => ({ i, remainder: part.remainder }))
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  const result = parts.map((part) => part.floor);
  for (const { i } of order) {
    if (rest <= 0n) break;
    result[i] = result[i]! + 1n;
    rest -= 1n;
  }
  return result;
}

interface CountedLine {
  code: string;
  direction: ConsumptionTaxDirection;
  /** Signed: sales credit-positive, purchases debit-positive. */
  exclusive: Money;
  inclusive: Money;
  /** Sales: the tax; purchases: the creditable tax. */
  tax: Money;
}

function signed(line: ReportLine, direction: ConsumptionTaxDirection): Money {
  const positive = direction === "sales" ? "credit" : "debit";
  return line.side === positive ? line.amount : -line.amount;
}

function directionOf(code: string): ConsumptionTaxDirection | null {
  const direction = getTaxCategory(code)?.direction;
  return direction === "sales" || direction === "purchase" ? direction : null;
}

function isTaxable(code: string): boolean {
  return getTaxCategory(code)?.kind === "taxable";
}

interface Collected {
  lines: CountedLine[];
  output: Money;
  input: Money;
  excludedOutput: Money;
  excludedInput: Money;
  issues: Set<string>;
}

function deductiblePercent(
  code: string,
  date: CalendarDate,
  rules: readonly TaxRateRule[],
  issues: Set<string>,
): bigint {
  if (!isTransitional(code)) return 100n;
  const percent = resolveTaxRule(code, date, rules)?.deductiblePercent;
  if (percent === null || percent === undefined) {
    const name = getTaxCategory(code)?.name ?? code;
    issues.add(
      `税区分「${name}」の控除割合が ${slashDate(date)} に設定されていません。設定 › 税区分 で足してください`,
    );
    return 0n;
  }
  return BigInt(percent);
}

function collectInclusive(
  entries: readonly ReportEntry[],
  rules: readonly TaxRateRule[],
  from: CalendarDate,
): Collected {
  const collected: Collected = {
    lines: [],
    output: 0n,
    input: 0n,
    excludedOutput: 0n,
    excludedInput: 0n,
    issues: new Set(),
  };
  for (const entry of entries) {
    if (entry.entryDate < from) continue;
    for (const line of entry.lines) {
      const direction = directionOf(line.taxCategoryCode);
      if (!direction) continue;
      const amount = signed(line, direction);
      const contained =
        line.side === (direction === "sales" ? "credit" : "debit")
          ? line.taxAmount
          : -line.taxAmount;
      let tax = contained;
      if (direction === "purchase" && isTransitional(line.taxCategoryCode)) {
        const percent = deductiblePercent(
          line.taxCategoryCode,
          entry.entryDate,
          rules,
          collected.issues,
        );
        const magnitude = ((contained < 0n ? -contained : contained) * percent) / 100n;
        tax = contained < 0n ? -magnitude : magnitude;
      }
      collected.lines.push({
        code: line.taxCategoryCode,
        direction,
        inclusive: amount,
        exclusive: amount - contained,
        tax,
      });
    }
  }
  return collected;
}

function collectExclusive(
  entries: readonly ReportEntry[],
  accountCodes: ReadonlyMap<string, string>,
  rules: readonly TaxRateRule[],
  from: CalendarDate,
): Collected {
  const collected: Collected = {
    lines: [],
    output: 0n,
    input: 0n,
    excludedOutput: 0n,
    excludedInput: 0n,
    issues: new Set(),
  };
  for (const entry of entries) {
    if (entry.entryDate < from) continue;
    const taxTotals: Record<ConsumptionTaxDirection, Money> = { sales: 0n, purchase: 0n };
    const taxable: Record<ConsumptionTaxDirection, { line: ReportLine; weight: bigint }[]> = {
      sales: [],
      purchase: [],
    };
    const others: { line: ReportLine; direction: ConsumptionTaxDirection }[] = [];
    for (const line of entry.lines) {
      const accountCode = accountCodes.get(line.accountId);
      if (accountCode === OUTPUT_TAX_ACCOUNT_CODE) {
        taxTotals.sales += line.side === "credit" ? line.amount : -line.amount;
        continue;
      }
      if (accountCode === INPUT_TAX_ACCOUNT_CODE) {
        taxTotals.purchase += line.side === "debit" ? line.amount : -line.amount;
        continue;
      }
      const direction = directionOf(line.taxCategoryCode);
      if (!direction) continue;
      if (isTaxable(line.taxCategoryCode)) {
        // Weight by the tax the 1400 line carries: 経過措置 lines only their creditable share.
        const percent =
          direction === "purchase"
            ? deductiblePercent(line.taxCategoryCode, entry.entryDate, rules, collected.issues)
            : 100n;
        const positive = line.side === (direction === "sales" ? "credit" : "debit");
        const weight = (positive ? line.taxAmount : -line.taxAmount) * percent;
        taxable[direction].push({ line, weight });
      } else {
        others.push({ line, direction });
      }
    }
    for (const direction of ["sales", "purchase"] as const) {
      const lines = taxable[direction];
      const total = taxTotals[direction];
      if (lines.length === 0) {
        if (direction === "sales") collected.excludedOutput += total;
        else collected.excludedInput += total;
        continue;
      }
      if (direction === "sales") collected.output += total;
      else collected.input += total;
      if (total === 0n && lines.some(({ line }) => line.taxAmount !== 0n)) {
        collected.issues.add(
          direction === "sales"
            ? `仮受消費税の行がない課税売上があります（${slashDate(entry.entryDate)} No.${entry.no}）`
            : `仮払消費税の行がない課税仕入があります（${slashDate(entry.entryDate)} No.${entry.no}）`,
        );
      }
      const shares = allocateByWeights(
        total,
        lines.map(({ weight }) => weight),
      );
      lines.forEach(({ line }, i) => {
        const amount = signed(line, direction);
        const tax = shares[i] ?? 0n;
        collected.lines.push({
          code: line.taxCategoryCode,
          direction,
          exclusive: amount,
          inclusive: amount + tax,
          tax,
        });
      });
    }
    for (const { line, direction } of others) {
      const amount = signed(line, direction);
      collected.lines.push({
        code: line.taxCategoryCode,
        direction,
        exclusive: amount,
        inclusive: amount,
        tax: 0n,
      });
    }
  }
  return collected;
}

function ratioLabel(numerator: Money, denominator: Money): string {
  if (denominator === 0n) return "—";
  // 2 decimals, truncated: numerator × 10000 / denominator in hundredths of a percent.
  const hundredths = (numerator * 10000n) / denominator;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}%`;
}

/** 本則 / 簡易 (17 §8.4). */
function estimates(
  categories: readonly ConsumptionTaxCategoryRow[],
  ratio: TaxableSalesRatio,
  method: ConsumptionTaxMethod,
  taxClass: SimplifiedTaxClass,
): { general: ConsumptionTaxEstimate; simplified: ConsumptionTaxEstimate } {
  const salesInclusive: Record<TaxRateKey, Money> = { standard: 0n, reduced: 0n };
  const purchaseTax: Record<TaxRateKey, Money> = { standard: 0n, reduced: 0n };
  for (const row of categories) {
    const rate = taxRateKeyOf(row.code);
    if (!rate) continue;
    if (row.direction === "sales") salesInclusive[rate] += row.amountInclusive;
    else purchaseTax[rate] += row.taxAmount;
  }
  // 課税標準額: 税込 × 100/110 (100/108), 1,000 円未満切り捨て.
  const taxableBase: Record<TaxRateKey, Money> = {
    standard: truncateTo((salesInclusive.standard * 100n) / 110n, 1000n),
    reduced: truncateTo((salesInclusive.reduced * 100n) / 108n, 1000n),
  };
  // 消費税額 (国税): 7.8% / 6.24%, 1 円未満切り捨て.
  const consumptionTax: Record<TaxRateKey, Money> = {
    standard: (taxableBase.standard * 78n) / 1000n,
    reduced: (taxableBase.reduced * 624n) / 10000n,
  };
  const sumRates = (values: Record<TaxRateKey, Money>) => values.standard + values.reduced;

  // 本則: 積上げ × 78/100 (6.24/8 is also 78/100), × 課税売上割合 below 95% (一括比例配分).
  const generalDeductible: Record<TaxRateKey, Money> = { standard: 0n, reduced: 0n };
  for (const rate of TAX_RATE_KEYS) {
    const national = (purchaseTax[rate] * 78n) / 100n;
    generalDeductible[rate] =
      ratio.belowNinetyFivePercent && ratio.denominator !== 0n
        ? (national * ratio.numerator) / ratio.denominator
        : national;
  }
  // 簡易: 消費税額 × みなし仕入率.
  const deemed = BigInt(DEEMED_PURCHASE_PERCENT[taxClass]);
  const simplifiedDeductible: Record<TaxRateKey, Money> = {
    standard: (consumptionTax.standard * deemed) / 100n,
    reduced: (consumptionTax.reduced * deemed) / 100n,
  };

  const rowsFor = (deductible: Record<TaxRateKey, Money>): EstimateRow[] => {
    const tax = sumRates(consumptionTax);
    const credit = sumRates(deductible);
    const difference = tax - credit;
    // 差引税額: 100 円未満切り捨て; a refund (negative) stays as it is.
    const netTax = difference >= 0n ? truncateTo(difference, 100n) : difference;
    // 地方消費税額: × 22/78, 100 円未満切り捨て (a refund: to the yen).
    const local = (netTax * 22n) / 78n;
    const localTax = netTax >= 0n ? truncateTo(local, 100n) : local;
    return [
      {
        key: "taxableBase",
        label: "課税標準額",
        byRate: taxableBase,
        total: sumRates(taxableBase),
      },
      { key: "consumptionTax", label: "消費税額", byRate: consumptionTax, total: tax },
      { key: "deductibleTax", label: "控除対象仕入税額", byRate: deductible, total: credit },
      { key: "netTax", label: "差引税額", byRate: null, total: netTax },
      { key: "localTax", label: "地方消費税額", byRate: null, total: localTax },
      { key: "payable", label: "納付税額（概算）", byRate: null, total: netTax + localTax },
    ];
  };
  return {
    general: {
      method: "general",
      label: "本則課税（一般課税）の概算",
      current: method === "general",
      rows: rowsFor(generalDeductible),
      note: null,
    },
    simplified: {
      method: "simplified",
      label: "簡易課税の概算",
      current: method === "simplified",
      rows: rowsFor(simplifiedDeductible),
      simplifiedTaxClass: taxClass,
      note: SIMPLIFIED_NOTE,
    },
  };
}

export function buildConsumptionTaxSummary(
  source: FinancialStatementsSource,
  fiscalYearId: string,
): ConsumptionTaxSummary {
  const fiscalYear = requireFiscalYear(source, fiscalYearId);
  const { year } = yearEntries(source, fiscalYear);
  const registeredOn = source.company.invoiceRegisteredOn;
  const excludedBefore =
    fiscalYear.consumptionTax !== "exempt" &&
    registeredOn !== null &&
    registeredOn > fiscalYear.startDate &&
    registeredOn <= fiscalYear.endDate
      ? registeredOn
      : null;
  const from = excludedBefore ?? fiscalYear.startDate;
  const accountCodes = new Map(source.accounts.map((account) => [account.id, account.code]));
  const collected =
    fiscalYear.accountingMethod === "tax_exclusive"
      ? collectExclusive(year, accountCodes, source.taxRules, from)
      : collectInclusive(year, source.taxRules, from);

  const byCode = new Map<string, ConsumptionTaxCategoryRow>();
  for (const line of collected.lines) {
    let row = byCode.get(line.code);
    if (!row) {
      row = {
        code: line.code,
        name:
          source.taxCategories.find((tax) => tax.code === line.code)?.name ??
          getTaxCategory(line.code)?.name ??
          line.code,
        direction: line.direction,
        lineCount: 0,
        amountInclusive: 0n,
        amountExclusive: 0n,
        taxAmount: 0n,
      };
      byCode.set(line.code, row);
    }
    row.lineCount += 1;
    row.amountInclusive += line.inclusive;
    row.amountExclusive += line.exclusive;
    row.taxAmount += line.tax;
  }
  const categories = [...byCode.values()].sort(
    (a, b) =>
      (getTaxCategory(a.code)?.sortOrder ?? 999) - (getTaxCategory(b.code)?.sortOrder ?? 999),
  );
  const subtotal = (direction: ConsumptionTaxDirection): ConsumptionTaxSubtotal => {
    const rows = categories.filter((row) => row.direction === direction);
    return {
      lineCount: rows.reduce((sum, row) => sum + row.lineCount, 0),
      amountInclusive: rows.reduce((sum, row) => sum + row.amountInclusive, 0n),
      amountExclusive: rows.reduce((sum, row) => sum + row.amountExclusive, 0n),
      taxAmount: rows.reduce((sum, row) => sum + row.taxAmount, 0n),
    };
  };
  const sales = subtotal("sales");
  const purchases = subtotal("purchase");

  // 課税売上割合 = (課税売上〔税抜〕＋ 輸出免税売上) ÷ (… ＋ 非課税売上). 不課税は入れない.
  let taxableSales: Money = 0n;
  let exemptSales: Money = 0n;
  for (const row of categories) {
    if (row.direction !== "sales") continue;
    const kind = getTaxCategory(row.code)?.kind;
    if (kind === "taxable" || kind === "export") taxableSales += row.amountExclusive;
    else if (kind === "exempt") exemptSales += row.amountExclusive;
  }
  const denominator = taxableSales + exemptSales;
  const ratio: TaxableSalesRatio = {
    numerator: taxableSales,
    denominator,
    label: ratioLabel(taxableSales, denominator),
    belowNinetyFivePercent: denominator !== 0n && taxableSales * 100n < denominator * 95n,
  };

  const taxClass = fiscalYear.statementSettings?.simplifiedTaxClass ?? DEFAULT_SIMPLIFIED_TAX_CLASS;
  const { general, simplified } = estimates(categories, ratio, fiscalYear.consumptionTax, taxClass);

  const issues = [...collected.issues];
  let taxAccounts: ConsumptionTaxSummary["taxAccounts"] = null;
  if (fiscalYear.accountingMethod === "tax_exclusive") {
    taxAccounts = { output: collected.output, input: collected.input };
    if (sales.taxAmount !== collected.output || purchases.taxAmount !== collected.input) {
      issues.push(
        "税区分ごとの消費税額の合計が仮受消費税・仮払消費税と合いません。仕訳を確かめてください",
      );
    }
  }
  return {
    fiscalYear,
    method: fiscalYear.consumptionTax,
    methodLabel: METHOD_LABELS[fiscalYear.consumptionTax],
    accountingMethodLabel: ACCOUNTING_LABELS[fiscalYear.accountingMethod],
    reference: fiscalYear.consumptionTax === "exempt",
    referenceNote: fiscalYear.consumptionTax === "exempt" ? EXEMPT_REFERENCE_NOTE : null,
    excludedBefore,
    categories,
    sales,
    purchases,
    ratio,
    general,
    simplified,
    taxAccounts,
    excludedTaxLines: { output: collected.excludedOutput, input: collected.excludedInput },
    issues,
    disclaimer: CONSUMPTION_TAX_DISCLAIMER,
  };
}

export const CONSUMPTION_TAX_CSV_HEADER = [
  "表",
  "項目",
  "件数",
  "税込金額",
  "税抜金額",
  "消費税額",
  TAX_RATE_LABELS.standard,
  TAX_RATE_LABELS.reduced,
  "合計",
] as const;

const CATEGORY_TABLE = "税区分別の集計";

/** Tables 1–3 as rows, the table's name in the first column (17 §8.3). */
export function consumptionTaxCsvRows(
  summary: ConsumptionTaxSummary,
): (string | bigint | number)[][] {
  const rows: (string | bigint | number)[][] = [[...CONSUMPTION_TAX_CSV_HEADER]];
  const category = (label: string, row: ConsumptionTaxSubtotal) => [
    CATEGORY_TABLE,
    label,
    row.lineCount,
    row.amountInclusive,
    row.amountExclusive,
    row.taxAmount,
    "",
    "",
    "",
  ];
  for (const row of summary.categories.filter((r) => r.direction === "sales")) {
    rows.push(category(row.name, row));
  }
  rows.push(category("売上 計", summary.sales));
  for (const row of summary.categories.filter((r) => r.direction === "purchase")) {
    rows.push(category(row.name, row));
  }
  rows.push(category("仕入 計", summary.purchases));
  rows.push([CATEGORY_TABLE, "課税売上割合", "", "", "", "", "", "", summary.ratio.label]);
  for (const estimate of [summary.general, summary.simplified]) {
    const table =
      estimate.method === "simplified" && estimate.simplifiedTaxClass
        ? `${estimate.label}（${SIMPLIFIED_TAX_CLASS_LABELS[estimate.simplifiedTaxClass]}）`
        : estimate.label;
    for (const row of estimate.rows) {
      rows.push([
        table,
        row.label,
        "",
        "",
        "",
        "",
        row.byRate ? row.byRate.standard : "",
        row.byRate ? row.byRate.reduced : "",
        row.total,
      ]);
    }
  }
  return rows;
}

/** `consumption-tax_<from>-<to>.csv` (UTF-8 with a BOM). */
export function consumptionTaxCsv(summary: ConsumptionTaxSummary): {
  fileName: string;
  bytes: Uint8Array;
} {
  return {
    fileName: reportFileName(
      "consumption-tax",
      summary.fiscalYear.startDate,
      summary.fiscalYear.endDate,
      "csv",
    ),
    bytes: encodeCsv(csvText(consumptionTaxCsvRows(summary)), "utf8"),
  };
}
