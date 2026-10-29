import { listDueRecurringOccurrences, todayInJapan } from "@niho-finance/db";
import { formatYenInput } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatAmountDisplay, formatDate } from "@/lib/format";
import { DUE_COLUMNS } from "./due-columns";
import { DueRows, type DueRow } from "./due-rows";

export const metadata: Metadata = { title: "定期取引の登録" };

/**
 * 定期取引の登録 (21-cashflow §10.4): the occurrences due for registration. 「登録する」 posts each
 * one with a click; 「明細で登録する」 lists those of wallets that import their statements, which
 * are registered from the statement (so that the entry is not made twice).
 */
export default async function RecurringDuePage() {
  const prisma = await db();
  const due = await listDueRecurringOccurrences(prisma, todayInJapan());
  const toPost: DueRow[] = due
    .filter((row) => row.mode === "post")
    .map((row) => ({
      key: row.key,
      recurringItemId: row.recurringItemId,
      name: row.name,
      date: row.date,
      month: row.month,
      walletName: row.walletName,
      counterpartName: row.counterpartName,
      amount: formatYenInput(row.amount),
    }));
  const fromStatements = due.filter((row) => row.mode === "statement");

  return (
    <>
      <PageHeader
        title="定期取引の登録"
        back={{ href: "/settings/recurring", label: "定期取引" }}
      />
      {due.length === 0 ? (
        <p className="text-[14px] text-muted">登録する定期取引はありません</p>
      ) : (
        <div className="flex flex-col gap-6">
          {toPost.length > 0 ? (
            <section aria-labelledby="recurring-due-post">
              <h2 id="recurring-due-post" className="mb-2 text-[15px] font-extrabold">
                登録する
              </h2>
              <DueRows rows={toPost} />
            </section>
          ) : null}
          {fromStatements.length > 0 ? (
            <section aria-labelledby="recurring-due-statement">
              <h2 id="recurring-due-statement" className="mb-1 text-[15px] font-extrabold">
                明細で登録する
              </h2>
              <p className="mb-2 text-[13px] text-muted">
                この口座は明細を取り込むので、明細から登録します（二重に登録しないため）
              </p>
              <Table label="明細で登録する定期取引">
                <TableHead {...DUE_COLUMNS}>
                  <Th>日付</Th>
                  <Th>名前</Th>
                  <Th>口座</Th>
                  <Th align="right">金額（円）</Th>
                  <Th />
                </TableHead>
                {fromStatements.map((row) => (
                  <TableRow key={row.key} {...DUE_COLUMNS}>
                    <Td className="num text-[13px] text-muted">{formatDate(row.date)}</Td>
                    <Td>
                      <span className="block break-words">{row.name}</span>
                      <span className="block text-[12px] text-muted md:hidden">
                        {row.walletName}
                      </span>
                    </Td>
                    <Td sm="hide" className="text-[13px] break-words">
                      {row.walletName}
                    </Td>
                    <Td align="right">{formatAmountDisplay(row.amount)}</Td>
                    <Td className="text-right">
                      <ButtonLink
                        href={`/statements?wallet=${encodeURIComponent(row.walletId)}`}
                        size="sm"
                        aria-label={`${formatDate(row.date)} ${row.name} の明細を開く`}
                      >
                        明細を開く
                      </ButtonLink>
                    </Td>
                  </TableRow>
                ))}
              </Table>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}
