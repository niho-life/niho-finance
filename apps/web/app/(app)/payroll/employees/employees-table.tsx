"use client";

import { formatYenInput, parseYenInput } from "@niho-finance/ledger";
import { useId, useState, useTransition, type FormEvent } from "react";
import { InactiveToggle } from "@/components/settings/inline";
import { OpenButton } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import {
  saveEmployeeAction,
  setEmployeeActiveAction,
  standardRemunerationAction,
} from "../actions";
import { TAX_COLUMN_LABELS, taxColumnText, WORKER_KIND_LABELS } from "../_lib/labels";
import { amountKey } from "../_lib/preview-key";

type WorkerKind = keyof typeof WORKER_KIND_LABELS;
type TaxColumn = keyof typeof TAX_COLUMN_LABELS;

/** An employee as the page passes it: amounts as the text the fields show (bigint stays on the server). */
export interface EmployeeRow {
  id: string;
  name: string;
  kind: WorkerKind;
  birthDate: string;
  basePay: string;
  commuteAllowance: string;
  socialInsured: boolean;
  /** "" when not insured. */
  insuredFrom: string;
  /** "" when not insured. */
  healthSmr: string;
  pensionSmr: string;
  employmentInsured: boolean;
  taxColumn: TaxColumn;
  dependents: number;
  residentTax: string;
  isActive: boolean;
  /** 退職日; "" = 在職. */
  leftOn: string;
}

/** 「報酬月額から求める」: usable when this month's kenpo and pension tables are registered. */
export type GradeTool = { available: true; basis: string } | { available: false; reason: string };

interface Draft {
  name: string;
  kind: WorkerKind;
  birthDate: string;
  basePay: string;
  commuteAllowance: string;
  socialInsured: boolean;
  insuredFrom: string;
  healthSmr: string;
  pensionSmr: string;
  employmentInsured: boolean;
  taxColumn: TaxColumn;
  dependents: string;
  residentTax: string;
  leftOn: string;
}

/** What saving reported: the warnings and the 退職 deadlines it put on the calendar. */
interface SavedNotice {
  name: string;
  warnings: string[];
  filings: { title: string; dueDate: string; state: string }[];
  /** The 退職日 was cleared: the deadlines already made stay. */
  leftOnCleared: boolean;
}

const COLUMNS = {
  columns: "minmax(0,1.2fr) 64px 104px minmax(0,1.5fr) 64px 84px 96px 48px 64px",
  mobileColumns: "minmax(0,1fr) auto auto",
};

/** The fields the sheet draws (in the order of 22-payroll §5.1); other errors go above it. */
const FIELDS = new Set([
  "name",
  "kind",
  "birthDate",
  "basePay",
  "commuteAllowance",
  "socialInsured",
  "insuredFrom",
  "healthSmr",
  "pensionSmr",
  "employmentInsured",
  "taxColumn",
  "dependents",
  "residentTax",
  "leftOn",
]);

function draftOf(employee: EmployeeRow | null, firstPerson: boolean): Draft {
  if (employee) {
    return {
      name: employee.name,
      kind: employee.kind,
      birthDate: employee.birthDate,
      basePay: employee.basePay,
      commuteAllowance: employee.commuteAllowance,
      socialInsured: employee.socialInsured,
      insuredFrom: employee.insuredFrom,
      healthSmr: employee.healthSmr,
      pensionSmr: employee.pensionSmr,
      employmentInsured: employee.employmentInsured,
      taxColumn: employee.taxColumn,
      dependents: String(employee.dependents),
      residentTax: employee.residentTax,
      leftOn: employee.leftOn,
    };
  }
  // The first person of a one-person company is usually the officer.
  const kind: WorkerKind = firstPerson ? "officer" : "employee";
  return {
    name: "",
    kind,
    birthDate: "",
    basePay: "",
    commuteAllowance: "",
    socialInsured: true,
    insuredFrom: "",
    healthSmr: "",
    pensionSmr: "",
    employmentInsured: kind === "employee",
    taxColumn: "kou",
    dependents: "0",
    residentTax: "",
    leftOn: "",
  };
}

