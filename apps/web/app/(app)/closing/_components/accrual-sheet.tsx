"use client";

import {
  ACCRUAL_PL_ACCOUNT_KINDS,
  ACCRUAL_TYPE_LABELS,
  ACCRUAL_TYPES,
  type AccrualType,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { postAccrualAction } from "../actions";

export interface AccrualAccountOption {
  id: string;
  label: string;
  kind: "expense" | "revenue";
  defaultSegmentId: string | null;
}

interface Draft {
  type: AccrualType;
  plAccountId: string;
  amount: string;
  segmentId: string;
  description: string;
  reverse: boolean;
}

const FIELDS = new Set(["type", "plAccountId", "amount", "segmentId", "description", "reverse"]);

/** What each kind books (16 §7), shown under 種類. */
const TYPE_HELP: Readonly<Record<AccrualType, string>> = {
  prepaid_expense: "翌期分の費用を当期に払ったとき。借方 前払費用 / 貸方 費用の科目",
  accrued_expense: "当期分の費用の請求が翌期に来るとき。借方 費用の科目 / 貸方 未払費用",
  deferred_revenue: "翌期分の会費などを当期に受け取ったとき。借方 収益の科目 / 貸方 前受金",
  supplies: "期末に残った切手・消耗品。借方 貯蔵品 / 貸方 費用の科目",
};

/**
 * 「登録」 of 前払・未払 (16 §7): a Sheet 「決算整理仕訳の登録」 with 種類・科目・金額・セグメント・摘要・翌期首に
 * 振り戻す (on by default when the next year can take it).
 */
export function AccrualSheet({
  fiscalYearId,
  endDate,
  accounts,
  segments,
  corporateSegmentId,
  reversalAvailable,
  reversalBlockedReason,
  nextStartDate,
  hasSupplies,
}: {
  fiscalYearId: string;
  /** Formatted. */
  endDate: string;
  accounts: readonly AccrualAccountOption[];
  segments: readonly { id: string; name: string }[];
  corporateSegmentId: string | null;
  reversalAvailable: boolean;
  reversalBlockedReason: string | null;
  /** The next year's first day, formatted, when the reversal can be posted. */
  nextStartDate: string | null;
  hasSupplies: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const initial = (): Draft => ({
    type: "prepaid_expense",
    plAccountId: "",
    amount: "",
    segmentId: corporateSegmentId ?? "",
    description: ACCRUAL_TYPE_LABELS.prepaid_expense,
    reverse: reversalAvailable,
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [segmentEdited, setSegmentEdited] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const choices = accounts.filter(
    (account) => account.kind === ACCRUAL_PL_ACCOUNT_KINDS[draft.type],
  );
  const suppliesMissing = draft.type === "supplies" && !hasSupplies;

  function openSheet() {
    setDraft(initial());
    setSegmentEdited(false);
    setError(null);
    setOpen(true);
  }

  function changeType(type: AccrualType) {
    const kindChanged = ACCRUAL_PL_ACCOUNT_KINDS[type] !== ACCRUAL_PL_ACCOUNT_KINDS[draft.type];
    // The description follows the kind until it is typed over.
    const untouched =
      draft.description === "" || draft.description === ACCRUAL_TYPE_LABELS[draft.type];
    setDraft({
      ...draft,
      type,
      plAccountId: kindChanged ? "" : draft.plAccountId,
      description: untouched ? ACCRUAL_TYPE_LABELS[type] : draft.description,
    });
  }

  function changeAccount(plAccountId: string) {
    const account = accounts.find((candidate) => candidate.id === plAccountId);
    setDraft({
      ...draft,
      plAccountId,
      segmentId: segmentEdited
        ? draft.segmentId
        : (account?.defaultSegmentId ?? corporateSegmentId ?? draft.segmentId),
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await postAccrualAction(fiscalYearId, {
        ...draft,
        // An unchecked box is sent explicitly (a missing key means 振り戻す).
        reverse: reversalAvailable && draft.reverse,
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(
        result.data.reversalNo !== null
          ? `${entryNo(result.data.no)} を登録しました（振り戻し ${entryNo(result.data.reversalNo)}）`
          : `${entryNo(result.data.no)} を登録しました`,
      );
      router.refresh();
    });
  }

  const fieldError = (field: keyof Draft) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const formId = `${id}-form`;

  return (
    <>
      <Button size="sm" onClick={openSheet}>
        登録
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="決算整理仕訳の登録"
        description={`前払・未払・前受・貯蔵品。期末日 ${endDate} 付`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={pending || suppliesMissing}
            >
              {pending ? "登録中…" : "登録"}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
          {alerts.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
            >
              {alerts.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}
          <FormField
            label="種類"
            htmlFor={`${id}-type`}
            required
            error={fieldError("type")}
            help={
              suppliesMissing ? (
                <span className="font-bold text-warn">
                  貯蔵品の科目がありません。設定 › 勘定科目 で 貯蔵品 を足してください（流動資産）
                </span>
              ) : (
                TYPE_HELP[draft.type]
              )
            }
          >
            <Select
              id={`${id}-type`}
              value={draft.type}
              onChange={(event) => changeType(event.currentTarget.value as AccrualType)}
            >
              {ACCRUAL_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACCRUAL_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={ACCRUAL_PL_ACCOUNT_KINDS[draft.type] === "revenue" ? "収益の科目" : "費用の科目"}
            htmlFor={`${id}-account`}
            required
            error={fieldError("plAccountId")}
          >
            <Select
              id={`${id}-account`}
              value={draft.plAccountId}
              onChange={(event) => changeAccount(event.currentTarget.value)}
            >
              <option value="">選んでください</option>
              {choices.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="金額（円）"
            htmlFor={`${id}-amount`}
            required
            error={fieldError("amount")}
          >
            <MoneyInput
              id={`${id}-amount`}
              value={draft.amount}
              onValueChange={(amount) => setDraft({ ...draft, amount })}
            />
          </FormField>
          <FormField
            label="セグメント"
            htmlFor={`${id}-segment`}
            error={fieldError("segmentId")}
            help="既定は科目のセグメント、なければ共通"
          >
            <Select
              id={`${id}-segment`}
              value={draft.segmentId}
              onChange={(event) => {
                setSegmentEdited(true);
                setDraft({ ...draft, segmentId: event.currentTarget.value });
              }}
            >
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="摘要" htmlFor={`${id}-description`} error={fieldError("description")}>
            <Input
              id={`${id}-description`}
              value={draft.description}
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
            />
          </FormField>
          <div className="flex flex-col gap-1">
            <Checkbox
              id={`${id}-reverse`}
              label="翌期首に振り戻す"
              checked={reversalAvailable && draft.reverse}
              disabled={!reversalAvailable}
              aria-describedby={`${id}-reverse-help`}
              onChange={(event) => setDraft({ ...draft, reverse: event.currentTarget.checked })}
            />
            <p id={`${id}-reverse-help`} className="text-[12px] text-muted">
              {reversalAvailable
                ? `貸借を入れ替えた仕訳を翌期の開始日${nextStartDate ? `（${nextStartDate}）` : ""}付で一緒に登録します`
                : reversalBlockedReason}
            </p>
            {fieldError("reverse") ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {fieldError("reverse")}
              </p>
            ) : null}
          </div>
          <p className="text-[12px] text-muted">
            税区分はどちらの行も対象外です（消費税は元の取引の仕訳で扱います）。
          </p>
        </form>
      </Sheet>
    </>
  );
}
