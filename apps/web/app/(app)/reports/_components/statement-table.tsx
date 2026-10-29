import Link from "next/link";
import type { ReactNode } from "react";
import { gridStyle, Table, TableGroup, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatAmountDisplay } from "@/lib/format";
import type { TrialBalanceLine } from "../_lib/trial-balance-view";
import { DisclosureRows } from "./disclosure-rows";

/** 科目 ・ 期首 ・ 借方 ・ 貸方 ・ 残高 on PC; 科目 ・ 残高 on phones (14-reports §3). */
const COLUMNS = {
  columns: "minmax(10rem,1fr) repeat(4, minmax(5.75rem, 7.5rem))",
  mobileColumns: "minmax(0,1fr) auto",
};

/** Accounts line up whether or not they have the chevron of their sub-accounts. */
const ACCOUNT_LABEL = "pl-[2.375rem]";
const ACCOUNT_WITH_CHEVRON = "pl-4";
const SUB_ACCOUNT_LABEL = "pl-14";

function Amount({
  value,
  sm,
  className,
}: {
  value: bigint | null;
  sm?: "hide";
  className?: string;
}) {
  return (
    <Td align="right" sm={sm} className={className}>
      {value === null ? "" : formatAmountDisplay(value)}
    </Td>
  );
}

/**
 * 期首 · 期間 (over the 借方・貸方 columns) · 残高: subtotals and totals (§3). The word 「期間」 sits at
 * the left of the two columns and the amount at the right, so that it never reads as part of the
 * number (05-ui-ux §3.1).
 */
function NetCells({ line }: { line: TrialBalanceLine }) {
  return (
    <>
      <Amount value={line.opening} sm="hide" />
      <span
        role="cell"
        aria-colspan={2}
        data-sm="hide"
        className="num min-w-0 text-right"
        style={{ gridColumn: "span 2" }}
      >
        {line.period === null ? null : (
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold text-muted">期間</span>
            <span>{formatAmountDisplay(line.period)}</span>
          </span>
        )}
      </span>
      <Amount value={line.balance} />
    </>
  );
}

function FullCells({ line }: { line: TrialBalanceLine }) {
  return (
    <>
      <Amount value={line.opening} sm="hide" />
      <Amount value={line.debit} sm="hide" />
      <Amount value={line.credit} sm="hide" />
      <Amount value={line.balance} />
    </>
  );
}

/**
 * 貸借対照表 or 損益計算書 of 試算表. Section rows are headings, group rows show their totals
 * muted, accounts link to 総勘定元帳 and open their sub-accounts, subtotals and totals are bold
 * with 「期間」 in place of 借方・貸方.
 */
export function StatementTable({
  label,
  lines,
  ledgerHref,
}: {
  label: string;
  lines: readonly TrialBalanceLine[];
  /** The general ledger of an account (and sub-account) with the conditions kept. */
  ledgerHref: (accountId: string, subAccountId?: string | null) => string;
}) {
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    switch (line.kind) {
      case "section":
        nodes.push(<TableGroup key={line.key}>{line.label}</TableGroup>);
        break;
      case "group":
        nodes.push(
          <TableRow key={line.key} {...COLUMNS}>
            <Td className="font-bold">{line.label}</Td>
            <Amount value={line.opening} sm="hide" className="text-muted" />
            <Amount value={line.debit} sm="hide" className="text-muted" />
            <Amount value={line.credit} sm="hide" className="text-muted" />
            <Amount value={line.balance} className="text-muted" />
          </TableRow>,
        );
        break;
      case "account": {
        const subs: TrialBalanceLine[] = [];
        while (lines[i + 1]?.kind === "subAccount") {
          const sub = lines[i + 1];
          if (sub) subs.push(sub);
          i += 1;
        }
        const accountLink = line.accountId ? (
          <Link
            href={ledgerHref(line.accountId)}
            className="underline-offset-4 hover:underline"
            prefetch={false}
          >
            {line.label}
          </Link>
        ) : (
          line.label
        );
        if (subs.length === 0) {
          nodes.push(
            <TableRow key={line.key} {...COLUMNS}>
              <Td className={ACCOUNT_LABEL}>{accountLink}</Td>
              <FullCells line={line} />
            </TableRow>,
          );
          break;
        }
        nodes.push(
          <DisclosureRows
            key={line.key}
            style={gridStyle(COLUMNS)}
            labelClassName={ACCOUNT_WITH_CHEVRON}
            label={accountLink}
            toggleLabel={`${line.label}の補助科目の内訳`}
            cells={<FullCells line={line} />}
            defaultOpen={false}
          >
            {subs.map((sub) => (
              <TableRow key={sub.key} {...COLUMNS} muted>
                <Td className={SUB_ACCOUNT_LABEL}>
                  {sub.accountId && sub.subAccountId ? (
                    <Link
                      href={ledgerHref(sub.accountId, sub.subAccountId)}
                      className="underline-offset-4 hover:underline"
                      prefetch={false}
                    >
                      {sub.label}
                    </Link>
                  ) : (
                    sub.label
                  )}
                </Td>
                <FullCells line={sub} />
              </TableRow>
            ))}
          </DisclosureRows>,
        );
        break;
      }
      case "subAccount":
        // Rendered with their account above.
        break;
      case "subtotal":
      case "total":
        nodes.push(
          <TableRow
            key={line.key}
            {...COLUMNS}
            className={`font-bold ${line.kind === "total" ? "border-t border-t-border-2" : ""}`}
          >
            <Td>{line.label}</Td>
            <NetCells line={line} />
          </TableRow>,
        );
        break;
    }
  }

  return (
    <Table label={label} minWidth={640}>
      <TableHead {...COLUMNS}>
        <Th>科目</Th>
        <Th align="right" sm="hide">
          期首（円）
        </Th>
        <Th align="right" sm="hide">
          借方（円）
        </Th>
        <Th align="right" sm="hide">
          貸方（円）
        </Th>
        <Th align="right">残高（円）</Th>
      </TableHead>
      {nodes}
    </Table>
  );
}
