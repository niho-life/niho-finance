"use client";

import {
  ACCOUNT_KIND_LABELS,
  formatYen,
  RULE_MODE_LABELS,
  RULE_MODES,
  type AccountKind,
  type RuleMode,
} from "@niho-finance/ledger";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describedBy, FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { FormAlerts, TaxCategoryOptions } from "../../entries/_components/form-kit";
import { accountChoices, taxFits, type Account } from "../../statements/_components/model";
import {
  applyRuleAction,
  countRuleMatchesAction,
  createRuleAction,
  setRuleActiveAction,
  updateRuleAction,
  type AppliedRule,
  type RuleMatchTotals,
  type SavedRule,
} from "./actions";
import type { ClientRule, RuleFormValues, RuleSheetOptions } from "./rule-values";

/** The fields of the form, as the repository names them in its errors. */
const FIELD_PATHS: Readonly<Record<string, string>> = {
  name: "name",
  walletId: "walletId",
  descriptionContains: "match.descriptionContains",
  descriptionRegex: "match.descriptionRegex",
  counterpartyContains: "match.counterpartyContains",
  amountMin: "match.amountMin",
  amountMax: "match.amountMax",
  sign: "match.sign",
  mode: "action.mode",
  accountId: "action.accountId",
  taxCategoryCode: "action.taxCategoryCode",
  partnerId: "action.partnerId",
  segmentId: "action.segmentId",
  descriptionTemplate: "action.descriptionTemplate",
  transferToWalletId: "action.transferToWalletId",
  ignoredReason: "action.ignoredReason",
  autoPost: "autoPost",
  priority: "priority",
};

const SIGN_CHOICES = [
  { value: "", label: "どちらも" },
  { value: "in", label: "入金" },
  { value: "out", label: "出金" },
] as const;

/** 科目 of a rule: the accounts its sign can take (both signs: 費用・収益 first). */
function accountGroups(
  sign: RuleFormValues["sign"],
  options: RuleSheetOptions,
): { kind: AccountKind; accounts: Account[] }[] {
  if (sign) return accountChoices(sign, options);
  const order: AccountKind[] = ["expense", "revenue", "asset", "liability", "equity"];
  const byKind = new Map<AccountKind, Map<string, Account>>();
  for (const direction of ["out", "in"] as const) {
    for (const group of accountChoices(direction, options)) {
      const map = byKind.get(group.kind) ?? new Map<string, Account>();
      for (const account of group.accounts) map.set(account.id, account);
      byKind.set(group.kind, map);
    }
  }
  return order.flatMap((kind) => {
    const accounts = [...(byKind.get(kind)?.values() ?? [])].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    return accounts.length > 0 ? [{ kind, accounts }] : [];
  });
}

function payload(values: RuleFormValues) {
  return {
    name: values.name,
    walletId: values.walletId,
    match: {
      descriptionContains: values.descriptionContains,
      descriptionRegex: values.descriptionRegex,
      counterpartyContains: values.counterpartyContains,
      amountMin: values.amountMin,
      amountMax: values.amountMax,
      sign: values.sign,
    },
    action: {
      mode: values.mode,
      accountId: values.accountId,
      taxCategoryCode: values.taxCategoryCode,
      partnerId: values.partnerId,
      segmentId: values.segmentId,
      descriptionTemplate: values.descriptionTemplate,
      transferToWalletId: values.transferToWalletId,
      ignoredReason: values.ignoredReason,
    },
    autoPost: values.mode === "suggest" ? false : values.autoPost,
    priority: values.priority,
  };
}

/** 「3 件を登録、1 件は失敗（…）」 after a rule was applied (15 §10). */
export function appliedMessage(result: AppliedRule): string {
  const parts = [
    result.registered > 0 ? `${result.registered} 件を登録` : null,
    result.transferred > 0 ? `${result.transferred} 件を振替` : null,
    result.ignored > 0 ? `${result.ignored} 件を無視` : null,
  ].filter(Boolean);
  const done = parts.join("、");
  const [first] = result.failed;
  if (first) {
    return `${done || "0 件を登録"}、${result.failed.length} 件は失敗（${first.message}）`;
  }
  return done ? `${done}しました` : "一致する未処理の明細はありませんでした";
}

