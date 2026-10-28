import {
  balanceSheetSides,
  formatStatementAmount,
  type EquityStatement,
  type EtaxEdition,
  type FinancialBalanceSheet,
  type FinancialIncomeStatement,
  type StatementLine,
  type StatementNotes,
} from "@niho-finance/reports";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/button";
import { TableHead, TableRow, Td, Th, type TableColumns } from "@/components/ui/table";

/**
 * The 計算書類 on the screen (17 §3 item 2): the same lines as the PDF — only the visible ones,
 * indented by `indent`, negatives with 「△」. Phones read every table as 科目・金額.
 */

const SIDE_COLUMNS: TableColumns = {
  columns: "minmax(0,1fr) minmax(6.5rem,auto)",
  mobileColumns: "minmax(0,1fr) auto",
};

const PL_COLUMNS: TableColumns = {
  columns: "minmax(0,1fr) minmax(6.5rem,8.5rem) minmax(6.5rem,8.5rem)",
  mobileColumns: "minmax(0,1fr) auto",
};

function amountText(amount: bigint | null): string {
  return amount === null ? "" : formatStatementAmount(amount);
}

function indentStyle(indent: number) {
  return indent > 0 ? { paddingLeft: `${indent}rem` } : undefined;
}

/** A download as a plain link (no prefetch: every download is written to the audit log). */
export function DownloadLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <a
      href={href}
      className={buttonClass({ variant: primary ? "primary" : "secondary", size: "sm" })}
    >
      {children}
    </a>
  );
}

/** A table that stretches to its column's height, so the bottom rows of the 勘定式 line up. */
function SideTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="table"
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-card border border-border bg-surface"
    >
      {children}
    </div>
  );
}

function LineRow({ line, columns }: { line: StatementLine; columns: TableColumns }) {
  if (line.kind === "title") {
    return (
      <TableRow {...columns} className="text-[13px] font-bold text-muted">
        <Td className="col-span-full">
          <span className="block" style={indentStyle(line.indent)}>
            {line.label}
          </span>
        </Td>
      </TableRow>
    );
  }
  return (
    <TableRow {...columns} className={line.kind === "total" ? "font-bold" : ""}>
      <Td>
        <span className="block" style={indentStyle(line.indent)}>
          {line.label}
        </span>
      </Td>
      <Td align="right">{amountText(line.amount)}</Td>
    </TableRow>
  );
}

function SideTotal({ line, label }: { line: StatementLine | null; label: string }) {
  return (
    <TableRow {...SIDE_COLUMNS} className="mt-auto border-t border-t-border-2 font-bold">
      <Td>{line?.label ?? label}</Td>
      <Td align="right">{amountText(line?.amount ?? 0n)}</Td>
    </TableRow>
  );
}

/** 貸借対照表 in 勘定式: 資産の部 | 負債の部・純資産の部 on PC, one under the other on phones. */
export function BalanceSheetView({
  sheet,
  edition,
  label,
}: {
  sheet: FinancialBalanceSheet;
  edition: EtaxEdition;
  label: string;
}) {
  const sides = balanceSheetSides(sheet, edition);
  return (
    <div className="grid items-stretch gap-3 md:grid-cols-2">
      <SideTable label={`${label}（資産の部）`}>
        <TableHead {...SIDE_COLUMNS}>
          <Th>科目</Th>
          <Th align="right">金額（円）</Th>
        </TableHead>
        {sides.assets.map((line) => (
          <LineRow key={line.code} line={line} columns={SIDE_COLUMNS} />
        ))}
        <SideTotal line={sides.assetsTotal} label="資産合計" />
      </SideTable>
      <SideTable label={`${label}（負債の部・純資産の部）`}>
        <TableHead {...SIDE_COLUMNS}>
          <Th>科目</Th>
          <Th align="right">金額（円）</Th>
        </TableHead>
        {sides.liabilitiesAndNetAssets.map((line) => (
          <LineRow key={line.code} line={line} columns={SIDE_COLUMNS} />
        ))}
        <SideTotal line={sides.liabilitiesAndNetAssetsTotal} label="負債純資産合計" />
      </SideTable>
    </div>
  );
}

/**
 * 損益計算書 in 報告式: accounts in the inner column, section totals and profits in the outer one
 * (17 §4.2); 当期純利益 says whether it equals the trial balance.
 */
