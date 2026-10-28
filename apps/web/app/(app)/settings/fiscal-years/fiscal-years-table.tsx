"use client";

import type { FiscalYearSettings } from "@niho-finance/db";
import {
  ACCOUNTING_METHOD_LABELS,
  ACCOUNTING_METHODS,
  CONSUMPTION_TAX_METHOD_LABELS,
  CONSUMPTION_TAX_METHODS,
  defaultAccountingMethod,
  FISCAL_YEAR_STATUS_LABELS,
  type AccountingMethod,
  type ConsumptionTaxMethod,
  type FiscalYearPeriod,
} from "@niho-finance/ledger";
import { useId, useState, useTransition } from "react";
import { SaveStatus, type SaveState } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { ActionError } from "@/lib/action-types";
import { formatDate, formatPeriod } from "@/lib/format";
import { createNextFiscalYearAction, updateFiscalYearAction } from "../actions";

interface TaxValues {
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
}

/** Exempt → tax-inclusive; leaving exempt → tax-exclusive by default; otherwise kept. */
function nextValues(current: TaxValues, consumptionTax: ConsumptionTaxMethod): TaxValues {
  if (consumptionTax === "exempt") return { consumptionTax, accountingMethod: "tax_inclusive" };
  if (current.consumptionTax === "exempt") {
    return { consumptionTax, accountingMethod: defaultAccountingMethod(consumptionTax) };
  }
  return { consumptionTax, accountingMethod: current.accountingMethod };
}

