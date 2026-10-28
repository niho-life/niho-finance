/**
 * beancount (14-reports §11.3): the book as text that `bean-check` and Fava read. Accounts map to
 * the five roots by kind, `<code>-<name>` with sub-accounts below. Balance assertions on the day
 * after `to` make `bean-check` recompute the balance sheet from the transactions.
 */
import { addDays, type AccountKind, type CalendarDate, type Money } from "@niho-finance/ledger";
import { halfWidthLength } from "../format";
import { indexSource, type ReportAccount, type ReportSource } from "../source";

export interface BeancountOptions {
  /** First date of the export. Earlier entries are summarised into an opening transaction. */
  from: CalendarDate;
  /** Last date of the export and the date of the balance assertions (+1 day). */
  to: CalendarDate;
}

export const BEANCOUNT_ROOTS: Readonly<Record<AccountKind, string>> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Income",
  expense: "Expenses",
  internal: "Equity:Internal",
};

export const BEANCOUNT_OPENING_ACCOUNT = "Equity:Opening-Balances";
export const BEANCOUNT_CURRENCY = "JPY";

/**
 * One component of an account name: letters, digits and dashes. beancount accepts Unicode letters
 * anywhere but not an ASCII lower-case letter at the start, so that one is capitalised.
 */
export function beancountComponent(text: string): string {
  const cleaned = [...text.normalize("NFKC")]
    .map((char) => (/[\p{L}\p{N}]/u.test(char) ? char : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (cleaned === "") return "X";
  // An ASCII lower-case start is rejected by beancount; other letters and digits are accepted.
  return cleaned.replace(/^[a-z]/, (char) => char.toUpperCase());
}

export function beancountAccountName(account: ReportAccount, subAccountName?: string | null) {
  const base = `${BEANCOUNT_ROOTS[account.kind]}:${account.code}-${beancountComponent(account.name)}`;
  return subAccountName ? `${base}:${beancountComponent(subAccountName)}` : base;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function amount(value: Money): string {
  return `${value.toString()} ${BEANCOUNT_CURRENCY}`;
}

/** Pads to `width` display columns (CJK counts 2) so that the amounts line up. */
function padAccount(account: string, width = 48): string {
  return account + " ".repeat(Math.max(1, width - halfWidthLength(account)));
}

function posting(account: string, value: Money, meta: [string, string][]): string[] {
  const line = `  ${padAccount(account)} ${amount(value).padStart(14)}`;
  return [line, ...meta.map(([key, text]) => `    ${key}: ${text}`)];
}

function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a < b ? a : b;
}

export function buildBeancount(source: ReportSource, options: BeancountOptions): string {
  const index = indexSource(source);
  const used = new Map<string, { account: ReportAccount; subName: string | null }>();
  const useAccount = (account: ReportAccount, subName: string | null): string => {
    const parent = beancountAccountName(account);
    if (!used.has(parent)) used.set(parent, { account, subName: null });
    if (!subName) return parent;
    const name = beancountAccountName(account, subName);
    if (!used.has(name)) used.set(name, { account, subName });
    return name;
  };
  const accountOf = (accountId: string, subAccountId: string | null): string => {
    const account = index.accountsById.get(accountId);
    if (!account) throw new Error(`reports: account ${accountId} is not in the source`);
    const sub = subAccountId ? index.subAccountsById.get(subAccountId) : undefined;
    return useAccount(account, sub?.name ?? null);
  };

  const lines: string[] = [];
  const transactions: string[] = [];
  let firstDate = options.from;

  // Opening transaction: the balance sheet before `from` (earlier entries are not exported).
  const before = index.entries.filter((entry) => entry.entryDate < options.from);
  if (before.length > 0) {
    const balances = new Map<string, Money>();
    for (const entry of before) {
      for (const line of entry.lines) {
        const account = index.accountsById.get(line.accountId);
        if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
        const key =
          account.kind === "revenue" || account.kind === "expense" || account.kind === "internal"
            ? BEANCOUNT_OPENING_ACCOUNT
            : accountOf(line.accountId, line.subAccountId);
        const net = line.side === "debit" ? line.amount : -line.amount;
        balances.set(key, (balances.get(key) ?? 0n) + net);
      }
    }
    const postings = [...balances.entries()].filter(([, value]) => value !== 0n);
    if (postings.length > 0) {
      used.set(BEANCOUNT_OPENING_ACCOUNT, {
        account: {
          id: "",
          code: "",
          name: "",
          kind: "equity",
          group: "shareholders_equity",
          isCashLike: false,
          isActive: true,
          sortOrder: 0,
        },
        subName: null,
      });
      transactions.push(`${options.from} * ${quote("期首残高")}`);
      transactions.push(`  kind: "opening-balances"`);
      for (const [account, value] of postings) transactions.push(...posting(account, value, []));
      transactions.push("");
    }
  }

  for (const entry of index.entries) {
    if (entry.entryDate < options.from || entry.entryDate > options.to) continue;
    firstDate = minDate(firstDate, entry.entryDate);
    const firstPartner = entry.lines
      .map((line) => (line.partnerId ? index.partnersById.get(line.partnerId) : undefined))
      .find((partner) => partner !== undefined);
    const links = [`^e${entry.no}`];
    const reversed = entry.reversalOfId ? index.entriesById.get(entry.reversalOfId) : undefined;
    if (reversed) links.push(`^e${reversed.no}`);
    const header = [
      entry.entryDate,
      "*",
      ...(firstPartner ? [quote(firstPartner.name)] : []),
      quote(entry.description),
      ...links,
    ].join(" ");
    transactions.push(header);
    transactions.push(`  no: ${entry.no}`);
    transactions.push(`  kind: ${quote(entry.kind)}`);
    transactions.push(`  source: ${quote(entry.sourceKind)}`);
    if (entry.status === "voided") {
      transactions.push(`  status: "voided"`);
      if (entry.voidReason) transactions.push(`  void_reason: ${quote(entry.voidReason)}`);
    }
    if (reversed) transactions.push(`  reversal_of: ${reversed.no}`);
    for (const line of entry.lines) {
      const name = accountOf(line.accountId, line.subAccountId);
      const value = line.side === "debit" ? line.amount : -line.amount;
      const meta: [string, string][] = [];
      const segment = line.segmentId ? index.segmentsById.get(line.segmentId) : undefined;
      if (segment) meta.push(["segment", quote(segment.code)]);
      meta.push(["tax", quote(line.taxCategoryCode)]);
      if (line.taxAmount !== 0n) meta.push(["tax_amount", line.taxAmount.toString()]);
      if (line.description) meta.push(["line", quote(line.description)]);
      transactions.push(...posting(name, value, meta));
    }
    transactions.push("");
  }

  // Balance assertions: the balance sheet through `to` (parents include their sub-accounts).
  const assertions: string[] = [];
  const balances = new Map<string, { account: ReportAccount; net: Money }>();
  for (const entry of index.entries) {
    if (entry.entryDate > options.to) continue;
    for (const line of entry.lines) {
      const account = index.accountsById.get(line.accountId);
      if (!account) throw new Error(`reports: account ${line.accountId} is not in the source`);
      if (account.kind === "revenue" || account.kind === "expense") continue;
      const row = balances.get(account.id) ?? { account, net: 0n };
      row.net += line.side === "debit" ? line.amount : -line.amount;
      balances.set(account.id, row);
    }
  }
  const assertionDate = addDays(options.to, 1);
  for (const { account, net } of [...balances.values()].sort((a, b) =>
    a.account.code < b.account.code ? -1 : 1,
  )) {
    assertions.push(
      `${assertionDate} balance ${padAccount(useAccount(account, null))} ${amount(net).padStart(14)}`,
    );
  }

  const openDate = minDate(source.company.foundedOn, firstDate);
  lines.push(`option "title" ${quote(source.company.name)}`);
  lines.push(`option "operating_currency" "${BEANCOUNT_CURRENCY}"`);
  lines.push("");
  for (const name of [...used.keys()].sort()) {
    lines.push(`${openDate} open ${name} ${BEANCOUNT_CURRENCY}`);
  }
  lines.push("");
  lines.push(...transactions);
  if (assertions.length > 0) {
    lines.push(`; 貸借対照表 ${options.to} 時点の残高（bean-check が取引から再計算する）`);
    lines.push(...assertions);
    lines.push("");
  }
  return lines.join("\n");
}