/**
 * ルールの Sheet (15 §10): 追加・編集, and 「ルールにする」 on /statements with the values of a row.
 * 「いま一致する未処理 n 件」 is counted again 300ms after the conditions change. With 取込時に自動で
 * 登録, 「保存して n 件に適用」 also settles the matching pending lines after a confirmation.
 */
export function RuleSheet({
  rule,
  initial,
  options,
  onClose,
  onSaved,
}: {
  /** The rule being edited; `null` for a new one. */
  rule: ClientRule | null;
  /** The values a new rule starts from (「ルールにする」). */
  initial: RuleFormValues;
  options: RuleSheetOptions;
  onClose: () => void;
  onSaved?: (rule: SavedRule) => void;
}) {
  const id = useId();
  const toast = useToast();
  const [values, setValues] = useState<RuleFormValues>(rule?.values ?? initial);
  const [taxTouched, setTaxTouched] = useState(Boolean(rule));
  const [error, setError] = useState<ActionError | null>(null);
  const [totals, setTotals] = useState<RuleMatchTotals | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const matchKey = JSON.stringify([
    values.walletId,
    values.descriptionContains,
    values.descriptionRegex,
    values.counterpartyContains,
    values.amountMin,
    values.amountMax,
    values.sign,
  ]);

  useEffect(() => {
    let live = true;
    const [
      walletId,
      descriptionContains,
      descriptionRegex,
      counterpartyContains,
      amountMin,
      amountMax,
      sign,
    ] = JSON.parse(matchKey) as string[];
    const timer = setTimeout(() => {
      void countRuleMatchesAction({
        walletId: walletId ?? "",
        match: {
          descriptionContains,
          descriptionRegex,
          counterpartyContains,
          amountMin,
          amountMax,
          sign,
        },
      }).then((result) => {
        if (live) setTotals(result.ok ? result.data : null);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [matchKey]);

  function set<K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function changeAccount(accountId: string) {
    const account = options.accounts.find((item) => item.id === accountId);
    const code = account?.defaultTaxCategoryCode;
    const fits = values.sign ? taxFits(code, values.sign) : Boolean(code);
    setValues((current) => ({
      ...current,
      accountId,
      taxCategoryCode: !taxTouched && fits && code ? code : current.taxCategoryCode,
      segmentId: current.segmentId || account?.defaultSegmentId || "",
    }));
  }

  const fieldError = (key: keyof RuleFormValues) => error?.fieldErrors[FIELD_PATHS[key] ?? key];
  const shownPaths = new Set(Object.values(FIELD_PATHS));
  const alerts = formLevelErrors(error, (field) => shownPaths.has(field));
  const control = (key: keyof RuleFormValues, help?: boolean) =>
    describedBy(`${id}-${key}`, { help, error: fieldError(key) });

  async function save(): Promise<SavedRule | null> {
    const result = rule
      ? await updateRuleAction(rule.id, payload(values))
      : await createRuleAction(payload(values));
    if (!result.ok) {
      setError(result);
      return null;
    }
    setError(null);
    onSaved?.(result.data);
    return result.data;
  }

  function submit() {
    startTransition(async () => {
      const saved = await save();
      if (!saved) return;
      toast(rule ? "ルールを保存しました" : "ルールを追加しました");
      onClose();
    });
  }

  function saveAndApply() {
    startTransition(async () => {
      const saved = await save();
      setConfirming(false);
      if (!saved) return;
      const applied = await applyRuleAction(saved.id);
      if (applied.ok) toast(appliedMessage(applied.data));
      else
        toast(`ルールは保存しました。適用できませんでした（${applied.error}）`, { tone: "error" });
      onClose();
    });
  }

  function toggleActive() {
    if (!rule) return;
    startTransition(async () => {
      const result = await setRuleActiveAction(rule.id, !rule.isActive);
      if (!result.ok) {
        setError(result);
        return;
      }
      toast(rule.isActive ? "ルールを無効にしました" : "ルールを有効にしました");
      onClose();
    });
  }

  const formId = `${id}-form`;
  const registers = values.mode === "register" || values.mode === "suggest";
  const canAutoPost = values.mode !== "suggest";
  const count = totals?.count ?? null;
  const wallets = options.wallets.filter(
    (wallet) => wallet.isActive || wallet.id === values.walletId,
  );
  const targets = options.wallets.filter(
    (wallet) =>
      (wallet.isActive && wallet.id !== values.walletId) || wallet.id === values.transferToWalletId,
  );
  const groups = accountGroups(values.sign, options);

  return (
    <Sheet
      open
      onClose={onClose}
      title={rule ? rule.displayName : "ルールを追加"}
      description={
        rule
          ? rule.isActive
            ? "条件に一致する明細の推定と自動登録に使います"
            : "無効なルールは一致させません"
          : "一致した明細のチップを埋め、自動登録をオンにすると取込時に片付けます"
      }
      footer={
        <>
          {rule ? (
            <Button variant="ghost" className="mr-auto" onClick={toggleActive} disabled={pending}>
              {rule.isActive ? "無効にする" : "有効にする"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          {canAutoPost && values.autoPost && count ? (
            <Button variant="secondary" onClick={() => setConfirming(true)} disabled={pending}>
              保存して {count} 件に適用
            </Button>
          ) : null}
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormAlerts messages={alerts} />
        <FormField
          label="名前"
          htmlFor={`${id}-name`}
          help="空なら条件の要約を名前にします"
          error={fieldError("name")}
        >
          <Input
            id={`${id}-name`}
            value={values.name}
            maxLength={50}
            onChange={(event) => set("name", event.currentTarget.value)}
            {...control("name", true)}
          />
        </FormField>
        <FormField label="口座" htmlFor={`${id}-walletId`} error={fieldError("walletId")}>
          <Select
            id={`${id}-walletId`}
            value={values.walletId}
            onChange={(event) => set("walletId", event.currentTarget.value)}
            {...control("walletId")}
          >
            <option value="">すべての口座</option>
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.isActive ? wallet.name : `${wallet.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>

        <fieldset className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
          <legend className="pr-2 text-[13px] font-extrabold">
            条件（1 つ以上・すべてに一致）
          </legend>
          <FormField
            label="摘要に含む"
            htmlFor={`${id}-descriptionContains`}
            help="大文字小文字・全角半角・空白の違いは無視します"
            error={fieldError("descriptionContains")}
          >
            <Input
              id={`${id}-descriptionContains`}
              value={values.descriptionContains}
              maxLength={100}
              onChange={(event) => set("descriptionContains", event.currentTarget.value)}
              {...control("descriptionContains", true)}
            />
          </FormField>
          <FormField
            label="摘要の正規表現"
            htmlFor={`${id}-descriptionRegex`}
            error={fieldError("descriptionRegex")}
          >
            <Input
              id={`${id}-descriptionRegex`}
              value={values.descriptionRegex}
              maxLength={200}
              spellCheck={false}
              onChange={(event) => set("descriptionRegex", event.currentTarget.value)}
              {...control("descriptionRegex")}
            />
          </FormField>
          <FormField
            label="振込人に含む"
            htmlFor={`${id}-counterpartyContains`}
            error={fieldError("counterpartyContains")}
          >
            <Input
              id={`${id}-counterpartyContains`}
              value={values.counterpartyContains}
              maxLength={100}
              onChange={(event) => set("counterpartyContains", event.currentTarget.value)}
              {...control("counterpartyContains")}
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="金額の下限（円）"
              htmlFor={`${id}-amountMin`}
              error={fieldError("amountMin")}
            >
              <MoneyInput
                id={`${id}-amountMin`}
                value={values.amountMin}
                onValueChange={(text) => set("amountMin", text)}
                {...control("amountMin")}
              />
            </FormField>
            <FormField
              label="金額の上限（円）"
              htmlFor={`${id}-amountMax`}
              error={fieldError("amountMax")}
            >
              <MoneyInput
                id={`${id}-amountMax`}
                value={values.amountMax}
                onValueChange={(text) => set("amountMax", text)}
                {...control("amountMax")}
              />
            </FormField>
          </div>
          <FormField label="符号" htmlFor={`${id}-sign`} error={fieldError("sign")}>
            <Select
              id={`${id}-sign`}
              value={values.sign}
              onChange={(event) => set("sign", event.currentTarget.value as RuleFormValues["sign"])}
              {...control("sign")}
            >
              {SIGN_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </FormField>
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
          <legend className="pr-2 text-[13px] font-extrabold">動作</legend>
          <div role="radiogroup" aria-label="動作" className="flex flex-wrap gap-1.5">
            {RULE_MODES.map((mode: RuleMode) => (
              <label
                key={mode}
                className={`inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] font-bold ${
                  values.mode === mode ? "border-text text-text" : "border-border text-muted"
                }`}
              >
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={mode}
                  checked={values.mode === mode}
                  onChange={() => set("mode", mode)}
                  className="size-3.5 accent-[var(--primary)]"
                />
                {RULE_MODE_LABELS[mode]}
              </label>
            ))}
          </div>
          {fieldError("mode") ? (
            <p role="alert" className="text-[12px] font-bold text-danger">
              {fieldError("mode")}
            </p>
          ) : null}
          {registers ? (
            <>
              <p className="text-[12px] text-muted-2">
                {values.mode === "register"
                  ? "一致した明細を、この科目と税区分で登録します"
                  : "一致した明細のチップを埋めるだけです（登録は明細の画面で）"}
              </p>
              <FormField
                label="科目"
                htmlFor={`${id}-accountId`}
                required={values.mode === "register"}
                error={fieldError("accountId")}
              >
                <Select
                  id={`${id}-accountId`}
                  value={values.accountId}
                  onChange={(event) => changeAccount(event.currentTarget.value)}
                  {...control("accountId")}
                >
                  <option value="">選んでください</option>
                  {groups.map((group) => (
                    <optgroup key={group.kind} label={ACCOUNT_KIND_LABELS[group.kind]}>
                      {group.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} {account.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="税区分"
                htmlFor={`${id}-taxCategoryCode`}
                required={values.mode === "register"}
                error={fieldError("taxCategoryCode")}
              >
                <Select
                  id={`${id}-taxCategoryCode`}
                  value={values.taxCategoryCode}
                  onChange={(event) => {
                    setTaxTouched(true);
                    set("taxCategoryCode", event.currentTarget.value);
                  }}
                  {...control("taxCategoryCode")}
                >
                  <option value="">選んでください</option>
                  <TaxCategoryOptions
                    categories={options.taxCategories}
                    first={values.sign === "in" ? "sales" : "purchase"}
                  />
                </Select>
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  label="取引先"
                  htmlFor={`${id}-partnerId`}
                  error={fieldError("partnerId")}
                >
                  <Select
                    id={`${id}-partnerId`}
                    value={values.partnerId}
                    onChange={(event) => set("partnerId", event.currentTarget.value)}
                    {...control("partnerId")}
                  >
                    <option value="">なし</option>
                    {options.partners.map((partner) => (
                      <option key={partner.id} value={partner.id}>
                        {partner.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label="セグメント"
                  htmlFor={`${id}-segmentId`}
                  error={fieldError("segmentId")}
                >
                  <Select
                    id={`${id}-segmentId`}
                    value={values.segmentId}
                    onChange={(event) => set("segmentId", event.currentTarget.value)}
                    {...control("segmentId")}
                  >
                    <option value="">なし</option>
                    {options.segments.map((segment) => (
                      <option key={segment.id} value={segment.id}>
                        {segment.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <FormField
                label="摘要の雛形"
                htmlFor={`${id}-descriptionTemplate`}
                help="空なら明細の摘要のまま登録します"
                error={fieldError("descriptionTemplate")}
              >
                <Input
                  id={`${id}-descriptionTemplate`}
                  value={values.descriptionTemplate}
                  maxLength={200}
                  onChange={(event) => set("descriptionTemplate", event.currentTarget.value)}
                  {...control("descriptionTemplate", true)}
                />
              </FormField>
            </>
          ) : null}
          {values.mode === "transfer" ? (
            <FormField
              label="相手口座"
              htmlFor={`${id}-transferToWalletId`}
              required
              help="相手口座に同額の明細があれば結び、なければ相手口座だけで登録します"
              error={fieldError("transferToWalletId")}
            >
              <Select
                id={`${id}-transferToWalletId`}
                value={values.transferToWalletId}
                onChange={(event) => set("transferToWalletId", event.currentTarget.value)}
                {...control("transferToWalletId", true)}
              >
                <option value="">選んでください</option>
                {targets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          {values.mode === "ignore" ? (
            <FormField
              label="理由"
              htmlFor={`${id}-ignoredReason`}
              error={fieldError("ignoredReason")}
            >
              <Input
                id={`${id}-ignoredReason`}
                value={values.ignoredReason}
                maxLength={200}
                onChange={(event) => set("ignoredReason", event.currentTarget.value)}
                {...control("ignoredReason")}
              />
            </FormField>
          ) : null}
        </fieldset>

        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {canAutoPost ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px]">
                取込時に自動で登録
                <span className="block text-[12px] text-muted-2">
                  一致した明細は未処理に出ず、処理済みの「ルールで自動登録」に入ります
                </span>
              </span>
              <Switch
                checked={values.autoPost}
                onCheckedChange={(checked) => set("autoPost", checked)}
                label="取込時に自動で登録"
              />
            </div>
          ) : null}
          <FormField
            label="優先度"
            htmlFor={`${id}-priority`}
            help="-100〜100。大きいものから試し、最初に一致したルールを使います"
            error={fieldError("priority")}
          >
            <Input
              id={`${id}-priority`}
              value={values.priority}
              inputMode="numeric"
              className="max-w-28"
              onChange={(event) => set("priority", event.currentTarget.value)}
              {...control("priority", true)}
            />
          </FormField>
          <p aria-live="polite" className="text-[13px]">
            {totals === null ? (
              <span className="text-muted-2">いま一致する未処理を数えています…</span>
            ) : (
              <>
                いま一致する未処理{" "}
                <span className="num font-bold">{totals.count.toLocaleString("ja-JP")}</span> 件
                {totals.count > 0 ? (
                  <span className="num text-muted">
                    （入金 {formatYen(BigInt(totals.inflow))} 円 / 出金{" "}
                    {formatYen(BigInt(totals.outflow))} 円）
                  </span>
                ) : null}
              </>
            )}
          </p>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={`保存して ${count ?? 0} 件に適用します`}
        confirmLabel="保存して適用"
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={saveAndApply}
      >
        <p>
          いま一致する未処理の明細 <span className="num font-bold">{count ?? 0}</span>{" "}
          件を、このルールで
          {RULE_MODE_LABELS[values.mode]}します。
        </p>
        {totals && totals.count > 0 ? (
          <p className="num mt-2 text-muted">
            入金 {formatYen(BigInt(totals.inflow))} 円 / 出金 {formatYen(BigInt(totals.outflow))} 円
          </p>
        ) : null}
        <p className="mt-2 text-[13px] text-muted">
          締めた期間の明細などは片付けずに残し、理由を明細の行に出します。
        </p>
      </ConfirmDialog>
    </Sheet>
  );
}
