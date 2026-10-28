import type {
  CorporateTaxSummary,
  YearEndAccrualRow,
  YearEndAdjustingEntry,
  YearEndBalanceRow,
  YearEndBalances,
  YearEndConsumptionTax,
  YearEndWalletRow,
} from "@niho-finance/db";
import { ACCOUNTING_METHOD_LABELS, ACCRUAL_TYPE_LABELS, formatYen } from "@niho-finance/ledger";
import Link from "next/link";
import { Table, TableGroup, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatAmount, formatDate } from "@/lib/format";
import { EntryLink, Facts, Note } from "./parts";
import { VoidYearEndEntryButton } from "./void-year-end-entry-button";

/*
 * The details of the checklist steps (16 §3, §7–§10), rendered on the server. Interactive parts are
 * the client components passed in or imported here.
 */

// ---------------------------------------------------------------------------
// 3 残高の照合
// ---------------------------------------------------------------------------

const WALLET_COLUMNS = {
  columns: "minmax(0,1.4fr) 128px 128px 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

export function BalancesDetails({
  wallets,
  endDate,
}: {
  wallets: readonly YearEndWalletRow[];
  endDate: string;
}) {
  if (wallets.length === 0) {
    return <Note>口座がありません。設定 › 口座 で登録すると、期末の残高を比べられます。</Note>;
  }
  const missing = wallets.some((wallet) => wallet.statementBalance === null);
  const differs = wallets.some((wallet) => wallet.difference !== null && wallet.difference !== 0n);
  return (
    <>
      <Table label={`${endDate} の口座の残高`}>
        <TableHead {...WALLET_COLUMNS}>
          <Th>口座</Th>
          <Th align="right">仕訳の残高（円）</Th>
          <Th align="right">明細の残高（円）</Th>
          <Th align="right">差額（円）</Th>
        </TableHead>
        {wallets.map((wallet) => (
          <TableRow key={wallet.walletId} {...WALLET_COLUMNS}>
            <Td className="font-semibold break-words">{wallet.name}</Td>
            <Td align="right" label="仕訳">
              {formatYen(wallet.ledgerBalance)}
            </Td>
            <Td align="right" label="明細">
              {formatAmount(wallet.statementBalance)}
              {wallet.statementDate ? (
                <span className="block text-[11px] text-muted-2">
                  {formatDate(wallet.statementDate)}
                </span>
              ) : null}
            </Td>
            <Td
              align="right"
              label="差額"
              className={wallet.difference !== null && wallet.difference !== 0n ? "font-bold" : ""}
            >
              {formatAmount(wallet.difference)}
            </Td>
          </TableRow>
        ))}
      </Table>
      {missing ? <Note>明細の残高は、明細の取込の後に比べられます。</Note> : null}
      {differs ? (
        <Note>
          差額は伝票（決算整理）で仮払金か雑収入・雑損失に整理します。{" "}
          <Link href="/entries/new?type=voucher" className="font-bold underline underline-offset-4">
            伝票を登録
          </Link>
        </Note>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 5 前払・未払
// ---------------------------------------------------------------------------

const ACCRUAL_COLUMNS = {
  columns: "72px minmax(0,1.6fr) 112px 104px minmax(72px,auto)",
  mobileColumns: "minmax(0,1fr) auto",
};

export function AccrualsDetails({
  rows,
  readOnly,
}: {
  rows: readonly YearEndAccrualRow[];
  readOnly: boolean;
}) {
  if (rows.length === 0) {
    return <Note>登録した決算整理仕訳はありません。該当がなければ「確認した」を押します。</Note>;
  }
  return (
    <Table label="前払・未払の決算整理仕訳">
      <TableHead {...ACCRUAL_COLUMNS}>
        <Th>No.</Th>
        <Th>摘要</Th>
        <Th align="right">金額（円）</Th>
        <Th>振り戻し</Th>
        <Th />
      </TableHead>
      {rows.map((row) => (
        <TableRow key={row.entry.id} {...ACCRUAL_COLUMNS}>
          <Td sm="hide">
            <EntryLink entry={row.entry} />
          </Td>
          <Td>
            <span className="mr-2 md:hidden">
              <EntryLink entry={row.entry} />
            </span>
            <span className="break-words">{row.description}</span>
            {row.type && row.description !== ACCRUAL_TYPE_LABELS[row.type] ? (
              <span className="ml-2 text-[12px] text-muted">{ACCRUAL_TYPE_LABELS[row.type]}</span>
            ) : null}
          </Td>
          <Td align="right" className="font-bold">
            {formatYen(row.amount)}
          </Td>
          <Td label="振り戻し" className="text-[13px]">
            {row.reversal ? <EntryLink entry={row.reversal} /> : "—"}
          </Td>
          <Td className="text-right">
            {readOnly ? null : (
              <VoidYearEndEntryButton
                entryId={row.entry.id}
                no={row.entry.no}
                accrualReversalNo={row.reversal?.no ?? null}
              />
            )}
          </Td>
        </TableRow>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------------------
// 6 消費税
// ---------------------------------------------------------------------------

export function ConsumptionTaxDetails({
  tax,
  readOnly,
}: {
  tax: YearEndConsumptionTax;
  readOnly: boolean;
}) {
  if (!tax.applicable) return <Note>免税の期のため不要です。</Note>;
  const exclusive = tax.accountingMethod === "tax_exclusive";
  return (
    <>
      <Facts
        label="消費税の期末残高"
        items={[
          { label: "経理方式", value: ACCOUNTING_METHOD_LABELS[tax.accountingMethod] },
          ...(exclusive
            ? [
                { label: "仮受消費税（円）", value: formatYen(tax.outputTaxBalance) },
                { label: "仮払消費税（円）", value: formatYen(tax.inputTaxBalance) },
                {
                  label: "差引（100 円未満切り捨て・円）",
                  value: formatYen(tax.suggestedPayable),
                  strong: true,
                },
              ]
            : []),
        ]}
      />
      {tax.posted ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          精算を計上済み <EntryLink entry={tax.posted} />
          {readOnly ? null : <VoidYearEndEntryButton entryId={tax.posted.id} no={tax.posted.no} />}
        </p>
      ) : null}
      <Note>税区分ごとの集計（申告書の数字）は決算書・書き出しで扱います。</Note>
    </>
  );
}

// ---------------------------------------------------------------------------
// 7 法人税等
// ---------------------------------------------------------------------------

const TAX_COLUMNS = {
  columns: "minmax(0,1.6fr) 128px 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

export function CorporateTaxDetails({
  summary,
  readOnly,
}: {
  summary: CorporateTaxSummary;
  readOnly: boolean;
}) {
  const { estimate } = summary;
  return (
    <>
      <Table label="法人税等の概算の内訳">
        <TableHead {...TAX_COLUMNS}>
          <Th>内訳</Th>
          <Th align="right" sm="hide">
            課税標準（円）
          </Th>
          <Th align="right">税額（円）</Th>
        </TableHead>
        {estimate.lines.map((line) => (
          <TableRow key={line.key} {...TAX_COLUMNS}>
            <Td className="break-words">
              {line.label}
              <span className="num block text-[11px] text-muted-2 md:hidden">
                課税標準 {formatYen(line.base)}
              </span>
            </Td>
            <Td align="right" sm="hide" className="text-muted">
              {formatYen(line.base)}
            </Td>
            <Td align="right">{formatYen(line.amount)}</Td>
          </TableRow>
        ))}
        <TableRow {...TAX_COLUMNS} className="bg-surface-2 font-bold">
          <Td>年税額の概算</Td>
          <Td sm="hide" />
          <Td align="right">{formatYen(estimate.total)}</Td>
        </TableRow>
      </Table>
      <Facts
        label="法人税等の計算のもと"
        items={[
          { label: "所得の概算（円）", value: formatYen(summary.pretaxIncome) },
          { label: "繰越欠損金（円）", value: formatYen(summary.lossCarryforward) },
          { label: "課税所得（円）", value: formatYen(estimate.taxableIncome) },
          { label: "計上済み（円）", value: formatYen(summary.booked) },
          { label: "納付期限", value: formatDate(summary.dueDate), strong: true },
        ]}
      />
      {summary.posted ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          計上済み <EntryLink entry={summary.posted} />
          {readOnly ? null : (
            <VoidYearEndEntryButton entryId={summary.posted.id} no={summary.posted.no} />
          )}
        </p>
      ) : null}
      <Note>
        所得の概算は 収益 −
        費用（法人税等を除く）です。交際費などの申告調整を含まない目安のため、税理士の計算や申告書の額があればその額で計上します。
      </Note>
    </>
  );
}

// ---------------------------------------------------------------------------
// 8 締め: 期末と翌期首の残高 (§10)
// ---------------------------------------------------------------------------

const BALANCE_COLUMNS = {
  columns: "minmax(0,1.4fr) 140px 120px 128px",
  mobileColumns: "minmax(0,1fr) auto",
};

const KIND_GROUPS = [
  { kind: "asset", label: "資産" },
  { kind: "liability", label: "負債" },
  { kind: "equity", label: "純資産" },
] as const;

function BalanceRow({ row }: { row: YearEndBalanceRow }) {
  return (
    <TableRow {...BALANCE_COLUMNS}>
      <Td className="break-words">
        <span className="num mr-1.5 text-[12px] text-muted">{row.code}</span>
        {row.name}
      </Td>
      <Td align="right" sm="hide">
        {formatYen(row.beforeClosing)}
      </Td>
      <Td align="right" sm="hide" className={row.closing === 0n ? "text-muted-2" : ""}>
        {row.closing === 0n ? "—" : formatYen(row.closing)}
      </Td>
      <Td align="right" className="font-bold">
        {formatYen(row.opening)}
      </Td>
      <span role="cell" className="num col-span-full text-[12px] text-muted md:hidden">
        期末 {formatYen(row.beforeClosing)}
        {row.closing !== 0n ? ` · 決算振替 ${formatYen(row.closing)}` : ""}
      </span>
    </TableRow>
  );
}

export function ClosingBalances({ balances }: { balances: YearEndBalances }) {
  const { opening } = balances.totals;
  return (
    <>
      {balances.closingEntry ? (
        <p className="text-[13px]">
          決算振替 <EntryLink entry={balances.closingEntry} />{" "}
          で当期純利益を繰越利益剰余金に振り替えました。
        </p>
      ) : (
        <Note>損益の行がないため、決算振替はありません。</Note>
      )}
      <Table label="期末と翌期首の残高">
        <TableHead {...BALANCE_COLUMNS}>
          <Th>科目</Th>
          <Th align="right">期末残高（決算振替の前・円）</Th>
          <Th align="right">決算振替（円）</Th>
          <Th align="right">翌期首（円）</Th>
        </TableHead>
        {KIND_GROUPS.map((group) => {
          const rows = balances.rows.filter((row) => row.kind === group.kind);
          if (rows.length === 0) return null;
          return [
            <TableGroup key={`${group.kind}-group`}>{group.label}</TableGroup>,
            ...rows.map((row) => <BalanceRow key={row.accountId} row={row} />),
          ];
        })}
      </Table>
      <p
        className={`num text-[13px] break-words ${balances.balanced ? "text-text" : "font-bold text-warn"}`}
      >
        検算（翌期首）: 資産 {formatYen(opening.assets)} 円 = 負債 {formatYen(opening.liabilities)}{" "}
        円 + 純資産 {formatYen(opening.equity)} 円
        {balances.priorPeriodsProfit !== 0n
          ? ` + 前期以前の損益 ${formatYen(balances.priorPeriodsProfit)} 円`
          : ""}
        {balances.balanced ? "（一致）" : "（一致しません。仕訳を確かめてください）"}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// 決算整理仕訳の一覧
// ---------------------------------------------------------------------------

const ADJUSTING_COLUMNS = {
  columns: "72px minmax(0,1fr) minmax(0,1.4fr) 112px minmax(72px,auto)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * The year's adjusting entries in force (generated and 伝票): during the adjustments they are voided
 * here, not on the entry detail (16 §1.2).
 */
export function AdjustingEntries({
  entries,
  readOnly,
}: {
  entries: readonly YearEndAdjustingEntry[];
  readOnly: boolean;
}) {
  return (
    <section aria-labelledby="adjusting-entries" className="mt-8">
      <h2 id="adjusting-entries" className="mb-1 text-[15px] font-extrabold">
        決算整理仕訳
      </h2>
      <p className="mb-2 text-[12px] text-muted">
        決算整理中は、伝票で登録した決算整理仕訳もここで取り消します。
      </p>
      {entries.length === 0 ? (
        <Note>まだありません。</Note>
      ) : (
        <Table label="決算整理仕訳">
          <TableHead {...ADJUSTING_COLUMNS}>
            <Th>No.</Th>
            <Th>内容</Th>
            <Th>摘要</Th>
            <Th align="right">金額（円）</Th>
            <Th />
          </TableHead>
          {entries.map((entry) => (
            <TableRow key={entry.id} {...ADJUSTING_COLUMNS}>
              <Td sm="hide">
                <EntryLink entry={entry} />
              </Td>
              <Td className="break-words">
                <span className="mr-2 md:hidden">
                  <EntryLink entry={entry} />
                </span>
                {entry.purposeLabel}
              </Td>
              <Td sm="hide" className="text-[13px] break-words text-muted">
                {entry.description}
              </Td>
              <Td align="right" className="font-bold">
                {formatYen(entry.amount)}
              </Td>
              {readOnly ? (
                <Td sm="hide" />
              ) : (
                <Td sm="full" className="text-right">
                  <VoidYearEndEntryButton entryId={entry.id} no={entry.no} />
                </Td>
              )}
            </TableRow>
          ))}
        </Table>
      )}
    </section>
  );
}
