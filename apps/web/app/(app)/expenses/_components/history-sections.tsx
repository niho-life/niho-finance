"use client";

import { displayDate } from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { entryNo, formatYenDisplay } from "@/lib/format";
import { cancelExpensePaymentAction } from "../actions";
import { ReasonButton } from "./reason-dialog";
import type { PaymentView, VoidedClaimView } from "./views";

const PAYMENT_COLUMNS = {
  columns: "104px minmax(0,1.2fr) 56px 112px minmax(0,1fr) 80px 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

const VOIDED_COLUMNS = {
  columns: "104px minmax(0,1fr) minmax(0,1.4fr) 112px minmax(0,1.4fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function EntryLink({ id, no }: { id: string; no: number }) {
  return (
    <Link href={`/entries/${id}`} className="num underline-offset-4 hover:underline">
      {entryNo(no)}
    </Link>
  );
}

function PaymentRow({ payment }: { payment: PaymentView }) {
  const router = useRouter();
  const toast = useToast();
  return (
    <TableRow {...PAYMENT_COLUMNS} muted={payment.cancelled}>
      <Td sm="hide" className="num text-[13px]">
        {displayDate(payment.paidOn)}
      </Td>
      <Td>
        <span className="block truncate font-semibold">{payment.claimantName}</span>
        <span className="block truncate text-[12px] text-muted md:hidden">
          {displayDate(payment.paidOn)} · {payment.count} 件 · {payment.walletName}
        </span>
        {payment.cancelled ? (
          <span className="block truncate text-[12px] text-muted">
            取消済み{payment.cancelReason ? `（${payment.cancelReason}）` : ""}
            {payment.reversalNo !== null ? ` · 反対仕訳 ${entryNo(payment.reversalNo)}` : ""}
          </span>
        ) : null}
      </Td>
      <Td sm="hide" align="right">
        {payment.count}
      </Td>
      <Td align="right" className="font-bold">
        {formatYenDisplay(BigInt(payment.total))}
      </Td>
      <Td sm="hide" className="truncate text-[13px]">
        {payment.walletName}
      </Td>
      <Td sm="hide" className="text-[13px]">
        <EntryLink id={payment.entry.id} no={payment.entry.no} />
      </Td>
      <Td sm="full" className="flex justify-end">
        {payment.cancelled ? null : (
          <ReasonButton
            label="支払の取消"
            title="支払を取り消します"
            confirmLabel="支払の取消"
            action={(reason) => cancelExpensePaymentAction(payment.id, { reason })}
            onDone={(data) => {
              toast(
                data.reversalNo === null
                  ? "支払を取り消しました。立替精算は未払に戻りました"
                  : `支払を取り消しました（反対仕訳 ${entryNo(data.reversalNo)}）。立替精算は未払に戻りました`,
              );
              router.refresh();
            }}
          >
            <p>
              {payment.claimantName} への{" "}
              <span className="num font-bold">{formatYenDisplay(BigInt(payment.total))}</span> 円（
              {payment.count} 件）の支払の仕訳 {entryNo(payment.entry.no)}{" "}
              {payment.entry.voided
                ? "は取消済みです。支払だけを取り消します。"
                : "を反対仕訳で取り消します。締めた月なら、反対仕訳の日付は開いている最初の日になります。"}
              照合した明細は未処理に戻ります。
            </p>
          </ReasonButton>
        )}
      </Td>
    </TableRow>
  );
}

/** 支払済み (23 §6): one row per payment, the cancelled ones muted. */
export function PaymentsTable({ payments }: { payments: readonly PaymentView[] }) {
  return (
    <Table label="支払済み">
      <TableHead {...PAYMENT_COLUMNS}>
        <Th sm="hide">支払日</Th>
        <Th>立替えた人</Th>
        <Th sm="hide" align="right">
          件数
        </Th>
        <Th align="right">合計（円）</Th>
        <Th sm="hide">口座</Th>
        <Th sm="hide">仕訳</Th>
        <Th sm="hide">操作</Th>
      </TableHead>
      {payments.map((payment) => (
        <PaymentRow key={payment.id} payment={payment} />
      ))}
    </Table>
  );
}

/** 取消済み n 件を表示 (23 §6): folded under the page. */
export function VoidedClaims({ claims }: { claims: readonly VoidedClaimView[] }) {
  const [open, setOpen] = useState(false);
  if (claims.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex min-h-8 w-fit items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {open ? `取消済み ${claims.length} 件を畳む` : `取消済み ${claims.length} 件を表示`}
      </button>
      {open ? (
        <Table label="取消済みの立替精算">
          <TableHead {...VOIDED_COLUMNS}>
            <Th sm="hide">利用日</Th>
            <Th sm="hide">立替えた人</Th>
            <Th>内容</Th>
            <Th align="right">金額（円）</Th>
            <Th sm="hide">理由</Th>
          </TableHead>
          {claims.map((claim) => (
            <TableRow key={claim.id} {...VOIDED_COLUMNS} muted>
              <Td sm="hide" className="num text-[13px]">
                {displayDate(claim.spentOn)}
              </Td>
              <Td sm="hide" className="truncate">
                {claim.claimantName}
              </Td>
              <Td>
                <span className="block truncate">{claim.description}</span>
                <span className="block truncate text-[12px] md:hidden">
                  {displayDate(claim.spentOn)} · {claim.claimantName}
                </span>
                <span className="block truncate text-[12px]">
                  計上 <EntryLink id={claim.entry.id} no={claim.entry.no} />
                  {claim.reversalNo !== null ? ` · 反対仕訳 ${entryNo(claim.reversalNo)}` : ""}
                </span>
              </Td>
              <Td align="right">{formatYenDisplay(BigInt(claim.amount))}</Td>
              <Td sm="hide" className="truncate text-[13px]">
                {claim.voidReason ?? ""}
              </Td>
            </TableRow>
          ))}
        </Table>
      ) : null}
    </div>
  );
}
