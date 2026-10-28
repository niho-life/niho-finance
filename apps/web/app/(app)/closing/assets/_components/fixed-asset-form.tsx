"use client";

import type { EntryFormOptions } from "@niho-finance/db";
import {
  allowedDepreciationMethods,
  checkDepreciationChoice,
  CORPORATE_SEGMENT_CODE,
  DEPRECIATION_METHODS,
  depreciationWarnings,
  getTaxCategory,
  isCalendarDate,
  isReservedAccount,
  parseYenInput,
  splitTaxInclusive,
  suggestDepreciationMethod,
  walletAccountIdsOf,
  type DepreciationMethod,
  type DepreciationProblem,
  type Money,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { walletLabel } from "@/lib/format";
import {
  accountLabel,
  DateField,
  FormAlerts,
  TaxCategoryOptions,
} from "../../../entries/_components/form-kit";
import { registerFixedAssetAction } from "../../actions";
import {
  closedYearNote,
  depreciableAccounts,
  fiscalYearContaining,
  isLifeBased,
  methodLabel,
  UsefulLifeHints,
} from "./asset-kit";

export type AssetSource = "entry" | "purchase";

/** A candidate debit line (§5.1), as the page passes it (amounts as text). */
export interface CandidateView {
  key: string;
  entryId: string;
  accountId: string;
  accountCode: string;
  accountLabel: string;
  entryDate: string;
  description: string;
  /** 「yyyy/mm/dd · No. n · 摘要 · 科目 · 金額円」 */
  label: string;
  /** The amount not registered yet, as the input shows it and as text. */
  remainingInput: string;
  remainingText: string;
}

interface Draft {
  candidate: string;
  cost: string;
  counterpart: string;
  entryDate: string;
  amount: string;
  taxCategoryCode: string;
  accountId: string;
  name: string;
  method: DepreciationMethod | "";
  usefulLifeYears: string;
  segmentId: string;
  note: string;
}

const COMMON_FIELDS = ["name", "method", "usefulLifeYears", "segmentId", "note"];
const SOURCE_FIELDS: Readonly<Record<AssetSource, readonly string[]>> = {
  entry: ["entryId", "accountId", "cost"],
  purchase: ["counterpart", "entryDate", "amount", "taxCategoryCode", "accountId"],
};

function fitsPurchase(code: string | null | undefined): code is string {
  if (!code) return false;
  const category = getTaxCategory(code);
  return Boolean(category && (category.direction === "purchase" || category.direction === "none"));
}

function problemText(
  problems: readonly DepreciationProblem[],
  field: DepreciationProblem["field"],
) {
  return problems.find((problem) => problem.field === field)?.message ?? null;
}

/** 決算中の期は通常の仕訳（支出）を受け付けない (16 §1). */
function purchaseClosingNote(no: number): string {
  return `第 ${no} 期は決算整理中のため、支出の仕訳は登録できません。「取得の仕訳から」で登録するか、決算整理をやめてから登録してください`;
}

function Warn({ children }: { children: ReactNode }) {
  return <span className="block font-bold text-warn">{children}</span>;
}

/**
 * 固定資産の登録 (16 §5.1): 取得の仕訳から (a candidate debit line) or 仕訳も一緒に登録 (a 支出 like S3), then
 * 名称・償却方法・耐用年数・セグメント・メモ. The method follows `suggestDepreciationMethod` until it is
 * chosen by hand; the checks and notes show before sending, the server decides.
 */
export function FixedAssetForm({
  source,
  candidates,
  options,
  today,
}: {
  source: AssetSource;
  candidates: readonly CandidateView[];
  options: EntryFormOptions;
  today: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();

  const lookups = useMemo(() => {
    const walletAccountIds = walletAccountIdsOf(options.wallets);
    return {
      candidates: new Map(candidates.map((candidate) => [candidate.key, candidate])),
      accounts: new Map(options.accounts.map((account) => [account.id, account])),
      assetAccounts: depreciableAccounts(options.accounts),
      payFrom: options.accounts.filter(
        (account) =>
          account.isActive &&
          account.kind === "liability" &&
          !isReservedAccount(account, walletAccountIds),
      ),
    };
  }, [candidates, options]);

  const segments = options.segments.filter((segment) => segment.isActive);
  const corporate = segments.find((segment) => segment.code === CORPORATE_SEGMENT_CODE);
  const wallets = options.wallets.filter((wallet) => wallet.isActive);
  const firstCandidate = candidates[0];

  const [draft, setDraft] = useState<Draft>(() => ({
    candidate: firstCandidate?.key ?? "",
    cost: firstCandidate?.remainingInput ?? "",
    counterpart: wallets[0]
      ? `wallet:${wallets[0].id}`
      : lookups.payFrom[0]
        ? `account:${lookups.payFrom[0].id}`
        : "",
    entryDate: today,
    amount: "",
    taxCategoryCode: "purchase_10",
    accountId: "",
    name: firstCandidate?.description.slice(0, 100) ?? "",
    method: "",
    usefulLifeYears: "",
    segmentId: corporate?.id ?? "",
    note: "",
  }));
  const [methodTouched, setMethodTouched] = useState(false);
  const [taxTouched, setTaxTouched] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const candidate = lookups.candidates.get(draft.candidate) ?? null;
  const account =
    source === "entry"
      ? candidate
        ? { code: candidate.accountCode }
        : null
      : (lookups.accounts.get(draft.accountId) ?? null);
  const accountCode = account?.code ?? null;
  const acquisitionDate = source === "entry" ? (candidate?.entryDate ?? "") : draft.entryDate;
  const year = fiscalYearContaining(acquisitionDate, options.fiscalYears);

  // 取得価額: the amount from the entry, or the asset line of the 支出 (without the tax in
  // tax-exclusive years, as the ledger splits it).
  const cost: Money | null = (() => {
    if (source === "entry") return parseYenInput(draft.cost);
    const amount = parseYenInput(draft.amount);
    if (amount === null || amount <= 0n || !isCalendarDate(draft.entryDate)) return amount;
    try {
      return splitTaxInclusive(amount, draft.taxCategoryCode, draft.entryDate, {
        accountingMethod: year?.accountingMethod ?? "tax_inclusive",
        taxRules: options.taxRules,
      }).amount;
    } catch {
      return amount;
    }
  })();

  const suggestion =
    cost !== null && cost > 0n && accountCode && isCalendarDate(acquisitionDate)
      ? suggestDepreciationMethod({ cost, acquisitionDate, accountCode })
      : null;
  const allowed = accountCode ? allowedDepreciationMethods(accountCode) : [...DEPRECIATION_METHODS];
  const picked = methodTouched ? draft.method : (suggestion ?? "");
  // A method the account does not allow (定率法 after switching to ソフトウェア) is chosen again.
  const method: DepreciationMethod | "" = picked && allowed.includes(picked) ? picked : "";
  const lifeBased = isLifeBased(method);

  const problems =
    method && cost !== null && cost > 0n && accountCode && isCalendarDate(acquisitionDate)
      ? checkDepreciationChoice({
          method,
          cost,
          acquisitionDate,
          accountCode,
          usefulLifeYears:
            draft.usefulLifeYears.trim() === "" ? null : Number(draft.usefulLifeYears),
        })
      : [];
  const notes =
    method && cost !== null && accountCode
      ? depreciationWarnings({
          method,
          cost,
          accountCode,
          fiscalYear: year ? { no: year.no, endDate: year.endDate } : null,
        })
      : [];
  const closedNote = closedYearNote(acquisitionDate, options.fiscalYears);

  function change(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function chooseCandidate(key: string) {
    const next = lookups.candidates.get(key);
    // The name follows the entry's description until it is typed over.
    const nameFollows = draft.name === "" || draft.name === candidate?.description.slice(0, 100);
    change({
      candidate: key,
      cost: next?.remainingInput ?? "",
      name: nameFollows ? (next?.description.slice(0, 100) ?? "") : draft.name,
    });
  }

  function chooseAccount(accountId: string) {
    const code = lookups.accounts.get(accountId)?.defaultTaxCategoryCode;
    change({
      accountId,
      taxCategoryCode: !taxTouched && fitsPurchase(code) ? code : draft.taxCategoryCode,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const common = {
      name: draft.name,
      method,
      usefulLifeYears: lifeBased ? draft.usefulLifeYears : "",
      segmentId: draft.segmentId,
      note: draft.note,
    };
    const values =
      source === "entry"
        ? {
            source,
            entryId: candidate?.entryId ?? "",
            accountId: candidate?.accountId ?? "",
            cost: draft.cost,
            ...common,
          }
        : {
            source,
            counterpart: draft.counterpart,
            entryDate: draft.entryDate,
            amount: draft.amount,
            taxCategoryCode: draft.taxCategoryCode,
            accountId: draft.accountId,
            ...common,
          };
    startTransition(async () => {
      const result = await registerFixedAssetAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(`${result.data.name}を登録しました`);
      router.push(`/closing/assets/${result.data.id}`);
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const shown = new Set([...COMMON_FIELDS, ...SOURCE_FIELDS[source]]);
  const alerts = formLevelErrors(error, (field) => shown.has(field));
  const methodProblem = problemText(problems, "method");
  const lifeProblem = draft.usefulLifeYears.trim()
    ? problemText(problems, "usefulLifeYears")
    : null;
  const costProblem = problemText(problems, "cost");

  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-4">
      <FormAlerts messages={alerts} />
      {source === "entry" ? (
        candidates.length === 0 ? (
          <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
            取得の仕訳の候補がありません。工具器具備品などの固定資産の科目に借方の行があり、まだ台帳に登録していない仕訳が候補になります。「仕訳も一緒に登録」から登録できます。
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label="取得の仕訳"
              htmlFor={`${id}-candidate`}
              required
              className="md:col-span-2"
              error={fieldError("entryId") ?? fieldError("accountId")}
              help={
                candidate ? (
                  <span className="num">
                    取得日 {candidate.entryDate.replaceAll("-", "/")} · 科目{" "}
                    {candidate.accountLabel} · 残りの額 {candidate.remainingText} 円
                  </span>
                ) : undefined
              }
            >
              <Select
                id={`${id}-candidate`}
                value={draft.candidate}
                onChange={(event) => chooseCandidate(event.currentTarget.value)}
              >
                {candidates.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="取得価額（円）"
              htmlFor={`${id}-cost`}
              required
              error={fieldError("cost")}
              help={
                costProblem ? (
                  <Warn>{costProblem}</Warn>
                ) : candidate ? (
                  `1 つの仕訳で 2 つ買ったときは、残りの額 ${candidate.remainingText} 円まで小さくできます`
                ) : undefined
              }
            >
              <MoneyInput
                id={`${id}-cost`}
                value={draft.cost}
                onValueChange={(value) => change({ cost: value })}
              />
            </FormField>
          </div>
        )
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <DateField
            id={`${id}-date`}
            value={draft.entryDate}
            onChange={(entryDate) => change({ entryDate })}
            fiscalYears={options.fiscalYears}
            error={fieldError("entryDate")}
            help={
              year?.status === "closing" ? <Warn>{purchaseClosingNote(year.no)}</Warn> : undefined
            }
          />
          <FormField
            label="支払元"
            htmlFor={`${id}-counterpart`}
            required
            error={fieldError("counterpart")}
          >
            <Select
              id={`${id}-counterpart`}
              value={draft.counterpart}
              onChange={(event) => change({ counterpart: event.currentTarget.value })}
            >
              {draft.counterpart === "" ? <option value="">選んでください</option> : null}
              {wallets.length > 0 ? (
                <optgroup label="口座">
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={`wallet:${wallet.id}`}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="科目">
                {lookups.payFrom.map((option) => (
                  <option key={option.id} value={`account:${option.id}`}>
                    {accountLabel(option)}
                  </option>
                ))}
              </optgroup>
            </Select>
          </FormField>
          <FormField
            label="科目"
            htmlFor={`${id}-account`}
            required
            error={fieldError("accountId")}
          >
            <Select
              id={`${id}-account`}
              value={draft.accountId}
              onChange={(event) => chooseAccount(event.currentTarget.value)}
            >
              <option value="">選んでください</option>
              {lookups.assetAccounts.map((option) => (
                <option key={option.id} value={option.id}>
                  {accountLabel(option)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="金額（税込・円）"
            htmlFor={`${id}-amount`}
            required
            error={fieldError("amount")}
            help={
              costProblem ? (
                <Warn>{costProblem}</Warn>
              ) : year?.accountingMethod === "tax_exclusive" ? (
                "税抜経理の期は、税抜の額が取得価額になります"
              ) : (
                "この額が取得価額になります"
              )
            }
          >
            <MoneyInput
              id={`${id}-amount`}
              value={draft.amount}
              onValueChange={(value) => change({ amount: value })}
            />
          </FormField>
          <FormField
            label="税区分"
            htmlFor={`${id}-tax`}
            required
            error={fieldError("taxCategoryCode")}
          >
            <Select
              id={`${id}-tax`}
              value={draft.taxCategoryCode}
              onChange={(event) => {
                setTaxTouched(true);
                change({ taxCategoryCode: event.currentTarget.value });
              }}
            >
              <TaxCategoryOptions categories={options.taxCategories} first="purchase" />
            </Select>
          </FormField>
        </div>
      )}

      <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
        <FormField
          label="名称"
          htmlFor={`${id}-name`}
          required
          error={fieldError("name")}
          className="md:col-span-2"
        >
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={100}
            onChange={(event) => change({ name: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="償却方法"
          htmlFor={`${id}-method`}
          required
          error={fieldError("method")}
          help={
            methodProblem || notes.length > 0 || closedNote || suggestion ? (
              <>
                {methodProblem ? <Warn>{methodProblem}</Warn> : null}
                {notes.map((note) => (
                  <span key={note.code} className="block">
                    {note.message}
                  </span>
                ))}
                {closedNote ? <Warn>{closedNote}</Warn> : null}
                {!methodTouched && suggestion ? (
                  <span className="block">取得価額と取得日から提案しています（変えられます）</span>
                ) : null}
              </>
            ) : undefined
          }
        >
          <Select
            id={`${id}-method`}
            value={method}
            onChange={(event) => {
              setMethodTouched(true);
              change({ method: event.currentTarget.value as DepreciationMethod | "" });
            }}
          >
            {method === "" ? <option value="">選んでください</option> : null}
            {allowed.map((option) => (
              <option key={option} value={option}>
                {methodLabel(option, cost)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="耐用年数（年）"
          htmlFor={`${id}-life`}
          required={lifeBased}
          error={fieldError("usefulLifeYears")}
          help={
            lifeProblem ? (
              <Warn>{lifeProblem}</Warn>
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
            disabled={!lifeBased}
            onChange={(event) => change({ usefulLifeYears: event.currentTarget.value })}
          />
        </FormField>
        <div className="md:col-span-2">
          <UsefulLifeHints />
        </div>
        <FormField
          label="セグメント"
          htmlFor={`${id}-segment`}
          error={fieldError("segmentId")}
          help="既定は共通"
        >
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
        <FormField
          label="メモ"
          htmlFor={`${id}-note`}
          error={fieldError("note")}
          className="md:col-span-2"
        >
          <Textarea
            id={`${id}-note`}
            value={draft.note}
            maxLength={500}
            onChange={(event) => change({ note: event.currentTarget.value })}
          />
        </FormField>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || (source === "entry" && candidates.length === 0)}
        >
          {pending ? "登録中…" : "登録"}
        </Button>
      </div>
    </form>
  );
}
