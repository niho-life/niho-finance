"use client";

import { displayDate, formatYen, isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, FormField, Input, Select } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import {
  loadExpenseCandidatesAction,
  payExpenseClaimsAction,
  voidExpenseClaimAction,
  type ExpenseCandidateView,
} from "../actions";
import { ReasonButton } from "./reason-dialog";
import type { ClaimantGroupView, ClaimView, WalletOption } from "./views";

const COLUMNS = {
  columns: "104px minmax(0,1.6fr) minmax(0,1fr) 112px 64px 88px",
  mobileColumns: "minmax(0,1fr) auto",
};

const NO_LINE = "none";
const FIELDS = new Set(["claimIds", "paidOn", "walletId", "walletTransactionId"]);

function sumOf(claims: readonly ClaimView[]): bigint {
  return claims.reduce((total, claim) => total + BigInt(claim.amount), 0n);
}

/** 支払う (23 §5.2, §6): the claims to pay (all by default), the date, the wallet, a statement line. */
function PaySheet({
  group,
  wallets,
  today,
  onClose,
}: {
  group: ClaimantGroupView;
  wallets: readonly WalletOption[];
  today: CalendarDate;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const payable = group.claims.filter((claim) => !claim.entry.voided);
  const [selected, setSelected] = useState<string[]>(() => payable.map((claim) => claim.id));
  const [paidOn, setPaidOn] = useState<string>(today);
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? "");
  const [line, setLine] = useState<string>(NO_LINE);
  const [candidates, setCandidates] = useState<ExpenseCandidateView[]>([]);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = payable.filter((claim) => selected.includes(claim.id));
  const total = sumOf(chosen);
  const latest = chosen.reduce<CalendarDate | null>(
    (max, claim) => (max === null || claim.spentOn > max ? claim.spentOn : max),
    null,
  );
  const wallet = wallets.find((item) => item.id === walletId);

  // The unhandled withdrawals of the wallet of exactly the total (明細から選ぶ).
  useEffect(() => {
    let current = true;
    if (!walletId || total <= 0n) return;
    void loadExpenseCandidatesAction({
      walletId,
      amount: total.toString(),
      ...(latest ? { notBefore: latest } : {}),
    }).then((result) => {
      if (!current) return;
      const rows = result.ok ? result.data : [];
      setCandidates(rows);
      setLine((previous) => (rows.some((row) => row.id === previous) ? previous : NO_LINE));
    });
    return () => {
      current = false;
    };
  }, [walletId, total, latest]);

  // Only lines of the current total count (the list of another total may still be shown).
  const shownCandidates =
    total > 0n && walletId ? candidates.filter((item) => BigInt(item.amount) === total) : [];
  const candidate = shownCandidates.find((item) => item.id === line);
  const date = candidate ? candidate.txnDate : paidOn;
  const dateProblem =
    latest && isCalendarDate(date) && date < latest
      ? `利用日（${displayDate(latest)}）以後にしてください`
      : null;

  function submit() {
    startTransition(async () => {
      const result = await payExpenseClaimsAction({
        claimantId: group.claimantId,
        claimIds: chosen.map((claim) => claim.id),
        paidOn: date,
        walletId,
        walletTransactionId: candidate ? candidate.id : "",
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      onClose();
      toast(
        `${group.claimantName} に ${formatYen(BigInt(result.data.amount))} 円を支払いました（仕訳 ${entryNo(result.data.entryNo)}）`,
      );
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  return (
    <Sheet
      open
      onClose={onClose}
      title="支払う"
      description={group.claimantName}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={pending || chosen.length === 0 || !walletId}
          >
            {pending ? "支払中…" : "支払う"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {alerts.length > 0 ? (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {alerts.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[12px] font-bold text-muted">支払う立替精算</legend>
          <ul className="flex flex-col">
            {group.claims.map((claim) => (
              <li key={claim.id} className="border-b border-border py-1.5">
                <Checkbox
                  id={`${id}-claim-${claim.id}`}
                  checked={selected.includes(claim.id)}
                  disabled={claim.entry.voided}
                  onChange={(event) =>
                    setSelected(
                      event.currentTarget.checked
                        ? [...selected, claim.id]
                        : selected.filter((claimId) => claimId !== claim.id),
                    )
                  }
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="num text-[13px] text-muted">
                        {displayDate(claim.spentOn)}
                      </span>
                      <span>{claim.description}</span>
                      <span className="num font-bold">{formatYen(BigInt(claim.amount))} 円</span>
                      {claim.entry.voided ? (
                        <span className="text-[12px] text-danger">
                          計上の仕訳 {entryNo(claim.entry.no)} は取消済み
                        </span>
                      ) : null}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
          {fieldError("claimIds") ? (
            <p role="alert" className="text-[12px] font-bold text-danger">
              {fieldError("claimIds")}
            </p>
          ) : null}
        </fieldset>

        <FormField
          label="支払元の口座"
          htmlFor={`${id}-wallet`}
          required
          error={fieldError("walletId")}
          help={wallets.length === 0 ? "有効な銀行・現金の口座がありません（設定 › 口座）" : null}
        >
          <Select
            id={`${id}-wallet`}
            value={walletId}
            onChange={(event) => setWalletId(event.currentTarget.value)}
          >
            {wallets.length === 0 ? <option value="">口座がありません</option> : null}
            {wallets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </Select>
        </FormField>

        {shownCandidates.length > 0 ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[12px] font-bold text-muted">明細から選ぶ</legend>
            <p className="text-[12px] text-muted-2">
              未処理の出金で、金額が合計と同じ明細です。選ぶと支払日は明細の日付になります
            </p>
            <ul className="flex flex-col">
              {shownCandidates.map((item) => (
                <li key={item.id} className="border-b border-border">
                  <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2">
                    <input
                      type="radio"
                      name={`${id}-line`}
                      checked={line === item.id}
                      onChange={() => setLine(item.id)}
                      className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="num text-[13px] text-muted">
                          {displayDate(item.txnDate)}
                        </span>
                        <span className="num font-bold">−{formatYen(BigInt(item.amount))}</span>
                      </span>
                      <span className="truncate text-[13px]">{item.description}</span>
                    </span>
                  </label>
                </li>
              ))}
              <li>
                <label className="flex min-h-11 cursor-pointer items-center gap-2.5 py-2">
                  <input
                    type="radio"
                    name={`${id}-line`}
                    checked={!candidate}
                    onChange={() => setLine(NO_LINE)}
                    className="size-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="text-[14px] font-bold">明細なしで支払う</span>
                </label>
              </li>
            </ul>
            {fieldError("walletTransactionId") ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {fieldError("walletTransactionId")}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <FormField
          label="支払日"
          htmlFor={`${id}-paid-on`}
          required
          error={fieldError("paidOn")}
          help={dateProblem ?? (candidate ? "明細の日付です" : null)}
        >
          <Input
            id={`${id}-paid-on`}
            type="date"
            value={date}
            readOnly={Boolean(candidate)}
            onChange={(event) => setPaidOn(event.currentTarget.value)}
          />
        </FormField>

        {chosen.length > 0 && wallet ? (
          <p aria-live="polite" className="text-[14px]">
            <span className="num font-bold">{chosen.length}</span> 件・
            <span className="num font-bold">{formatYen(total)}</span> 円を {wallet.name}{" "}
            から支払います
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

function ClaimRow({ claim }: { claim: ClaimView }) {
  const router = useRouter();
  const toast = useToast();
  return (
    <TableRow {...COLUMNS}>
      <Td sm="hide" className="num text-[13px]">
        {displayDate(claim.spentOn)}
      </Td>
      <Td>
        <span className="block truncate font-semibold">{claim.description}</span>
        <span className="block truncate text-[12px] text-muted md:hidden">
          {displayDate(claim.spentOn)} · {claim.account}
        </span>
        {claim.entry.voided ? (
          <span className="block text-[12px] text-danger">
            計上の仕訳 {entryNo(claim.entry.no)}{" "}
            は取消済みです。この立替精算を取り消して出し直してください
          </span>
        ) : null}
      </Td>
      <Td sm="hide" className="truncate text-[13px]">
        {claim.account}
      </Td>
      <Td align="right" className="font-bold">
        {formatYen(BigInt(claim.amount))}
      </Td>
      <Td sm="hide" className="text-[13px]">
        {claim.hasDocument ? <span>あり</span> : <span className="text-muted-2">なし</span>}
      </Td>
      <Td sm="full" className="flex items-center justify-end gap-1">
        <Link
          href={`/entries/${claim.entry.id}`}
          className="text-[12px] text-muted underline-offset-4 hover:underline"
        >
          {entryNo(claim.entry.no)}
        </Link>
        <ReasonButton
          label="取消"
          title="立替精算を取り消します"
          confirmLabel="取消"
          action={(reason) => voidExpenseClaimAction(claim.id, { reason })}
          onDone={(data) => {
            toast(
              data.reversalNo === null
                ? "立替精算を取り消しました"
                : `立替精算を取り消しました（反対仕訳 ${entryNo(data.reversalNo)}）`,
            );
            router.refresh();
          }}
        >
          <p>
            「{claim.description}」
            <span className="num font-bold">{formatYen(BigInt(claim.amount))}</span> 円の計上の仕訳{" "}
            {entryNo(claim.entry.no)}{" "}
            {claim.entry.voided
              ? "は取消済みです。立替精算を取消済みにします。"
              : "を反対仕訳で取り消します。締めた月なら、反対仕訳の日付は開いている最初の日になります。"}
          </p>
        </ReasonButton>
      </Td>
    </TableRow>
  );
}

/** 未払 (23 §6): per claimant, with 支払う and each claim's 取消. */
export function UnpaidSection({
  groups,
  wallets,
  today,
}: {
  groups: readonly ClaimantGroupView[];
  wallets: readonly WalletOption[];
  today: CalendarDate;
}) {
  const [paying, setPaying] = useState<string | null>(null);
  const group = groups.find((item) => item.claimantId === paying);
  return (
    <div className="flex flex-col gap-5">
      {groups.map((item) => (
        <div key={item.claimantId} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[14px] font-extrabold">{item.claimantName}</h3>
            <span className="num text-[13px] text-muted">
              {item.count} 件・{formatYen(BigInt(item.total))} 円
            </span>
            <span className="ml-auto">
              <Button variant="primary" size="sm" onClick={() => setPaying(item.claimantId)}>
                支払う
              </Button>
            </span>
          </div>
          <Table label={`${item.claimantName} の未払の立替精算`}>
            <TableHead {...COLUMNS}>
              <Th sm="hide">利用日</Th>
              <Th>内容</Th>
              <Th sm="hide">科目</Th>
              <Th align="right">金額（円）</Th>
              <Th sm="hide">証憑</Th>
              <Th sm="hide">操作</Th>
            </TableHead>
            {item.claims.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} />
            ))}
          </Table>
        </div>
      ))}
      {group ? (
        <PaySheet
          key={group.claimantId}
          group={group}
          wallets={wallets}
          today={today}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </div>
  );
}
