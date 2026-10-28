"use client";

import type { EntryFormFiscalYear, EntryFormOptions } from "@niho-finance/db";
import {
  allowedDepreciationMethods,
  checkDepreciationChoice,
  depreciationWarnings,
  formatYen,
  isCalendarDate,
  parseYenInput,
  splitTaxInclusive,
  type CalendarDate,
  type DepreciationMethod,
  type Money,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { ReasonAction } from "../../_components/reason-action";
import {
  disposeFixedAssetAction,
  updateFixedAssetAction,
  voidFixedAssetAction,
} from "../../actions";
import {
  closedYearNote,
  disposalDateProblem,
  fiscalYearContaining,
  isLifeBased,
  methodLabel,
  UsefulLifeHints,
} from "./asset-kit";

function Alerts({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <span className="block font-bold text-warn">{children}</span>;
}

// ---------------------------------------------------------------------------
// 編集 (§5.2)
// ---------------------------------------------------------------------------

export interface EditableAsset {
  id: string;
  name: string;
  segmentId: string;
  note: string;
  accountId: string;
  acquisitionDate: CalendarDate;
  /** As the input shows it. */
  cost: string;
  method: DepreciationMethod;
  usefulLifeYears: string;
}

interface EditDraft {
  name: string;
  segmentId: string;
  note: string;
  accountId: string;
  acquisitionDate: string;
  cost: string;
  method: DepreciationMethod;
  usefulLifeYears: string;
}

const EDIT_FIELDS = new Set([
  "name",
  "segmentId",
  "note",
  "accountId",
  "acquisitionDate",
  "cost",
  "method",
  "usefulLifeYears",
]);

/**
 * 編集 (16 §5.2): 名称・セグメント・メモ at any time; 取得価額・取得日・科目・償却方法・耐用年数 only while
 * there is no depreciation or disposal entry (disabled with the reason otherwise).
 */
export function EditAssetSheet({
  asset,
  canEditParameters,
  editBlockedReason,
  accounts,
  segments,
  fiscalYears,
}: {
  asset: EditableAsset;
  canEditParameters: boolean;
  editBlockedReason: string | null;
  accounts: readonly { id: string; code: string; label: string }[];
  segments: readonly { id: string; name: string }[];
  fiscalYears: readonly EntryFormFiscalYear[];
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const initial = (): EditDraft => ({
    name: asset.name,
    segmentId: asset.segmentId,
    note: asset.note,
    accountId: asset.accountId,
    acquisitionDate: asset.acquisitionDate,
    cost: asset.cost,
    method: asset.method,
    usefulLifeYears: asset.usefulLifeYears,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(initial);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const accountCode = accounts.find((account) => account.id === draft.accountId)?.code ?? null;
  const cost: Money | null = parseYenInput(draft.cost);
  const allowed = accountCode ? allowedDepreciationMethods(accountCode) : [draft.method];
  const lifeBased = isLifeBased(draft.method);
  const year = fiscalYearContaining(draft.acquisitionDate, fiscalYears);
  const problems =
    canEditParameters &&
    cost !== null &&
    cost > 0n &&
    accountCode &&
    isCalendarDate(draft.acquisitionDate)
      ? checkDepreciationChoice({
          method: draft.method,
          cost,
          acquisitionDate: draft.acquisitionDate,
          accountCode,
          usefulLifeYears:
            draft.usefulLifeYears.trim() === "" ? null : Number(draft.usefulLifeYears),
        })
      : [];
  const notes =
    canEditParameters && cost !== null && accountCode
      ? depreciationWarnings({
          method: draft.method,
          cost,
          accountCode,
          fiscalYear: year ? { no: year.no, endDate: year.endDate } : null,
        })
      : [];
  const problem = (field: "method" | "usefulLifeYears" | "cost") =>
    problems.find((item) => item.field === field)?.message ?? null;
  const closedNote = canEditParameters ? closedYearNote(draft.acquisitionDate, fiscalYears) : null;

  function change(patch: Partial<EditDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function openSheet() {
    setDraft(initial());
    setError(null);
    setOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Every field goes back; the parameters unchanged when they are locked.
    const values = canEditParameters
      ? { ...draft, usefulLifeYears: lifeBased ? draft.usefulLifeYears : "" }
      : { ...initial(), name: draft.name, segmentId: draft.segmentId, note: draft.note };
    startTransition(async () => {
      const result = await updateFixedAssetAction(asset.id, values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(`${result.data.name}を保存しました`);
      router.refresh();
    });
  }

  const fieldError = (field: keyof EditDraft) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => EDIT_FIELDS.has(field));
  const formId = `${id}-form`;
  const locked = !canEditParameters;

  return (
    <>
      <Button size="sm" onClick={openSheet}>
        編集
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="固定資産の編集"
        description={asset.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" form={formId} variant="primary" disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Alerts messages={alerts} />
          <FormField label="名称" htmlFor={`${id}-name`} required error={fieldError("name")}>
            <Input
              id={`${id}-name`}
              value={draft.name}
              maxLength={100}
              onChange={(event) => change({ name: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="セグメント" htmlFor={`${id}-segment`} error={fieldError("segmentId")}>
            <Select
              id={`${id}-segment`}
              value={draft.segmentId}
              onChange={(event) => change({ segmentId: event.currentTarget.value })}
            >
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="メモ" htmlFor={`${id}-note`} error={fieldError("note")}>
            <Textarea
              id={`${id}-note`}
              value={draft.note}
              maxLength={500}
              onChange={(event) => change({ note: event.currentTarget.value })}
            />
          </FormField>
          <fieldset className="flex min-w-0 flex-col gap-4 border-t border-border pt-4">
            <legend className="sr-only">取得と償却</legend>
            {locked && editBlockedReason ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">{editBlockedReason}</p>
            ) : null}
            <FormField
              label="科目"
              htmlFor={`${id}-account`}
              required
              error={fieldError("accountId")}
            >
              <Select
                id={`${id}-account`}
                value={draft.accountId}
                disabled={locked}
                onChange={(event) => change({ accountId: event.currentTarget.value })}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="取得日"
              htmlFor={`${id}-date`}
              required
              error={fieldError("acquisitionDate")}
              help={closedNote ? <Warn>{closedNote}</Warn> : undefined}
            >
              <Input
                id={`${id}-date`}
                type="date"
                value={draft.acquisitionDate}
                disabled={locked}
                onChange={(event) => change({ acquisitionDate: event.currentTarget.value })}
              />
            </FormField>
            <FormField
              label="取得価額（円）"
              htmlFor={`${id}-cost`}
              required
              error={fieldError("cost")}
              help={problem("cost") ? <Warn>{problem("cost")}</Warn> : undefined}
            >
              <MoneyInput
                id={`${id}-cost`}
                value={draft.cost}
                disabled={locked}
                onValueChange={(value) => change({ cost: value })}
              />
            </FormField>
            <FormField
              label="償却方法"
              htmlFor={`${id}-method`}
              required
              error={fieldError("method")}
              help={
                problem("method") || notes.length > 0 ? (
                  <>
                    {problem("method") ? <Warn>{problem("method")}</Warn> : null}
                    {notes.map((note) => (
                      <span key={note.code} className="block">
                        {note.message}
                      </span>
                    ))}
                  </>
                ) : undefined
              }
            >
              <Select
                id={`${id}-method`}
                value={draft.method}
                disabled={locked}
                onChange={(event) =>
                  change({ method: event.currentTarget.value as DepreciationMethod })
                }
              >
                {(allowed.includes(draft.method) ? allowed : [draft.method, ...allowed]).map(
                  (method) => (
                    <option key={method} value={method}>
                      {methodLabel(method, cost)}
                    </option>
                  ),
                )}
              </Select>
            </FormField>
            <FormField
              label="耐用年数（年）"
              htmlFor={`${id}-life`}
              required={lifeBased}
              error={fieldError("usefulLifeYears")}
              help={
                problem("usefulLifeYears") && draft.usefulLifeYears.trim() ? (
                  <Warn>{problem("usefulLifeYears")}</Warn>
                ) : lifeBased ? (
                  "2〜50 年"
                ) : (
                  "定額法・定率法のときに入れます"
                )
              }
            >
              <Input
                id={`${id}-life`}
                type="number"
                inputMode="numeric"
                min={2}
                max={50}
                step={1}
                value={lifeBased ? draft.usefulLifeYears : ""}
                disabled={locked || !lifeBased}
                onChange={(event) => change({ usefulLifeYears: event.currentTarget.value })}
              />
            </FormField>
            {locked ? null : <UsefulLifeHints />}
          </fieldset>
        </form>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// 除却・売却 (§5.3)
// ---------------------------------------------------------------------------

/**
 * 除却・売却 (16 §5.3): 日付・売却額 (empty = 除却)・入金先の口座 (a sale)・摘要, then a confirmation with
 * the book value and the resulting gain or loss (the server computes the entry).
 */
export function DisposeAssetSheet({
  assetId,
  name,
  method,
  bookValue,
  wallets,
  fiscalYears,
  taxRules,
  today,
}: {
  assetId: string;
  name: string;
  method: DepreciationMethod;
  /** 帳簿価額 (cost − the depreciation posted; 0 for 一括償却), as digits. */
  bookValue: string;
  wallets: readonly { id: string; label: string }[];
  fiscalYears: readonly EntryFormFiscalYear[];
  taxRules: EntryFormOptions["taxRules"];
  today: CalendarDate;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const initial = () => ({
    date: today as string,
    proceeds: "",
    walletId: wallets[0]?.id ?? "",
    description: "",
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const book = BigInt(bookValue);
  const proceeds = parseYenInput(draft.proceeds) ?? 0n;
  const selling = proceeds > 0n;
  const year = fiscalYearContaining(draft.date, fiscalYears);
  // The sale amount without the tax in tax-exclusive years (the ledger's split of 課税売上 10%).
  const saleAmount: Money = (() => {
    if (!selling || !isCalendarDate(draft.date)) return proceeds;
    try {
      return splitTaxInclusive(proceeds, "sales_10", draft.date, {
        accountingMethod: year?.accountingMethod ?? "tax_inclusive",
        taxRules,
      }).amount;
    } catch {
      return proceeds;
    }
  })();
  const dateNote = disposalDateProblem(draft.date, fiscalYears);
  // Normal entries are frozen in a year in its adjustments: its dates are refused (16 §1).
  const closingYear = fiscalYears.find((candidate) => candidate.status === "closing");
  const verb = selling ? "売却する" : "除却する";

  function change(patch: Partial<ReturnType<typeof initial>>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function openSheet() {
    setDraft(initial());
    setError(null);
    setConfirming(false);
    setOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setConfirming(true);
  }

  function dispose() {
    startTransition(async () => {
      const result = await disposeFixedAssetAction(assetId, {
        date: draft.date,
        proceeds: draft.proceeds,
        walletId: selling ? draft.walletId : "",
        description: draft.description,
      });
      if (!result.ok) {
        setError(result);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      setOpen(false);
      setError(null);
      const done = selling ? "売却しました" : "除却しました";
      toast(
        result.data.entryNo !== null
          ? `${name}を${done}（${entryNo(result.data.entryNo)}）`
          : `${name}を${done}`,
      );
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) =>
    ["date", "proceeds", "walletId", "description"].includes(field),
  );
  const formId = `${id}-form`;
  const gain = saleAmount - book;

  return (
    <>
      <Button size="sm" onClick={openSheet}>
        除却・売却
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="除却・売却"
        description={name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" form={formId} variant="primary" disabled={pending}>
              {verb}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Alerts messages={alerts} />
          <FormField
            label="日付"
            htmlFor={`${id}-date`}
            required
            error={fieldError("date")}
            help={
              dateNote ? (
                <Warn>{dateNote}</Warn>
              ) : (
                `進行中の期の、締めていない日付です。当期の償却はしません${
                  closingYear
                    ? `。第 ${closingYear.no} 期は決算整理中のため、その期の日付では登録できません`
                    : ""
                }`
              )
            }
          >
            <Input
              id={`${id}-date`}
              type="date"
              value={draft.date}
              onChange={(event) => change({ date: event.currentTarget.value })}
            />
          </FormField>
          <FormField
            label="売却額（税込・円）"
            htmlFor={`${id}-proceeds`}
            error={fieldError("proceeds")}
            help="空か 0 なら除却です"
          >
            <MoneyInput
              id={`${id}-proceeds`}
              value={draft.proceeds}
              onValueChange={(value) => change({ proceeds: value })}
            />
          </FormField>
          {selling ? (
            <FormField
              label="入金先の口座"
              htmlFor={`${id}-wallet`}
              required
              error={fieldError("walletId")}
            >
              <Select
                id={`${id}-wallet`}
                value={draft.walletId}
                onChange={(event) => change({ walletId: event.currentTarget.value })}
              >
                {draft.walletId === "" ? <option value="">選んでください</option> : null}
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <FormField
            label="摘要"
            htmlFor={`${id}-description`}
            error={fieldError("description")}
            help={`空なら「${selling ? "売却" : "除却"} ${name}」にします`}
          >
            <Input
              id={`${id}-description`}
              value={draft.description}
              maxLength={200}
              onChange={(event) => change({ description: event.currentTarget.value })}
            />
          </FormField>
          {method === "lump_sum_3y" ? (
            <p className="text-[12px] text-muted">
              一括償却（3 年）の資産は、除却・売却の後も 3
              年の償却を続けます（資産の科目は外しません）。
            </p>
          ) : null}
        </form>
        <ConfirmDialog
          open={confirming}
          title={selling ? `${name}を売却します` : `${name}を除却します`}
          confirmLabel={verb}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={dispose}
        >
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            <dt className="text-muted">帳簿価額（円）</dt>
            <dd className="num text-right">{formatYen(book)}</dd>
            {selling ? (
              <>
                <dt className="text-muted">
                  売却額{saleAmount !== proceeds ? "（税抜）" : ""}（円）
                </dt>
                <dd className="num text-right">{formatYen(saleAmount)}</dd>
                <dt className="text-muted">
                  {gain >= 0n ? "売却益（雑収入）" : "売却損（雑損失）"}（円）
                </dt>
                <dd className="num text-right font-bold">{formatYen(gain >= 0n ? gain : -gain)}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">除却損（雑損失）（円）</dt>
                <dd className="num text-right font-bold">{formatYen(book)}</dd>
              </>
            )}
          </dl>
          <p className="mt-3 text-[13px] text-muted">
            {displayDateText(draft.date)} 付の仕訳を登録し、台帳を
            {selling ? "売却済み" : "除却済み"}
            にします。取り消すときは取引の画面で仕訳を取り消します。
          </p>
        </ConfirmDialog>
      </Sheet>
    </>
  );
}

function displayDateText(date: string): string {
  return date.replaceAll("-", "/");
}

// ---------------------------------------------------------------------------
// 登録を取り消す (§5.2)
// ---------------------------------------------------------------------------

export function VoidAssetButton({ assetId, name }: { assetId: string; name: string }) {
  return (
    <ReasonAction
      label="登録を取り消す"
      triggerVariant="ghost"
      triggerClassName="text-danger! hover:text-danger!"
      title={`${name}の登録を取り消します`}
      confirmLabel="登録を取り消す"
      variant="danger"
      reasonRequired
      run={(reason) => voidFixedAssetAction(assetId, { reason })}
      doneMessage={(data) => `${data.name}の登録を取り消しました`}
    >
      <p>台帳から外します（取消として残ります）。取得の仕訳はそのまま残ります。</p>
      <p className="mt-2 text-[13px] text-muted">
        仕訳も要らなければ、取引の画面で取得の仕訳を取り消してください。
      </p>
    </ReasonAction>
  );
}
