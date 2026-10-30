"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import {
  markPayrollPaymentDoneAction,
  postPayrollPaymentAction,
  previewPayrollPaymentAction,
} from "../actions";
import { amountKey } from "../_lib/preview-key";
import type { PaymentPreviewView, ScheduleRowView } from "../_lib/views";
import { EntryPreview } from "./entry-preview";

const COLUMNS = {
  columns: "92px 92px minmax(0,1.3fr) 128px minmax(0,1.5fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

export interface WalletOption {
  value: string;
  label: string;
}

interface PaymentValues {
  calendarItemId: string;
  walletId: string;
  paymentDate: string;
  /** 社会保険料 only; empty = the scheduled amount. */
  amount: string;
}

interface PreviewState {
  key: string;
  result: ActionResult<PaymentPreviewView>;
}

const PAYMENT_FIELDS = new Set(["walletId", "paymentDate", "amount"]);

/** What a preview was computed for (納付額 by value: the field reformats itself on blur). */
function paymentKey(values: PaymentValues): string {
  return JSON.stringify({ ...values, amount: amountKey(values.amount) });
}

/**
 * 納付を登録 (22-payroll §5.4・§6.6): 口座・納付日 (and 納付額 for 社会保険料), the entry it posts
 * and the difference from the scheduled amount; then it posts and the deadline becomes 納付済み.
 */
function PaymentSheet({
  row,
  wallets,
  initial,
  initialValues,
  onClose,
}: {
  row: ScheduleRowView;
  wallets: readonly WalletOption[];
  /** The preview of `initialValues`, `null` while it loads. */
  initial: PreviewState | null;
  initialValues: PaymentValues;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const [values, setValues] = useState<PaymentValues>(initialValues);
  const [own, setOwn] = useState<PreviewState | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [previewing, startPreview] = useTransition();
  const [posting, startPost] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  const key = paymentKey(values);
  const preview = own ?? initial;
  const current = preview?.key === key ? preview.result : null;
  const view = current?.ok ? current.data : null;

  function change(patch: Partial<PaymentValues>) {
    const next = { ...values, ...patch };
    setValues(next);
    setError(null);
    const nextKey = paymentKey(next);
    // Only reformatted (納付額 on blur): the preview asked for already applies.
    if (nextKey === key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sequence.current += 1;
      const request = sequence.current;
      startPreview(async () => {
        const result = await previewPayrollPaymentAction(next);
        if (request === sequence.current) setOwn({ key: nextKey, result });
      });
    }, 300);
  }

  function post() {
    startPost(async () => {
      const result = await postPayrollPaymentAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      toast(`「${result.data.title}」を登録しました（${entryNo(result.data.no)}）`);
      onClose();
    });
  }

  const shownError = error ?? (current && !current.ok ? current : null);
  const fieldError = (field: string) => shownError?.fieldErrors[field];
  const alerts = formLevelErrors(shownError, (field) => PAYMENT_FIELDS.has(field));
  const ready = view !== null && !previewing && wallets.length > 0;

  return (
    <Sheet
      open
      onClose={onClose}
      title="納付を登録"
      description={row.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={post} disabled={!ready || posting}>
            {posting ? "登録中…" : "納付を登録"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          期限 <span className="num">{row.dueDate}</span> · 予定額{" "}
          <span className="num font-bold text-text">{row.amount}</span> 円
          {row.breakdown ? <span className="block text-[12px]">{row.breakdown}</span> : null}
        </p>
        {wallets.length === 0 ? (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            払う口座がありません。設定 › 口座 で口座を登録してから納付を登録します。
          </p>
        ) : null}
        <FormField
          label="支払元の口座"
          htmlFor={`${id}-wallet`}
          required
          error={fieldError("walletId")}
        >
          <Select
            id={`${id}-wallet`}
            value={values.walletId}
            onChange={(event) => change({ walletId: event.currentTarget.value })}
          >
            {values.walletId === "" ? <option value="">選んでください</option> : null}
            {wallets.map((wallet) => (
              <option key={wallet.value} value={wallet.value}>
                {wallet.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="納付日" htmlFor={`${id}-date`} required error={fieldError("paymentDate")}>
          <Input
            id={`${id}-date`}
            type="date"
            value={values.paymentDate}
            onChange={(event) => change({ paymentDate: event.currentTarget.value })}
          />
        </FormField>
        {row.isSocialInsurance ? (
          <FormField
            label="納付額（円）"
            htmlFor={`${id}-amount`}
            error={fieldError("amount")}
            help="納入告知額を入れます。空欄は予定額。予定額との差は法定福利費で調整します"
          >
            <MoneyInput
              id={`${id}-amount`}
              value={values.amount}
              placeholder={row.amount}
              onValueChange={(amount) => change({ amount })}
            />
          </FormField>
        ) : (
          <p className="text-[12px] text-muted">
            {row.categoryLabel}
            は予定額で登録します。実際に払った額が違うときは、登録した後に取引で直します。
          </p>
        )}
        {alerts.length > 0 ? (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {alerts.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        <section className="flex flex-col gap-2" aria-live="polite">
          <h3 className="text-[13px] font-bold text-muted">登録する仕訳</h3>
          {view ? (
            <>
              {view.difference ? (
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                  納付額 <span className="num font-bold">{view.paid}</span> 円は予定額{" "}
                  <span className="num">{view.scheduled}</span> 円と{" "}
                  <span className="num font-bold">{view.difference}</span>{" "}
                  円違います。差は法定福利費の行で調整します。
                </p>
              ) : null}
              <EntryPreview entry={view.entry} />
            </>
          ) : (
            <p className="text-[13px] text-muted">
              {shownError ? "入力を直すと、登録する仕訳を出します" : "計算中…"}
            </p>
          )}
        </section>
      </div>
    </Sheet>
  );
}

function StateCell({ row, today }: { row: ScheduleRowView; today: string }) {
  if (row.completed) {
    return (
      <span className="text-[13px] text-muted">
        納付済み
        {row.paymentEntry ? (
          <>
            {" "}
            <Link
              href={`/entries/${row.paymentEntry.id}`}
              className="font-bold text-text underline underline-offset-4"
            >
              {entryNo(row.paymentEntry.no)}
            </Link>
          </>
        ) : null}
        {row.completedAt ? (
          <span className="ml-1 text-[12px] text-muted">{row.completedAt}</span>
        ) : null}
      </span>
    );
  }
  if (row.dueDateValue < today) {
    return <span className="text-[13px] font-bold text-warn">期限を過ぎています</span>;
  }
  return <span className="text-[13px] text-muted">未納付</span>;
}

/** 納付の予定 (22-payroll §6.6, §7): 区分・期限・対象・額・状態, 納付済み folded under the list. */
export function ScheduleTable({
  rows,
  wallets,
  today,
}: {
  rows: ScheduleRowView[];
  wallets: WalletOption[];
  today: string;
}) {
  const toast = useToast();
  const [paying, setPaying] = useState<{
    row: ScheduleRowView;
    values: PaymentValues;
    initial: PreviewState | null;
  } | null>(null);
  const [marking, setMarking] = useState<ScheduleRowView | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [, startInitial] = useTransition();
  const [markPending, startMark] = useTransition();

  const open = rows.filter((row) => !row.completed);
  const done = rows.filter((row) => row.completed);
  const shown = showDone ? [...open, ...done] : open;

  function openPayment(row: ScheduleRowView) {
    const values: PaymentValues = {
      calendarItemId: row.id,
      walletId: wallets[0]?.value ?? "",
      paymentDate: today,
      amount: "",
    };
    setPaying({ row, values, initial: null });
    if (values.walletId === "") return;
    startInitial(async () => {
      const result = await previewPayrollPaymentAction(values);
      setPaying((current) =>
        current?.row.id === row.id && current.initial === null
          ? { ...current, initial: { key: paymentKey(values), result } }
          : current,
      );
    });
  }

  function markDone() {
    if (!marking) return;
    const row = marking;
    startMark(async () => {
      const result = await markPayrollPaymentDoneAction(row.id);
      if (!result.ok) {
        setMarkError(result.error);
        return;
      }
      setMarking(null);
      setMarkError(null);
      toast(`「${result.data.title}」を納付済みにしました`);
    });
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
        納付の予定はまだありません。支給を確定すると、源泉所得税・住民税・社会保険料の期限がここに並びます。
      </p>
    );
  }

  return (
    <>
      {shown.length > 0 ? (
        <Table label="納付の予定">
          <TableHead {...COLUMNS}>
            <Th>区分</Th>
            <Th sm="hide">期限</Th>
            <Th sm="hide">対象</Th>
            <Th align="right">額（円）</Th>
            <Th sm="hide">状態</Th>
          </TableHead>
          {shown.map((row) => (
            <TableRow key={row.id} {...COLUMNS} muted={row.completed}>
              <Td className="font-bold">
                {row.categoryLabel}
                <span className="block text-[12px] font-normal text-muted md:hidden">
                  {row.target} · 期限 <span className="num">{row.dueDate}</span>
                </span>
              </Td>
              <Td sm="hide" className="num text-[13px]">
                {row.dueDate}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {row.target}
              </Td>
              <Td align="right" className="font-bold">
                {row.amount}
                {row.breakdown ? (
                  <span className="block text-[11px] font-normal text-muted">{row.breakdown}</span>
                ) : null}
              </Td>
              <Td sm="full">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StateCell row={row} today={today} />
                  {row.completed ? null : (
                    <span className="ml-auto flex flex-wrap gap-1">
                      <Button size="sm" onClick={() => openPayment(row)}>
                        納付を登録
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setMarkError(null);
                          setMarking(row);
                        }}
                      >
                        納付済みにする
                      </Button>
                    </span>
                  )}
                </span>
              </Td>
            </TableRow>
          ))}
        </Table>
      ) : (
        <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
          未納付の予定はありません。
        </p>
      )}
      {done.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowDone(!showDone)}
          aria-expanded={showDone}
          className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
        >
          <span aria-hidden="true">{showDone ? "▾" : "▸"}</span>
          {showDone ? `納付済み ${done.length} 件を畳む` : `納付済み ${done.length} 件を表示`}
        </button>
      ) : null}
      {paying ? (
        <PaymentSheet
          key={paying.row.id}
          row={paying.row}
          wallets={wallets}
          initial={paying.initial}
          initialValues={paying.values}
          onClose={() => setPaying(null)}
        />
      ) : null}
      <ConfirmDialog
        open={marking !== null}
        title={marking ? `「${marking.title}」を納付済みにします` : ""}
        confirmLabel="納付済みにする"
        pending={markPending}
        error={markError}
        onCancel={() => {
          setMarking(null);
          setMarkError(null);
        }}
        onConfirm={markDone}
      >
        <p>
          口座の明細から納付の仕訳を登録したときに使います。ここでは仕訳を作らず、予定を納付済みにするだけです。
        </p>
        <p className="mt-2 text-[13px] text-muted">
          まだ仕訳がないときは「納付を登録」で口座と日付を選んで登録します（二重に登録しないため）。
        </p>
      </ConfirmDialog>
    </>
  );
}
