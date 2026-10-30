"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, describedBy, FormField, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { EntryPreview } from "../../../_components/entry-preview";
import {
  declarationInput,
  declarationKey,
  type DeclarationDraft,
  type DependentDraft,
  type YearEndOptions,
} from "../../../_lib/year-end-draft";
import type { YearEndPreviewView, YearEndStepView } from "../../../_lib/year-end-views";
import {
  confirmYearEndAction,
  previewYearEndAction,
  saveYearEndDeclarationAction,
} from "../../../actions";

const PREVIEW_DELAY_MS = 300;

/** The declaration's fields the form draws (with or without the `declaration.` of a save). */
const FORM_FIELD =
  /^(declaration\.)?(dependents(\.\d+(\.(category|disability|under23))?)?|self\.(disability|widowStatus|workingStudent)|otherIncome|spouse(\.(totalIncome|elderly|disability))?|specificRelatives(\.\d+(\.totalIncome)?)?|incomeAdjustment|insurance\.\w+|housingLoanCredit|previousEmployer(\.(paid|socialInsurance|withheld))?)$/;

const INSURANCE_FIELDS = [
  ["newGeneral", "一般の生命保険料（新）"],
  ["oldGeneral", "一般の生命保険料（旧）"],
  ["medical", "介護医療保険料"],
  ["newPension", "個人年金保険料（新）"],
  ["oldPension", "個人年金保険料（旧）"],
  ["earthquake", "地震保険料"],
  ["oldLongTerm", "旧長期損害保険料"],
  ["socialInsurance", "申告による社会保険料（国民年金など）"],
  ["smallBusinessMutualAid", "小規模企業共済等掛金"],
] as const;

interface PreviewState {
  key: string;
  result: ActionResult<YearEndPreviewView> | null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-extrabold">{title}</h2>
        {description ? <p className="text-[13px] text-muted">{description}</p> : null}
      </div>
      <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
        {children}
      </div>
    </section>
  );
}