/** What the server receives: hidden fields are sent empty (役員 → 雇用保険なし). */
function valuesOf(draft: Draft) {
  return {
    ...draft,
    employmentInsured: draft.kind === "officer" ? false : draft.employmentInsured,
    insuredFrom: draft.socialInsured ? draft.insuredFrom : "",
    healthSmr: draft.socialInsured ? draft.healthSmr : "",
    pensionSmr: draft.socialInsured ? draft.pensionSmr : "",
  };
}

/** 課税支給 + 通勤手当 (the default 報酬月額). */
function remunerationOf(draft: Draft): string {
  const total =
    (parseYenInput(draft.basePay) ?? 0n) + (parseYenInput(draft.commuteAllowance) ?? 0n);
  return formatYenInput(total);
}

function EmployeeSheet({
  employee,
  firstPerson,
  gradeTool,
  onSaved,
  onClose,
}: {
  /** `null`: a new employee. */
  employee: EmployeeRow | null;
  firstPerson: boolean;
  gradeTool: GradeTool;
  onSaved: (notice: SavedNotice) => void;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(employee, firstPerson));
  /** `null`: follows 課税支給 + 通勤手当. */
  const [remuneration, setRemuneration] = useState<string | null>(null);
  const [grade, setGrade] = useState<{ text: string } | { error: string } | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [grading, startGrade] = useTransition();
  const [toggling, startToggle] = useTransition();

  const change = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const remunerationText = remuneration ?? remunerationOf(draft);
  const officer = draft.kind === "officer";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveEmployeeAction(employee?.id ?? null, valuesOf(draft));
      if (!result.ok) {
        setError(result);
        return;
      }
      toast(
        employee
          ? `「${result.data.name}」を保存しました`
          : `「${result.data.name}」を追加しました`,
      );
      onSaved({
        name: result.data.name,
        warnings: result.data.warnings,
        filings: result.data.leaveFilings,
        leftOnCleared: employee !== null && employee.leftOn !== "" && draft.leftOn === "",
      });
    });
  }

  function findGrades() {
    startGrade(async () => {
      const result = await standardRemunerationAction(remunerationText);
      if (!result.ok) {
        setGrade({ error: result.error });
        return;
      }
      const { health, pension, basis } = result.data;
      setDraft((current) => ({ ...current, healthSmr: health.smr, pensionSmr: pension.smr }));
      setGrade({
        text: `健康保険 ${health.grade} 級・厚生年金 ${pension.grade} 級を入れました（${basis}）`,
      });
    });
  }

  function toggleActive() {
    if (!employee) return;
    startToggle(async () => {
      const result = await setEmployeeActiveAction(employee.id, !employee.isActive);
      if (!result.ok) {
        setToggleError(result.error);
        return;
      }
      toast(
        employee.isActive
          ? `「${employee.name}」を無効にしました`
          : `「${employee.name}」を有効にしました`,
      );
      onClose();
    });
  }

  const formId = `${id}-form`;
  const field = (name: string) => `${id}-${name}`;

  return (
    <Sheet
      open
      onClose={onClose}
      title={employee ? employee.name : "従業員を追加"}
      description={
        employee
          ? `${WORKER_KIND_LABELS[employee.kind]}${employee.isActive ? "" : " · 無効"}`
          : "役員も従業員として登録します。マイナンバー・住所・口座は持ちません"
      }
      footer={
        <>
          {employee ? (
            <Button variant="ghost" className="mr-auto" onClick={toggleActive} disabled={toggling}>
              {toggling ? "処理中…" : employee.isActive ? "無効にする" : "有効にする"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? "保存中…" : employee ? "保存" : "追加"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {alerts.length > 0 ? (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {alerts.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        <FormField label="名前" htmlFor={field("name")} required error={fieldError("name")}>
          <Input
            id={field("name")}
            value={draft.name}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => change({ name: event.currentTarget.value })}
            {...describedBy(field("name"), { error: fieldError("name") })}
          />
        </FormField>
        <FormField
          label="区分"
          htmlFor={field("kind")}
          error={fieldError("kind")}
          help={
            officer
              ? "役員報酬（定期同額給与）を受けます。雇用保険の被保険者になりません"
              : "給料手当を受け、雇用保険の被保険者になります"
          }
        >
          <Select
            id={field("kind")}
            value={draft.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value as WorkerKind;
              change({ kind, employmentInsured: kind === "officer" ? false : true });
            }}
            {...describedBy(field("kind"), { help: true, error: fieldError("kind") })}
          >
            <option value="officer">{WORKER_KIND_LABELS.officer}</option>
            <option value="employee">{WORKER_KIND_LABELS.employee}</option>
          </Select>
        </FormField>
        <FormField
          label="生年月日"
          htmlFor={field("birth")}
          required
          error={fieldError("birthDate")}
          help="介護保険・厚生年金・健康保険の年齢の判定だけに使います"
        >
          <Input
            id={field("birth")}
            type="date"
            value={draft.birthDate}
            onChange={(event) => change({ birthDate: event.currentTarget.value })}
            {...describedBy(field("birth"), { help: true, error: fieldError("birthDate") })}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="課税支給（円）"
            htmlFor={field("base")}
            required
            error={fieldError("basePay")}
            help={officer ? "毎月の役員報酬" : "毎月の基本給・課税の手当"}
          >
            <MoneyInput
              id={field("base")}
              value={draft.basePay}
              onValueChange={(basePay) => change({ basePay })}
              {...describedBy(field("base"), { help: true, error: fieldError("basePay") })}
            />
          </FormField>
          <FormField
            label="通勤手当（円）"
            htmlFor={field("commute")}
            error={fieldError("commuteAllowance")}
            help="非課税の範囲の月額"
          >
            <MoneyInput
              id={field("commute")}
              value={draft.commuteAllowance}
              onValueChange={(commuteAllowance) => change({ commuteAllowance })}
              {...describedBy(field("commute"), {
                help: true,
                error: fieldError("commuteAllowance"),
              })}
            />
          </FormField>
        </div>
        <p className="-mt-2 text-[12px] text-muted">
          どちらも支給の計算の初期値です。通勤手当は所得税の対象外で、社会保険の報酬と雇用保険の賃金には含みます。
        </p>
        <FormField
          label="社会保険（健康保険・厚生年金）"
          htmlFor={field("social")}
          error={fieldError("socialInsured")}
        >
          <Select
            id={field("social")}
            value={draft.socialInsured ? "true" : "false"}
            onChange={(event) => change({ socialInsured: event.currentTarget.value === "true" })}
          >
            <option value="true">あり</option>
            <option value="false">なし</option>
          </Select>
        </FormField>
        {draft.socialInsured ? (
          <>
            <FormField
              label="資格取得日"
              htmlFor={field("insured-from")}
              required
              error={fieldError("insuredFrom")}
              help="この日の属する月から保険料がかかります"
            >
              <Input
                id={field("insured-from")}
                type="date"
                value={draft.insuredFrom}
                onChange={(event) => change({ insuredFrom: event.currentTarget.value })}
                {...describedBy(field("insured-from"), {
                  help: true,
                  error: fieldError("insuredFrom"),
                })}
              />
            </FormField>
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-[12px] font-bold text-muted">標準報酬月額</legend>
              <div className="flex items-end gap-2">
                <FormField
                  label="報酬月額（円）"
                  htmlFor={field("remuneration")}
                  className="flex-1"
                  error={grade && "error" in grade ? grade.error : undefined}
                >
                  <MoneyInput
                    id={field("remuneration")}
                    value={remunerationText}
                    disabled={!gradeTool.available}
                    onValueChange={(text) => {
                      // The default reformatted on blur keeps following 課税支給 + 通勤手当.
                      const same = amountKey(text) === amountKey(remunerationOf(draft));
                      setRemuneration(same ? null : text);
                      setGrade(null);
                    }}
                  />
                </FormField>
                <Button
                  onClick={findGrades}
                  disabled={!gradeTool.available || grading}
                  aria-describedby={field("grade-help")}
                >
                  {grading ? "計算中…" : "報酬月額から求める"}
                </Button>
              </div>
              <p id={field("grade-help")} className="text-[12px] text-muted">
                {gradeTool.available
                  ? grade && "text" in grade
                    ? grade.text
                    : `課税支給＋通勤手当が初期値です。等級表（${gradeTool.basis}）の額を入れます`
                  : gradeTool.reason}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  label="健康保険（円）"
                  htmlFor={field("health")}
                  required
                  error={fieldError("healthSmr")}
                >
                  <MoneyInput
                    id={field("health")}
                    value={draft.healthSmr}
                    onValueChange={(healthSmr) => change({ healthSmr })}
                    {...describedBy(field("health"), { error: fieldError("healthSmr") })}
                  />
                </FormField>
                <FormField
                  label="厚生年金（円）"
                  htmlFor={field("pension")}
                  required
                  error={fieldError("pensionSmr")}
                >
                  <MoneyInput
                    id={field("pension")}
                    value={draft.pensionSmr}
                    onValueChange={(pensionSmr) => change({ pensionSmr })}
                    {...describedBy(field("pension"), { error: fieldError("pensionSmr") })}
                  />
                </FormField>
              </div>
            </fieldset>
          </>
        ) : null}
        {officer ? null : (
          <FormField
            label="雇用保険"
            htmlFor={field("employment")}
            error={fieldError("employmentInsured")}
          >
            <Select
              id={field("employment")}
              value={draft.employmentInsured ? "true" : "false"}
              onChange={(event) =>
                change({ employmentInsured: event.currentTarget.value === "true" })
              }
            >
              <option value="true">あり</option>
              <option value="false">なし</option>
            </Select>
          </FormField>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="源泉徴収の区分"
            htmlFor={field("column")}
            error={fieldError("taxColumn")}
            help={draft.taxColumn === "kou" ? "扶養控除等申告書あり" : "扶養控除等申告書なし"}
          >
            <Select
              id={field("column")}
              value={draft.taxColumn}
              onChange={(event) => change({ taxColumn: event.currentTarget.value as TaxColumn })}
              {...describedBy(field("column"), { help: true, error: fieldError("taxColumn") })}
            >
              <option value="kou">{TAX_COLUMN_LABELS.kou}</option>
              <option value="otsu">{TAX_COLUMN_LABELS.otsu}</option>
            </Select>
          </FormField>
          <FormField
            label="扶養親族等の数"
            htmlFor={field("dependents")}
            error={fieldError("dependents")}
            help={
              draft.taxColumn === "kou"
                ? "申告書から数えます"
                : "従たる給与の申告書の数（なければ 0）"
            }
          >
            <Input
              id={field("dependents")}
              inputMode="numeric"
              autoComplete="off"
              className="num text-right"
              value={draft.dependents}
              maxLength={2}
              onChange={(event) => change({ dependents: event.currentTarget.value })}
              {...describedBy(field("dependents"), { help: true, error: fieldError("dependents") })}
            />
          </FormField>
        </div>
        <FormField
          label="住民税（円）"
          htmlFor={field("resident")}
          error={fieldError("residentTax")}
          help="市区町村の通知の月額。6 月分と 7 月以降で違う月は支給の計算で直します"
        >
          <MoneyInput
            id={field("resident")}
            value={draft.residentTax}
            onValueChange={(residentTax) => change({ residentTax })}
            {...describedBy(field("resident"), { help: true, error: fieldError("residentTax") })}
          />
        </FormField>
        <FormField
          label="退職日"
          htmlFor={field("left-on")}
          error={fieldError("leftOn")}
          help="退職したら入れます。翌日が社会保険の資格喪失日で、その月の分から保険料はかかりません（月末の退職は退職月の分まで）。次の月から支給の計算に出ません。資格喪失届・異動届・源泉徴収票の交付の期限を「期限」に足します"
        >
          <Input
            id={field("left-on")}
            type="date"
            value={draft.leftOn}
            onChange={(event) => change({ leftOn: event.currentTarget.value })}
            {...describedBy(field("left-on"), { help: true, error: fieldError("leftOn") })}
          />
        </FormField>
        {toggleError ? (
          <p role="alert" className="text-[12px] font-bold text-danger">
            {toggleError}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

/** 従業員 (22-payroll §6.2): the list, a sheet per person, the warnings after saving. */
export function EmployeesTable({
  employees,
  gradeTool,
  startAdding,
}: {
  employees: EmployeeRow[];
  gradeTool: GradeTool;
  /** Open the add sheet at once (「従業員を追加」 of 給与). */
  startAdding: boolean;
}) {
  const [showInactive, setShowInactive] = useState(false);
  /** `"new"`, an employee id, or `null` when the sheet is closed. */
  const [editing, setEditing] = useState<string | null>(startAdding ? "new" : null);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const shown = employees.filter((employee) => employee.isActive || showInactive);
  const inactiveCount = employees.filter((employee) => !employee.isActive).length;
  const edited = employees.find((employee) => employee.id === editing) ?? null;

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setNotice(null);
            setEditing("new");
          }}
        >
          従業員を追加
        </Button>
      </div>
      {notice ? (
        <div
          role="status"
          className="mb-3 flex items-start gap-3 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn"
        >
          <div className="min-w-0 flex-1">
            {notice.warnings.length > 0 ? (
              <>
                <p className="font-bold">
                  「{notice.name}」を保存しました。次の点を確かめてください。
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {notice.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {notice.filings.length > 0 ? (
              <>
                <p className="mt-1 font-bold">
                  「{notice.name}」の退職の届出と交付の期限を「期限」に入れました。
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {notice.filings.map((filing) => (
                    <li key={filing.title}>
                      {filing.title}: <span className="num">{filing.dueDate}</span> まで
                      {filing.state === "completed" ? "（完了済み）" : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">
                  源泉徴収票は 給与 › 法定調書 から出します。年末調整の対象からは外れます。
                </p>
              </>
            ) : null}
            {notice.leftOnCleared ? (
              <p className="mt-1">
                退職日を消しました。前に入れた退職の届出の期限は残っています。不要なら「期限」で完了にしてください。
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 font-bold"
            aria-label="お知らせを閉じる"
          >
            ×
          </button>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <Table label="従業員">
          <TableHead {...COLUMNS}>
            <Th>名前</Th>
            <Th sm="hide">区分</Th>
            <Th align="right">課税支給（円）</Th>
            <Th sm="hide">社会保険（健保 / 厚年）</Th>
            <Th sm="hide">雇用保険</Th>
            <Th sm="hide">源泉</Th>
            <Th align="right" sm="hide">
              住民税（円）
            </Th>
            <Th sm="hide">状態</Th>
            <Th />
          </TableHead>
          {shown.map((employee) => (
            <TableRow key={employee.id} {...COLUMNS} muted={!employee.isActive}>
              <Td className="font-bold">
                {employee.name}
                <span className="block text-[12px] font-normal text-muted md:hidden">
                  {WORKER_KIND_LABELS[employee.kind]}
                  {employee.isActive ? "" : " · 無効"}
                </span>
              </Td>
              <Td sm="hide" className="text-[13px]">
                {WORKER_KIND_LABELS[employee.kind]}
              </Td>
              <Td align="right">{employee.basePay}</Td>
              <Td sm="hide" className="num text-[13px]">
                {employee.socialInsured ? `${employee.healthSmr} / ${employee.pensionSmr}` : "なし"}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {employee.employmentInsured ? "あり" : "なし"}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {taxColumnText(employee.taxColumn, employee.dependents)}
              </Td>
              <Td align="right" sm="hide">
                {employee.residentTax}
              </Td>
              <Td sm="hide" className="text-[13px] text-muted">
                {employee.isActive ? "有効" : "無効"}
                {employee.leftOn !== "" ? (
                  <span className="block text-[11px]">
                    退職 {employee.leftOn.replaceAll("-", "/")}
                  </span>
                ) : null}
              </Td>
              <Td>
                <OpenButton
                  label={`${employee.name} を編集`}
                  onClick={() => setEditing(employee.id)}
                >
                  編集
                </OpenButton>
              </Td>
            </TableRow>
          ))}
        </Table>
      ) : (
        <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
          従業員がいません。「従業員を追加」から役員・従業員を登録すると、支給を計算できます。
        </p>
      )}
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      {editing ? (
        <EmployeeSheet
          key={editing}
          employee={edited}
          firstPerson={employees.length === 0}
          gradeTool={gradeTool}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(
              saved.warnings.length > 0 || saved.filings.length > 0 || saved.leftOnCleared
                ? saved
                : null,
            );
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
