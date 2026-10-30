"use client";

import { displayDate, formatYen, type CalendarDate } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createRecurringInvoiceDraftAction, createRecurringInvoiceDraftsAction } from "../actions";

/** A due date without a draft (amounts as decimal text). */
export interface DueRowModel {
  key: string;
  recurringInvoiceId: string;
  month: string;
  name: string;
  partnerName: string;
  date: CalendarDate;
  title: string | null;
  /** 税込の合計, or `null` when a tax category has no rule on the date. */
  total: string | null;
}

const COLUMNS = {
  columns: "100px minmax(0,1.2fr) minmax(0,1fr) 112px 128px",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 予定日の作成 (18 §14.5): one row per due date (予定日 ・ 名前 ・ 取引先 ・ 金額 ・ 下書きを作る), two
 * lines on phones with the button kept. One draft opens its detail to be checked and issued; 「まと
 * めて下書きを作る」 confirms the count and the total, then keeps the refused rows with their reason.
 */
export function DueList({ rows }: { rows: readonly DueRowModel[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const known = rows.filter((row) => row.total !== null);
  const sum = known.reduce((total, row) => total + BigInt(row.total ?? "0"), 0n);

  function makeOne(row: DueRowModel) {
    setPendingKey(row.key);
    startTransition(async () => {
      const result = await createRecurringInvoiceDraftAction({
        recurringInvoiceId: row.recurringInvoiceId,
        month: row.month,
      });
      setPendingKey(null);
      if (!result.ok) {
        setReasons({ ...reasons, [row.key]: result.error });
        return;
      }
      toast(`${result.data.name} の下書きを作りました`);
      router.push(`/invoices/${result.data.invoiceId}`);
    });
  }

  function makeAll() {
    startTransition(async () => {
      const result = await createRecurringInvoiceDraftsAction({
        items: rows.map((row) => ({
          recurringInvoiceId: row.recurringInvoiceId,
          month: row.month,
        })),
      });
      if (!result.ok) {
        setBulkError(result.error);
        return;
      }
      const next: Record<string, string> = {};
      for (const item of result.data.items) {
        if (!item.ok) next[`${item.recurringInvoiceId}:${item.month}`] = item.message;
      }
      setReasons(next);
      setConfirming(false);
      setBulkError(null);
      toast(
        result.data.failed > 0
          ? `${result.data.created} 件の下書きを作りました。${result.data.failed} 件は作れませんでした`
          : `${result.data.created} 件の下書きを作りました`,
        {
          ...(result.data.failed > 0 ? { tone: "error" as const } : {}),
          ...(result.data.created > 0
            ? { link: { href: "/invoices?status=draft", label: "下書きの一覧" } }
            : {}),
        },
      );
      router.refresh();
    });
  }

  return (
    <>
      {rows.length > 1 ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setConfirming(true)} disabled={pending}>
            まとめて下書きを作る（{rows.length} 件）
          </Button>
          <span className="text-[12px] text-muted">
            下書きは自動では発行しません。請求の一覧で確かめて発行します
          </span>
        </div>
      ) : null}
      <Table label="下書きを作る定期請求" minWidth={720}>
        <TableHead {...COLUMNS}>
          <Th>予定日</Th>
          <Th>名前</Th>
          <Th>取引先</Th>
          <Th align="right">金額（円）</Th>
          <Th>
            <span className="sr-only">操作</span>
          </Th>
        </TableHead>
        {rows.map((row) => {
          const reason = reasons[row.key];
          return (
            <TableRow key={row.key} {...COLUMNS}>
              <Td sm="hide" className="num text-[13px]">
                {displayDate(row.date)}
              </Td>
              <Td className="min-w-0">
                <span className="num mr-2 text-[13px] md:hidden">{displayDate(row.date)}</span>
                <span className="font-semibold break-words">{row.name}</span>
                {row.title ? (
                  <span className="block truncate text-[12px] text-muted">{row.title}</span>
                ) : null}
                <span className="block text-[12px] md:hidden">
                  <span className="text-muted">{row.partnerName}</span>
                  <span className="num ml-2 font-bold">
                    {row.total === null ? "—" : `${formatYen(BigInt(row.total))} 円`}
                  </span>
                </span>
                {reason ? (
                  <span role="alert" className="block text-[12px] font-bold text-danger">
                    {reason}
                  </span>
                ) : null}
              </Td>
              <Td sm="hide" className="truncate">
                {row.partnerName}
              </Td>
              <Td sm="hide" align="right" className="font-bold">
                {row.total === null ? "—" : formatYen(BigInt(row.total))}
              </Td>
              <Td align="right">
                <Button variant="primary" size="sm" onClick={() => makeOne(row)} disabled={pending}>
                  {pendingKey === row.key ? "作成中…" : "下書きを作る"}
                </Button>
              </Td>
            </TableRow>
          );
        })}
      </Table>
      <ConfirmDialog
        open={confirming}
        title={`下書きを ${rows.length} 件作ります`}
        confirmLabel="下書きを作る"
        pending={pending}
        error={bulkError}
        onCancel={() => {
          setConfirming(false);
          setBulkError(null);
        }}
        onConfirm={makeAll}
      >
        <p>
          合計 <span className="num font-bold">{formatYen(sum)}</span> 円（税込）
          {known.length < rows.length ? "。税率の規則がなく金額を出せない行を除きます" : ""}
          。発行はしません。作った下書きは請求の一覧で確かめて発行します
        </p>
      </ConfirmDialog>
    </>
  );
}