function Steps({ steps, stale }: { steps: readonly YearEndStepView[]; stale: boolean }) {
  return (
    <table
      className={`w-full border-collapse text-[13px] ${stale ? "opacity-60" : ""}`}
      aria-busy={stale}
    >
      <caption className="sr-only">年税額の計算</caption>
      <thead>
        <tr className="border-y border-border-2 bg-surface-2 text-[11px] text-muted">
          <th scope="col" className="px-2 py-1.5 text-left font-bold">
            段
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-bold">
            金額（円）
          </th>
        </tr>
      </thead>
      <tbody>
        {steps.map((row) => (
          <tr
            key={row.key}
            className={`border-b border-border ${row.strong ? "bg-surface-2 font-bold" : ""}`}
          >
            <th
              scope="row"
              className={`px-2 py-1.5 text-left font-normal ${row.indent ? "pl-6" : ""} ${row.strong ? "font-bold" : ""}`}
            >
              {row.label}
              {row.note ? (
                <span className="block text-[11px] font-normal text-muted">{row.note}</span>
              ) : null}
            </th>
            <td className="num px-2 py-1.5 text-right align-top">{row.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 年末調整の申告と計算 (22-payroll §11.5): the declarations (扶養控除等・基礎控除・配偶者・特定親族・
 * 所得金額調整控除・保険料控除・住宅借入金等特別控除・前職分), every step recomputed by the server as
 * you type (300 ms after the last change, stale answers dropped), 「申告を保存」 with the audit log,
 * and 「年末調整を確定」 behind a dialog with 年税額・過不足・精算の仕訳 (only with the saved
 * declaration and nothing blocking it).
 */
export function YearEndForm({
  year,
  employeeId,
  employeeName,
  initialDraft,
  savedDraft,
  initialView,
  options,
  readOnly,
  ledgerHref,
}: {
  year: number;
  employeeId: string;
  employeeName: string;
  initialDraft: DeclarationDraft;
  /** The saved declaration as text, `null` = not saved yet. */
  savedDraft: DeclarationDraft | null;
  initialView: YearEndPreviewView;
  options: YearEndOptions;
  /** Confirmed: the declaration and the result are read only. */
  readOnly: boolean;
  ledgerHref: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<DeclarationDraft>(initialDraft);
  const [savedKey, setSavedKey] = useState<string | null>(
    savedDraft ? declarationKey(savedDraft) : null,
  );
  const [preview, setPreview] = useState<PreviewState>(() => ({
    key: declarationKey(initialDraft),
    result: { ok: true, data: initialView },
  }));
  const [submitted, setSubmitted] = useState<ActionError | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  const key = declarationKey(draft);
  const upToDate = preview.key === key && !previewing;
  const stale = !upToDate;
  const view = preview.result?.ok ? preview.result.data : null;
  const dirty = savedKey !== key;
  const shownError = submitted ?? (preview.result && !preview.result.ok ? preview.result : null);
  const errorOf = (path: string) =>
    shownError?.fieldErrors[`declaration.${path}`] ?? shownError?.fieldErrors[path];
  const alerts = formLevelErrors(shownError, (field) => FORM_FIELD.test(field));
  const blockers = view
    ? [
        ...(dirty && savedKey !== null ? ["申告の変更を保存してから確定します"] : []),
        ...view.blockers,
      ]
    : [];
  const canConfirm =
    !readOnly && view !== null && upToDate && !dirty && view.blockers.length === 0 && !confirming;

  function requestPreview(next: DeclarationDraft, nextKey: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sequence.current += 1;
      const request = sequence.current;
      startPreview(async () => {
        const result = await previewYearEndAction(year, employeeId, declarationInput(next));
        if (request === sequence.current) setPreview({ key: nextKey, result });
      });
    }, PREVIEW_DELAY_MS);
  }

  function change(next: DeclarationDraft) {
    if (readOnly) return;
    setDraft(next);
    setSubmitted(null);
    const nextKey = declarationKey(next);
    // Only reformatted (e.g. 50000 → 50,000 on blur): the preview asked for already applies.
    if (nextKey === key) return;
    requestPreview(next, nextKey);
  }

  const patch = (value: Partial<DeclarationDraft>) => change({ ...draft, ...value });
  const patchInsurance = (value: Partial<DeclarationDraft["insurance"]>) =>
    change({ ...draft, insurance: { ...draft.insurance, ...value } });
  const patchDependent = (index: number, value: Partial<DependentDraft>) =>
    change({
      ...draft,
      dependents: draft.dependents.map((row, at) => (at === index ? { ...row, ...value } : row)),
    });

  function save() {
    startSave(async () => {
      const result = await saveYearEndDeclarationAction(year, employeeId, declarationInput(draft));
      if (!result.ok) {
        setSubmitted(result);
        return;
      }
      setSubmitted(null);
      setSavedKey(key);
      toast(`${employeeName}さんの申告を保存しました`);
      // The blockers (申告の保存) and the list change: compute again and refresh the page's data.
      requestPreview(draft, key);
      router.refresh();
    });
  }

  function confirm() {
    if (!view || !canConfirm) return;
    startConfirm(async () => {
      const result = await confirmYearEndAction(year, employeeId, view.expected);
      if (!result.ok) {
        setSubmitted(result);
        return;
      }
      setConfirmOpen(false);
      toast(
        `${employeeName}さんの年末調整を確定しました（${result.data.settlement}${
          result.data.entryNo === null ? "" : `・仕訳 No.${result.data.entryNo}`
        }）`,
      );
      router.refresh();
    });
  }

  const field = (name: string) => `${id}-${name}`;
  const optionsOf = (list: readonly { value: string; label: string }[]) =>
    list.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));

  return (
    <div className="flex flex-col gap-8">
      {readOnly && view?.confirmed ? (
        <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
          確定済み（{view.confirmed.by} が {view.confirmed.at}{" "}
          に確定）。確定した年末調整は変えられません。
          {view.confirmed.entry ? (
            <>
              {" "}
              精算の仕訳{" "}
              <Link
                href={`/entries/${view.confirmed.entry.id}`}
                className="num font-bold underline underline-offset-4"
              >
                No.{view.confirmed.entry.no}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <fieldset disabled={readOnly || saving} className="flex min-w-0 flex-col gap-8">
        <Section
          title="扶養控除等"
          description={`扶養控除等申告書の内容。氏名は入れず、区分だけを入れます（12 月 31 日の年齢。特定扶養親族は ${options.ageHelp.specific}、老人は ${options.ageHelp.elderly}、控除対象扶養親族は ${options.ageHelp.age16}）`}
        >
          {draft.dependents.length === 0 ? (
            <p className="text-[13px] text-muted">扶養親族はいません。</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.dependents.map((dependent, index) => (
                <li
                  key={index}
                  className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] sm:items-end"
                >
                  <FormField
                    label={`扶養親族 ${index + 1} の区分`}
                    htmlFor={field(`dependent-${index}-category`)}
                    error={errorOf(`dependents.${index}.category`)}
                  >
                    <Select
                      id={field(`dependent-${index}-category`)}
                      value={dependent.category}
                      onChange={(event) =>
                        patchDependent(index, { category: event.currentTarget.value })
                      }
                      {...describedBy(field(`dependent-${index}-category`), {
                        error: errorOf(`dependents.${index}.category`),
                      })}
                    >
                      {optionsOf(options.categories)}
                    </Select>
                  </FormField>
                  <FormField
                    label="障害"
                    htmlFor={field(`dependent-${index}-disability`)}
                    error={errorOf(`dependents.${index}.disability`)}
                  >
                    <Select
                      id={field(`dependent-${index}-disability`)}
                      value={dependent.disability}
                      onChange={(event) =>
                        patchDependent(index, { disability: event.currentTarget.value })
                      }
                      {...describedBy(field(`dependent-${index}-disability`), {
                        error: errorOf(`dependents.${index}.disability`),
                      })}
                    >
                      {optionsOf(options.disabilities)}
                    </Select>
                  </FormField>
                  {dependent.category === "general" ? (
                    <Checkbox
                      id={field(`dependent-${index}-under23`)}
                      label="23 歳未満（16〜18 歳）"
                      checked={dependent.under23}
                      onChange={(event) =>
                        patchDependent(index, { under23: event.currentTarget.checked })
                      }
                    />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      patch({ dependents: draft.dependents.filter((_, at) => at !== index) })
                    }
                  >
                    この行を削除
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button
              size="sm"
              onClick={() =>
                patch({
                  dependents: [
                    ...draft.dependents,
                    { category: "general", disability: "none", under23: false },
                  ],
                })
              }
            >
              扶養親族を追加
            </Button>
          </div>
          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3 sm:items-end">
            <FormField
              label="本人の障害"
              htmlFor={field("self-disability")}
              error={errorOf("self.disability")}
            >
              <Select
                id={field("self-disability")}
                value={draft.self.disability}
                onChange={(event) =>
                  patch({ self: { ...draft.self, disability: event.currentTarget.value } })
                }
              >
                {optionsOf(options.selfDisabilities)}
              </Select>
            </FormField>
            <FormField
              label="寡婦・ひとり親"
              htmlFor={field("self-widow")}
              error={errorOf("self.widowStatus")}
              help="合計所得金額 500 万円以下の人"
            >
              <Select
                id={field("self-widow")}
                value={draft.self.widowStatus}
                onChange={(event) =>
                  patch({ self: { ...draft.self, widowStatus: event.currentTarget.value } })
                }
                {...describedBy(field("self-widow"), { help: true })}
              >
                {optionsOf(options.widowStatuses)}
              </Select>
            </FormField>
            <Checkbox
              id={field("self-student")}
              label="勤労学生（合計所得金額 89 万円以下）"
              checked={draft.self.workingStudent}
              onChange={(event) =>
                patch({ self: { ...draft.self, workingStudent: event.currentTarget.checked } })
              }
            />
          </div>
        </Section>

        <Section title="基礎控除" description="基礎控除申告書の内容">
          <FormField
            label="給与以外の所得の見積額（円）"
            htmlFor={field("other-income")}
            error={errorOf("otherIncome")}
            help="この勤め先の給与のほかの所得（事業・不動産・年金など）。合計所得金額の判定に使います"
            className="max-w-[360px]"
          >
            <MoneyInput
              id={field("other-income")}
              value={draft.otherIncome}
              placeholder="0"
              onValueChange={(otherIncome) => patch({ otherIncome })}
              {...describedBy(field("other-income"), {
                help: true,
                error: errorOf("otherIncome"),
              })}
            />
          </FormField>
        </Section>

        <Section title="配偶者" description="配偶者控除等申告書の内容">
          <Checkbox
            id={field("has-spouse")}
            label="配偶者控除・配偶者特別控除を申告する"
            checked={draft.hasSpouse}
            onChange={(event) => patch({ hasSpouse: event.currentTarget.checked })}
          />
          {draft.hasSpouse ? (
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <FormField
                label="配偶者の合計所得の見積額（円）"
                htmlFor={field("spouse-income")}
                error={errorOf("spouse.totalIncome")}
                help="62 万円以下は配偶者控除、133 万円以下は配偶者特別控除"
              >
                <MoneyInput
                  id={field("spouse-income")}
                  value={draft.spouse.totalIncome}
                  placeholder="0"
                  onValueChange={(totalIncome) =>
                    patch({ spouse: { ...draft.spouse, totalIncome } })
                  }
                  {...describedBy(field("spouse-income"), {
                    help: true,
                    error: errorOf("spouse.totalIncome"),
                  })}
                />
              </FormField>
              <FormField
                label="配偶者の障害"
                htmlFor={field("spouse-disability")}
                error={errorOf("spouse.disability")}
              >
                <Select
                  id={field("spouse-disability")}
                  value={draft.spouse.disability}
                  onChange={(event) =>
                    patch({ spouse: { ...draft.spouse, disability: event.currentTarget.value } })
                  }
                >
                  {optionsOf(options.disabilities)}
                </Select>
              </FormField>
              <Checkbox
                id={field("spouse-elderly")}
                label={`70 歳以上（${options.ageHelp.elderly}）`}
                checked={draft.spouse.elderly}
                onChange={(event) =>
                  patch({ spouse: { ...draft.spouse, elderly: event.currentTarget.checked } })
                }
              />
            </div>
          ) : null}
        </Section>

        <Section
          title="特定親族"
          description={`特定親族特別控除: ${options.ageHelp.specific}で合計所得金額 62 万円超 123 万円以下の親族`}
        >
          {draft.specificRelatives.length === 0 ? (
            <p className="text-[13px] text-muted">特定親族はいません。</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.specificRelatives.map((relative, index) => (
                <li
                  key={index}
                  className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
                >
                  <FormField
                    label={`特定親族 ${index + 1} の合計所得の見積額（円）`}
                    htmlFor={field(`relative-${index}`)}
                    error={errorOf(`specificRelatives.${index}.totalIncome`)}
                    className="min-w-0 flex-1"
                  >
                    <MoneyInput
                      id={field(`relative-${index}`)}
                      value={relative.totalIncome}
                      placeholder="0"
                      onValueChange={(totalIncome) =>
                        patch({
                          specificRelatives: draft.specificRelatives.map((row, at) =>
                            at === index ? { totalIncome } : row,
                          ),
                        })
                      }
                      {...describedBy(field(`relative-${index}`), {
                        error: errorOf(`specificRelatives.${index}.totalIncome`),
                      })}
                    />
                  </FormField>
                  <Button
                    size="sm"
                    onClick={() =>
                      patch({
                        specificRelatives: draft.specificRelatives.filter((_, at) => at !== index),
                      })
                    }
                  >
                    この行を削除
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button
              size="sm"
              onClick={() =>
                patch({ specificRelatives: [...draft.specificRelatives, { totalIncome: "" }] })
              }
            >
              特定親族を追加
            </Button>
          </div>
        </Section>

        <Section
          title="所得金額調整控除"
          description="給与等の収入が 850 万円を超える人。本人が特別障害者か、23 歳未満の扶養親族・特別障害者の同一生計配偶者か扶養親族がいる場合（扶養控除等の内容からも判定します）"
        >
          <Checkbox
            id={field("income-adjustment")}
            label="所得金額調整控除申告書の要件にあてはまる（ほかの家族が扶養している 23 歳未満の子など）"
            checked={draft.incomeAdjustment}
            onChange={(event) => patch({ incomeAdjustment: event.currentTarget.checked })}
          />
        </Section>

        <Section title="保険料控除" description="保険料控除申告書の内容（年間の支払額）">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {INSURANCE_FIELDS.map(([name, label]) => (
              <FormField
                key={name}
                label={`${label}（円）`}
                htmlFor={field(`insurance-${name}`)}
                error={errorOf(`insurance.${name}`)}
              >
                <MoneyInput
                  id={field(`insurance-${name}`)}
                  value={draft.insurance[name]}
                  placeholder="0"
                  onValueChange={(value) => patchInsurance({ [name]: value })}
                  {...describedBy(field(`insurance-${name}`), {
                    error: errorOf(`insurance.${name}`),
                  })}
                />
              </FormField>
            ))}
          </div>
          <Checkbox
            id={field("under23")}
            label={`23 歳未満の扶養親族がいる（${options.ageHelp.under23}。一般の生命保険料控除は 6 万円まで）`}
            checked={draft.insurance.under23Dependent}
            onChange={(event) => patchInsurance({ under23Dependent: event.currentTarget.checked })}
          />
        </Section>

        <Section title="住宅借入金等特別控除" description="住宅借入金等特別控除申告書の控除額">
          <FormField
            label="住宅借入金等特別控除額（円）"
            htmlFor={field("housing-loan")}
            error={errorOf("housingLoanCredit")}
            help="算出所得税額までを控除します"
            className="max-w-[360px]"
          >
            <MoneyInput
              id={field("housing-loan")}
              value={draft.housingLoanCredit}
              placeholder="0"
              onValueChange={(housingLoanCredit) => patch({ housingLoanCredit })}
              {...describedBy(field("housing-loan"), {
                help: true,
                error: errorOf("housingLoanCredit"),
              })}
            />
          </FormField>
        </Section>

        <Section title="前職分" description="中途入社で前の勤め先の源泉徴収票を受け取った場合">
          <Checkbox
            id={field("has-previous")}
            label="前の勤め先の給与を含める"
            checked={draft.hasPreviousEmployer}
            onChange={(event) => patch({ hasPreviousEmployer: event.currentTarget.checked })}
          />
          {draft.hasPreviousEmployer ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["paid", "支払金額"],
                  ["socialInsurance", "社会保険料等の金額"],
                  ["withheld", "源泉徴収税額"],
                ] as const
              ).map(([name, label]) => (
                <FormField
                  key={name}
                  label={`${label}（円）`}
                  htmlFor={field(`previous-${name}`)}
                  error={errorOf(`previousEmployer.${name}`)}
                >
                  <MoneyInput
                    id={field(`previous-${name}`)}
                    value={draft.previousEmployer[name]}
                    placeholder="0"
                    onValueChange={(value) =>
                      patch({ previousEmployer: { ...draft.previousEmployer, [name]: value } })
                    }
                    {...describedBy(field(`previous-${name}`), {
                      error: errorOf(`previousEmployer.${name}`),
                    })}
                  />
                </FormField>
              ))}
            </div>
          ) : null}
        </Section>
      </fieldset>

      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          <p className="mr-auto text-[13px] text-muted" aria-live="polite">
            {savedKey === null
              ? "申告はまだ保存していません"
              : dirty
                ? "保存していない変更があります"
                : "申告は保存済みです"}
          </p>
          <Button variant="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? "保存中…" : "申告を保存"}
          </Button>
        </div>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-extrabold">年税額の計算</h2>
          <Link href={ledgerHref} className="text-[13px] font-bold underline underline-offset-4">
            源泉徴収簿を開く
          </Link>
        </div>
        {view ? (
          <div className="flex flex-col gap-4">
            <div
              className={`grid gap-2 rounded-card border border-border bg-surface px-4 py-3 sm:grid-cols-4 ${stale ? "opacity-60" : ""}`}
            >
              {(
                [
                  ["給与（課税支給）", view.totals.pay],
                  ["賞与", view.totals.bonus],
                  ["社会保険料等", view.totals.socialInsurance],
                  ["源泉所得税", view.totals.withheld],
                ] as const
              ).map(([label, amount]) => (
                <div key={label} className="flex min-w-0 flex-col">
                  <span className="text-[11px] font-bold text-muted">{label}（円）</span>
                  <span className="num text-[14px] font-bold">{amount}</span>
                </div>
              ))}
              <p className="text-[12px] text-muted sm:col-span-4">
                {year}{" "}
                年に支払った確定済みの給与と賞与（支払日がその年）の合計。前職分と申告分は下の計算に入ります
              </p>
            </div>
            {view.runs.length > 0 ? (
              <details className="rounded-card border border-border bg-surface px-4 py-2">
                <summary className="cursor-pointer text-[13px] font-bold">
                  集計した支給（{view.runs.length} 件）
                </summary>
                <ul className="mt-2 flex flex-col">
                  {view.runs.map((run) => (
                    <li
                      key={run.key}
                      className="flex flex-wrap items-baseline gap-x-3 border-b border-border py-1.5 text-[13px] last:border-b-0"
                    >
                      <span className="font-bold">{run.label}</span>
                      <span className="num text-muted">{run.paymentDate}</span>
                      <span className="num ml-auto">
                        {run.pay} 円 · 社保 {run.socialInsurance} 円 · 源泉 {run.withheld} 円
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {view.ineligible.length > 0 || view.warnings.length > 0 ? (
              <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
                {[...view.ineligible, ...view.warnings].map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            ) : null}
            <Steps steps={view.steps} stale={stale} />
            <div className="flex items-center justify-between rounded-lg border-2 border-text bg-surface-2 px-4 py-3">
              <span className="text-[14px] font-extrabold">9. 過不足</span>
              <span className="num text-[18px] font-extrabold">{view.settlement.text}</span>
            </div>
          </div>
        ) : (
          <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
            {previewing ? "計算中…" : "入力を直すと、年税額の計算を出します。"}
          </p>
        )}
      </section>

      {readOnly || !view ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-extrabold">精算</h2>
          {view.entry ? (
            <EntryPreview entry={view.entry} label="精算の仕訳" />
          ) : (
            <p className="text-[13px] text-muted">
              {view.settlement.kind === "none"
                ? "過不足がないので、精算の仕訳は作りません。"
                : "12 月の支給を確定すると、精算の仕訳を出します。"}
            </p>
          )}
          {view.slot && view.settlement.kind !== "none" ? (
            <p className="text-[13px] text-muted">
              「{view.slot.title}」（期限 <span className="num">{view.slot.dueDate}</span>
              ）の予定額に
              {view.settlement.kind === "refund" ? "過納額を引きます" : "不足額を足します"}
              。予定額が負になるときは納付なしとし、残りを翌月以降の源泉所得税から充当します。
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            <div className="mr-auto text-[13px] text-muted" aria-live="polite">
              {previewing || stale
                ? "再計算中…"
                : blockers.length > 0
                  ? blockers.map((message) => <p key={message}>{message}</p>)
                  : `年調年税額 ${view.annualTax} 円 · ${view.settlement.text}`}
            </div>
            <Button
              variant="primary"
              onClick={() => {
                setSubmitted(null);
                setConfirmOpen(true);
              }}
              disabled={!canConfirm}
            >
              年末調整を確定
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmOpen && view !== null}
        title={`${employeeName}さんの ${year} 年分の年末調整を確定します`}
        confirmLabel="年末調整を確定"
        pending={confirming}
        error={submitted?.error ?? null}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirm}
      >
        {view ? (
          <div className="flex flex-col gap-2">
            <p>
              年調年税額 <span className="num font-bold">{view.annualTax}</span> 円 ·{" "}
              <span className="font-bold">{view.settlement.text}</span>
            </p>
            {view.entry ? (
              <div>
                <p className="text-[13px] font-bold text-muted">仕訳 1 件</p>
                <p className="text-[13px]">
                  {view.entry.description} <span className="num">{view.entry.entryDate}</span>
                </p>
                <ul className="text-[13px]">
                  {view.entry.lines.map((line) => (
                    <li key={line.key}>
                      {line.side === "debit" ? "借方" : "貸方"} {line.account}
                      {line.sub ? `〔${line.sub}〕` : ""}{" "}
                      <span className="num font-bold">{line.amount}</span> 円
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[13px]">過不足がないので、仕訳は作りません。</p>
            )}
            {view.slot && view.settlement.kind !== "none" ? (
              <p className="text-[13px]">
                納付予定: {view.slot.title} · 期限 <span className="num">{view.slot.dueDate}</span>
              </p>
            ) : null}
            <p className="mt-1 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              確定後は申告も結果も変えられません。直すときは取引で仕訳を訂正します。
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