export function IncomeStatementView({
  statement,
  matchesTrialBalance,
  trialBalanceNetIncome,
}: {
  statement: FinancialIncomeStatement;
  matchesTrialBalance: boolean;
  trialBalanceNetIncome: bigint;
}) {
  const visible = statement.lines.filter((line) => line.visible);
  const last = visible[visible.length - 1];
  return (
    <div
      role="table"
      aria-label="損益計算書"
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      <TableHead {...PL_COLUMNS}>
        <Th>科目</Th>
        <Th align="right">金額（円）</Th>
        <Th align="right">金額（円）</Th>
      </TableHead>
      {visible.map((line) => {
        if (line.kind === "title") {
          return <LineRow key={line.code} line={line} columns={PL_COLUMNS} />;
        }
        const isNetIncome = line === last && line.amount === statement.netIncome;
        const total = line.kind === "total";
        return (
          <TableRow
            key={line.code}
            {...PL_COLUMNS}
            className={total ? `font-bold ${isNetIncome ? "border-t border-t-border-2" : ""}` : ""}
          >
            <Td>
              <span className="block" style={indentStyle(line.indent)}>
                {line.label}
                {isNetIncome ? (
                  <span
                    className={`ml-2 text-[11px] font-semibold ${
                      matchesTrialBalance ? "text-muted-2" : "text-warn"
                    }`}
                  >
                    {matchesTrialBalance
                      ? "試算表と一致"
                      : `試算表は ${formatStatementAmount(trialBalanceNetIncome)}`}
                  </span>
                ) : null}
              </span>
            </Td>
            <Td align="right" sm={total ? "hide" : undefined}>
              {total ? "" : amountText(line.amount)}
            </Td>
            <Td align="right" sm={total ? undefined : "hide"}>
              {total ? amountText(line.amount) : ""}
            </Td>
          </TableRow>
        );
      })}
    </div>
  );
}

/** 株主資本等変動計算書 in the vertical form (17 §4.3). */
export function EquityStatementView({ statement }: { statement: EquityStatement }) {
  const minDepth = Math.min(...statement.lines.map((line) => line.depth));
  return (
    <div
      role="table"
      aria-label="株主資本等変動計算書"
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      <TableHead {...SIDE_COLUMNS}>
        <Th>科目</Th>
        <Th align="right">金額（円）</Th>
      </TableHead>
      {statement.lines.map((line) => {
        const indent = Math.max(0, line.depth - minDepth);
        if (line.kind === "title") {
          return (
            <TableRow
              key={line.code}
              {...SIDE_COLUMNS}
              className="text-[13px] font-bold text-muted"
            >
              <Td className="col-span-full">
                <span className="block" style={indentStyle(indent)}>
                  {line.label}
                </span>
              </Td>
            </TableRow>
          );
        }
        return (
          <TableRow key={line.code} {...SIDE_COLUMNS}>
            <Td>
              <span className="block" style={indentStyle(indent)}>
                {line.label}
              </span>
            </Td>
            <Td align="right">{amountText(line.amount)}</Td>
          </TableRow>
        );
      })}
    </div>
  );
}

/** 個別注記表 (17 §4.4): each section with its sentence and items; empty items are left out. */
export function NotesView({ notes }: { notes: StatementNotes }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border bg-surface px-4 py-4 text-[14px]">
      {notes.sections.map((section, index) => (
        <section key={section.code}>
          <h4 className="font-bold">
            {index + 1}. {section.title}
          </h4>
          {section.body ? (
            <p className="mt-1 whitespace-pre-line text-text">{section.body}</p>
          ) : null}
          {section.items.length > 0 ? (
            <ol className="mt-2 flex flex-col gap-2 pl-4">
              {section.items.map((item, itemIndex) => (
                <li key={`${item.code}-${itemIndex}`}>
                  <p className="font-semibold">
                    （{itemIndex + 1}）{item.title}
                  </p>
                  <p className="mt-0.5 whitespace-pre-line text-muted">{item.body}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** A plain 2-column amount table (附属明細書 on the screen). */
export function AmountRows({
  label,
  rows,
  total,
}: {
  label: string;
  rows: readonly { key: string; label: string; amount: bigint }[];
  total?: { label: string; amount: bigint };
}) {
  return (
    <div
      role="table"
      aria-label={label}
      className="overflow-hidden rounded-card border border-border bg-surface"
    >
      <TableHead {...SIDE_COLUMNS}>
        <Th>科目</Th>
        <Th align="right">金額（円）</Th>
      </TableHead>
      {rows.map((row) => (
        <TableRow key={row.key} {...SIDE_COLUMNS}>
          <Td>{row.label}</Td>
          <Td align="right">{formatStatementAmount(row.amount)}</Td>
        </TableRow>
      ))}
      {total ? (
        <TableRow {...SIDE_COLUMNS} className="border-t border-t-border-2 font-bold">
          <Td>{total.label}</Td>
          <Td align="right">{formatStatementAmount(total.amount)}</Td>
        </TableRow>
      ) : null}
    </div>
  );
}
