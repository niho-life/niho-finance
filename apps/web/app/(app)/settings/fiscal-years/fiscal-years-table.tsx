"use client";

import type { ClosePreview, FiscalYearSettings } from "@niho-finance/db";
import {
  ACCOUNTING_METHOD_LABELS,
  ACCOUNTING_METHODS,
  CONSUMPTION_TAX_METHOD_LABELS,
  CONSUMPTION_TAX_METHODS,
  defaultAccountingMethod,
  displayDate,
  FISCAL_YEAR_STATUS_LABELS,
  type AccountingMethod,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type FiscalYearPeriod,
} from "@niho-finance/ledger";
import { useId, useRef, useState, useTransition } from "react";
import { SaveStatus, type SaveState } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { ActionError } from "@/lib/action-types";
import { formatDate, formatPeriod } from "@/lib/format";
import {
  closeFiscalYearAction,
  createNextFiscalYearAction,
  previewFiscalYearCloseAction,
  updateFiscalYearAction,
} from "../actions";

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
  columns: "minmax(0,1.4fr) 140px 120px 156px 76px minmax(64px,130px)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

/** What a change of the close affects, as the sheet and the confirmation say it (11 §7). */
function impactText(preview: ClosePreview): string | null {
  const range = preview.range;
  if (!range) return null;
  const period = `${displayDate(range.from)}〜${displayDate(range.to)} の仕訳 ${preview.count} 件`;
  return range.direction === "close"
    ? `${period}が読み取り専用になります`
    : `${period}が再び登録・取消できるようになります`;
}

/**
 * 締め (11 §7): a month end from the select (or 締めない), its impact, the reason (required to move
 * it back), then a confirmation. Mounted while open, so it always starts from the saved close.
 */
function CloseSheet({
  year,
  options,
  onClose,
}: {
  year: FiscalYearSettings;
  options: readonly CalendarDate[];
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const current = year.lockedThrough ?? "";
  const [value, setValue] = useState<string>(current);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ClosePreview>({ range: null, count: 0 });
  const [error, setError] = useState<ActionError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();
  const sequence = useRef(0);

  function choose(next: string) {
    setValue(next);
    setError(null);
    sequence.current += 1;
    const request = sequence.current;
    startPreview(async () => {
      const result = await previewFiscalYearCloseAction(year.id, next);
      if (request !== sequence.current) return;
      if (result.ok) setPreview(result.data);
      else {
        setPreview({ range: null, count: 0 });
        setError(result);
      }
    });
  }

  const direction = preview.range?.direction ?? null;
  const impact = impactText(preview);
  const date = value ? displayDate(value as CalendarDate) : null;
  const title =
    direction === "close"
      ? `第 ${year.no} 期を ${date ?? ""} まで締めます`
      : date
        ? `第 ${year.no} 期の締めを ${date} に戻します`
        : `第 ${year.no} 期の締めを外します`;
  const verb = direction === "reopen" ? "締めを戻す" : "締める";
  const changed = value !== current && direction !== null && !previewing;

  function save() {
    startSave(async () => {
      const result = await closeFiscalYearAction(year.id, { lockedThrough: value, reason });
      if (!result.ok) {
        setError(result);
        setConfirming(false);
        return;
      }
      toast(
        direction === "close"
          ? `第 ${year.no} 期を ${date ?? ""} まで締めました`
          : date
            ? `第 ${year.no} 期の締めを ${date} に戻しました`
            : `第 ${year.no} 期の締めを外しました`,
      );
      onClose();
    });
  }

  const formError =
    error && !error.fieldErrors.reason && !error.fieldErrors.lockedThrough ? error.error : null;

  return (
    <Sheet
      open
      onClose={onClose}
      title={`第 ${year.no} 期の締め`}
      description={formatPeriod(year.startDate, year.endDate)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" disabled={!changed} onClick={() => setConfirming(true)}>
            {verb}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          締め日までの仕訳は読み取り専用になり、登録・取消・訂正ができなくなります。締めた月の仕訳の訂正と取消は、開いている最初の日付で登録します。
        </p>
        <FormField
          label="締め日"
          htmlFor={`${id}-date`}
          error={error?.fieldErrors.lockedThrough}
          help={options.length === 0 ? "まだ締められる月末がありません" : undefined}
        >
          <Select
            id={`${id}-date`}
            value={value}
            onChange={(event) => choose(event.currentTarget.value)}
          >
            <option value="">締めない</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {displayDate(option)}
              </option>
            ))}
          </Select>
        </FormField>
        <p aria-live="polite" className="min-h-5 text-[14px]">
          {previewing ? (
            <span className="text-muted">件数を数えています…</span>
          ) : impact ? (
            <span className="font-bold">{impact}</span>
          ) : (
            <span className="text-muted">締め日は変わりません</span>
          )}
        </p>
        <FormField
          label="理由"
          htmlFor={`${id}-reason`}
          required={direction === "reopen"}
          error={error?.fieldErrors.reason}
          help={direction === "reopen" ? "締めを戻すときは理由を残します" : "任意"}
        >
          <Textarea
            id={`${id}-reason`}
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.currentTarget.value);
              if (error?.fieldErrors.reason) setError(null);
            }}
          />
        </FormField>
        {formError ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {formError}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title={title}
        confirmLabel={verb}
        pending={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={save}
      >
        {impact ? <p className="font-bold">{impact}</p> : null}
        {reason.trim() ? (
          <p className="mt-2 text-[13px] text-muted">理由: {reason.trim()}</p>
        ) : null}
      </ConfirmDialog>
    </Sheet>
  );
}

function CloseCell({
  year,
  options,
}: {
  year: FiscalYearSettings;
  options: readonly CalendarDate[];
}) {
  const [open, setOpen] = useState(false);
  if (year.status === "closed") {
    return (
      <Td sm="full" className="text-muted">
        <span className="mr-1 text-[11px] text-muted-2 md:hidden">締め</span>
        決算済み
      </Td>
    );
  }
  return (
    <Td sm="full">
      <span className="flex items-center gap-2">
        <span className="num min-w-0 text-muted">
          <span className="mr-1 text-[11px] text-muted-2 md:hidden">締め</span>
          {formatDate(year.lockedThrough)}
        </span>
        <Button size="sm" onClick={() => setOpen(true)} aria-label={`第 ${year.no} 期の締め`}>
          締め
        </Button>
      </span>
      {open ? <CloseSheet year={year} options={options} onClose={() => setOpen(false)} /> : null}
    </Td>
  );
}

function FiscalYearRow({
  year,
  closeOptions,
}: {
  year: FiscalYearSettings;
  closeOptions: readonly CalendarDate[];
}) {
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
      <CloseCell year={year} options={closeOptions} />
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
  closeOptions,
}: {
  fiscalYears: FiscalYearSettings[];
  next: FiscalYearPeriod | null;
  fiscalYearEndMonth: number;
  /** The month ends each year can be closed through, by fiscal year id (`listCloseOptions`). */
  closeOptions: Readonly<Record<string, readonly CalendarDate[]>>;
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
          <Th>締め</Th>
          <Th sm="hide">状態</Th>
          <Th />
        </TableHead>
        {fiscalYears.map((year) => (
          <FiscalYearRow key={year.id} year={year} closeOptions={closeOptions[year.id] ?? []} />
        ))}
      </Table>
      <p className="mt-2 text-[12px] text-muted">
        締め日までの仕訳は登録・取消・訂正ができません（締めた月の仕訳の訂正・取消は、開いている最初の日付で登録します）。仕訳のある期の消費税の区分を変えるときは確認します。
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