const COLUMNS = {
  columns: "minmax(0,1.5fr) 150px 130px 88px 84px minmax(72px,150px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

function FiscalYearRow({ year }: { year: FiscalYearSettings }) {
  const [values, setValues] = useState<TaxValues>({
    consumptionTax: year.consumptionTax,
    accountingMethod: year.accountingMethod,
  });
  const [asking, setAsking] = useState<TaxValues | null>(null);
  const [status, setStatus] = useState<SaveState>({ state: "idle" });
  const [pending, startTransition] = useTransition();
  const closed = year.status === "closed";

  function save(next: TaxValues) {
    const previous = values;
    setValues(next);
    setAsking(null);
    startTransition(async () => {
      const result = await updateFiscalYearAction(year.id, next);
      if (result.ok) {
        setStatus({ state: "saved" });
      } else {
        setValues(previous);
        setStatus({ state: "error", message: result.error });
      }
    });
  }

  /** Changing the tax of a year with entries is confirmed first (10 §4.2). */
  function request(next: TaxValues) {
    if (year.entryCount > 0) setAsking(next);
    else save(next);
  }

  return (
    <TableRow {...COLUMNS}>
      <Td sm="full">
        <span className="font-bold">第 {year.no} 期</span>
        <span className="num ml-3 text-muted">{formatPeriod(year.startDate, year.endDate)}</span>
      </Td>
      <Td>
        <select
          aria-label={`第 ${year.no} 期の消費税の区分`}
          className="cell-input"
          value={values.consumptionTax}
          disabled={closed || pending}
          onChange={(event) =>
            request(nextValues(values, event.currentTarget.value as ConsumptionTaxMethod))
          }
        >
          {CONSUMPTION_TAX_METHODS.map((method) => (
            <option key={method} value={method}>
              {CONSUMPTION_TAX_METHOD_LABELS[method]}
            </option>
          ))}
        </select>
      </Td>
      <Td>
        <select
          aria-label={`第 ${year.no} 期の経理方式`}
          className="cell-input"
          value={values.accountingMethod}
          disabled={closed || pending || values.consumptionTax === "exempt"}
          onChange={(event) =>
            request({ ...values, accountingMethod: event.currentTarget.value as AccountingMethod })
          }
        >
          {ACCOUNTING_METHODS.map((method) => (
            <option key={method} value={method}>
              {ACCOUNTING_METHOD_LABELS[method]}
            </option>
          ))}
        </select>
      </Td>
      <Td sm="hide" className="num text-muted">
        {formatDate(year.lockedThrough)}
      </Td>
      <Td sm="hide">{FISCAL_YEAR_STATUS_LABELS[year.status]}</Td>
      <SaveStatus status={pending ? { state: "saving" } : status} />
      <ConfirmDialog
        open={asking !== null}
        title={`第 ${year.no} 期の消費税の区分を変えます`}
        confirmLabel="保存"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          if (asking) save(asking);
        }}
      >
        {asking ? (
          <>
            <p>
              第 {year.no} 期には仕訳が <span className="num font-bold">{year.entryCount} 件</span>
              あります。
            </p>
            <p className="mt-2">
              {CONSUMPTION_TAX_METHOD_LABELS[values.consumptionTax]}・
              {ACCOUNTING_METHOD_LABELS[values.accountingMethod]} →{" "}
              <span className="font-bold">
                {CONSUMPTION_TAX_METHOD_LABELS[asking.consumptionTax]}・
                {ACCOUNTING_METHOD_LABELS[asking.accountingMethod]}
              </span>
            </p>
            <p className="mt-2 text-[13px] text-muted">
              登録済みの仕訳の金額は変わりません。税抜経理の仮受・仮払の行は、これから登録する仕訳に付きます。
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </TableRow>
  );
}

function NextFiscalYearSheet({
  open,
  onClose,
  next,
  lastNo,
  lastTax,
  fiscalYearEndMonth,
}: {
  open: boolean;
  onClose: () => void;
  next: FiscalYearPeriod;
  lastNo: number;
  lastTax: TaxValues;
  fiscalYearEndMonth: number;
}) {
  const id = useId();
  const toast = useToast();
  const [endDate, setEndDate] = useState<string>(next.endDate);
  const [values, setValues] = useState<TaxValues>(lastTax);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const result = await createNextFiscalYearAction({ endDate, ...values });
      if (result.ok) {
        setConfirming(false);
        setError(null);
        onClose();
        toast(`第 ${lastNo + 1} 期を作りました`);
      } else {
        setError(result);
        setConfirming(false);
      }
    });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`第 ${lastNo + 1} 期を作る`}
      description="直前の期の翌日から始まります"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={!endDate}>
            作成
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-[12px] font-bold text-muted">開始日</p>
          <p className="num mt-1 font-bold">{formatDate(next.startDate)}</p>
        </div>
        <FormField
          label="終了日"
          htmlFor={`${id}-end`}
          help={`12 か月後の決算月（${fiscalYearEndMonth} 月）の末日を提案しています`}
          error={error?.fieldErrors.endDate}
        >
          <Input
            id={`${id}-end`}
            type="date"
            value={endDate}
            min={next.startDate}
            onChange={(event) => setEndDate(event.currentTarget.value)}
          />
        </FormField>
        <FormField label="消費税の区分" htmlFor={`${id}-tax`}>
          <Select
            id={`${id}-tax`}
            value={values.consumptionTax}
            onChange={(event) =>
              setValues(nextValues(values, event.currentTarget.value as ConsumptionTaxMethod))
            }
          >
            {CONSUMPTION_TAX_METHODS.map((method) => (
              <option key={method} value={method}>
                {CONSUMPTION_TAX_METHOD_LABELS[method]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="経理方式"
          htmlFor={`${id}-method`}
          help={
            values.consumptionTax === "exempt" ? "免税の期は税込経理に決まっています" : undefined
          }
        >
          <Select
            id={`${id}-method`}
            value={values.accountingMethod}
            disabled={values.consumptionTax === "exempt"}
            onChange={(event) =>
              setValues({
                ...values,
                accountingMethod: event.currentTarget.value as AccountingMethod,
              })
            }
          >
            {ACCOUNTING_METHODS.map((method) => (
              <option key={method} value={method}>
                {ACCOUNTING_METHOD_LABELS[method]}
              </option>
            ))}
          </Select>
        </FormField>
        {error && !error.fieldErrors.endDate ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error.error}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title={`第 ${lastNo + 1} 期を作ります`}
        confirmLabel="作成"
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={create}
      >
        <p className="num font-bold">{formatPeriod(next.startDate, endDate)}</p>
        <p className="mt-1 text-muted">
          {CONSUMPTION_TAX_METHOD_LABELS[values.consumptionTax]} ·{" "}
          {ACCOUNTING_METHOD_LABELS[values.accountingMethod]}
        </p>
        <p className="mt-3 text-[13px] text-muted">
          期間はあとから変えられません。期は削除できません。
        </p>
      </ConfirmDialog>
    </Sheet>
  );
}

export function FiscalYearsTable({
  fiscalYears,
  next,
  fiscalYearEndMonth,
}: {
  fiscalYears: FiscalYearSettings[];
  next: FiscalYearPeriod | null;
  fiscalYearEndMonth: number;
}) {
  const [creating, setCreating] = useState(false);
  const last = fiscalYears[fiscalYears.length - 1];
  return (
    <>
      <Table label="会計期間">
        <TableHead {...COLUMNS}>
          <Th>期間</Th>
          <Th>消費税の区分</Th>
          <Th>経理方式</Th>
          <Th sm="hide">締め日</Th>
          <Th sm="hide">状態</Th>
          <Th />
        </TableHead>
        {fiscalYears.map((year) => (
          <FiscalYearRow key={year.id} year={year} />
        ))}
      </Table>
      <p className="mt-2 text-[12px] text-muted">
        締め日は月次の締め（準備中）で設定されます。仕訳のある期の消費税の区分を変えるときは確認します。
      </p>
      {next && last ? (
        <div className="mt-4">
          <Button onClick={() => setCreating(true)}>次の期を作る</Button>
          <NextFiscalYearSheet
            key={last.id}
            open={creating}
            onClose={() => setCreating(false)}
            next={next}
            lastNo={last.no}
            lastTax={{
              consumptionTax: last.consumptionTax,
              accountingMethod: last.accountingMethod,
            }}
            fiscalYearEndMonth={fiscalYearEndMonth}
          />
        </div>
      ) : null}
    </>
  );
}
