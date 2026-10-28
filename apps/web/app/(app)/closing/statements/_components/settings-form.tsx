"use client";

import { useId, useState, type ReactNode } from "react";
import { useFormSubmit } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors } from "@/lib/action-types";
import { saveStatementSettingsAction } from "../actions";

/** The texts of 決算書の設定 as the form shows them (the 雛形 until saved, 17 §3.1). */
export interface StatementSettingsFormValues {
  issuedShares: string;
  shareholdersMeetingOn: string;
  announcementPublishedOn: string;
  announcementUrl: string;
  notes: {
    depreciation: string;
    revenueRecognition: string;
    otherSignificant: string;
    accountingPolicyChanges: string;
    presentationChanges: string;
    errorCorrections: string;
    otherNotes: readonly { title: string; body: string }[];
  };
  businessReport: { progress: string; issues: string; otherMatters: string };
  simplifiedTaxClass: string;
}

export interface SettingsFormHints {
  /** 発行済株式の総数 came from an earlier year (not saved for this one). */
  issuedSharesFromEarlierYear: boolean;
  /** 「2032/05/28」: 株主総会の日 + 5 years, or `null` without a meeting date. */
  deadline: string | null;
  notesFromTemplate: boolean;
  businessReportFromTemplate: boolean;
}

const MAX_OTHER_NOTES = 20;
const TEXT_MAX = 2000;

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4 border-t border-border pt-4">
      <legend className="text-[14px] font-extrabold">{title}</legend>
      {description ? <p className="-mt-2 text-[12px] text-muted">{description}</p> : null}
      {children}
    </fieldset>
  );
}

/**
 * 決算書の設定 (17 §3.1): one form, 「保存」. The texts start as the 雛形; saving them (even unchanged)
 * records that the directors checked them. A closed year can be saved: only words and dates change.
 */
export function StatementSettingsForm({
  fiscalYearId,
  initial,
  hints,
  taxClassOptions,
}: {
  fiscalYearId: string;
  initial: StatementSettingsFormValues;
  hints: SettingsFormHints;
  taxClassOptions: readonly { value: string; label: string }[];
}) {
  const id = useId();
  const toast = useToast();
  const [noteRows, setNoteRows] = useState(
    Math.min(MAX_OTHER_NOTES, Math.max(1, initial.notes.otherNotes.length + 1)),
  );
  const { onSubmit, pending, error } = useFormSubmit(
    (formData) => saveStatementSettingsAction(fiscalYearId, formData),
    { reset: false, onSuccess: () => toast("決算書の設定を保存しました") },
  );
  const fieldError = (name: string) => error?.fieldErrors[name];
  const field = (name: string) => `${id}-${name.replaceAll(".", "-")}`;
  const shown = new Set<string>();

  function text(name: string, label: string, value: string, help?: ReactNode, rows = 3) {
    shown.add(name);
    const error = fieldError(name);
    return (
      <FormField label={label} htmlFor={field(name)} help={help} error={error}>
        <Textarea
          id={field(name)}
          name={name}
          defaultValue={value}
          rows={rows}
          maxLength={TEXT_MAX}
          {...describedBy(field(name), { help, error })}
        />
      </FormField>
    );
  }

  function input(
    name: string,
    label: string,
    value: string,
    options: { type?: string; help?: ReactNode; inputMode?: "numeric"; placeholder?: string } = {},
  ) {
    shown.add(name);
    const error = fieldError(name);
    return (
      <FormField label={label} htmlFor={field(name)} help={options.help} error={error}>
        <Input
          id={field(name)}
          name={name}
          type={options.type ?? "text"}
          defaultValue={value}
          inputMode={options.inputMode}
          placeholder={options.placeholder}
          autoComplete="off"
          {...describedBy(field(name), { help: options.help, error })}
        />
      </FormField>
    );
  }

  const noteFields = Array.from({ length: noteRows }, (_, index) => {
    const note = initial.notes.otherNotes[index] ?? { title: "", body: "" };
    const titleName = `notes.otherNotes.${index}.title`;
    const bodyName = `notes.otherNotes.${index}.body`;
    return (
      <div key={index} className="grid gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        {input(titleName, `その他の注記 ${index + 1}：項目名`, note.title, {
          placeholder: "重要な後発事象",
        })}
        {text(bodyName, `その他の注記 ${index + 1}：内容`, note.body, undefined, 2)}
      </div>
    );
  });

  shown.add("simplifiedTaxClass");
  const formErrors = formLevelErrors(error, (name) => shown.has(name));

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {formErrors.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {formErrors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <Group title="株式と日付">
        <div className="grid gap-4 md:grid-cols-2">
          {input("issuedShares", "発行済株式の総数（株）", initial.issuedShares, {
            inputMode: "numeric",
            help: hints.issuedSharesFromEarlierYear
              ? "前の期の値です。保存するとこの期の値になります"
              : "個別注記表と事業報告に出します",
          })}
          {input(
            "shareholdersMeetingOn",
            "株主総会の日（計算書類の承認）",
            initial.shareholdersMeetingOn,
            {
              type: "date",
              help: hints.deadline
                ? `決算公告の掲載期限は ${hints.deadline}（株主総会の日の 5 年後の日）`
                : "決算公告の掲載期限（5 年後の日）と事業報告の日付に使います",
            },
          )}
          {input("announcementPublishedOn", "決算公告の掲載日", initial.announcementPublishedOn, {
            type: "date",
            help: "決算公告の HTML に出します",
          })}
          {input("announcementUrl", "決算公告の URL", initial.announcementUrl, {
            type: "url",
            placeholder: "https://example.com/koukoku/",
            help: "画面に出すだけで、HTML には書きません",
          })}
        </div>
      </Group>

      <Group
        title="個別注記表"
        description={
          hints.notesFromTemplate
            ? "雛形の文です。会社の実態に合わせて直し、保存します（変えなくても、保存すると確かめた記録になります）。"
            : "空にした項目は出しません。"
        }
      >
        {text("notes.depreciation", "固定資産の減価償却の方法", initial.notes.depreciation)}
        {text(
          "notes.revenueRecognition",
          "収益及び費用の計上基準",
          initial.notes.revenueRecognition,
        )}
        {text(
          "notes.otherSignificant",
          "その他計算書類の作成のための基本となる重要な事項",
          initial.notes.otherSignificant,
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {text(
            "notes.accountingPolicyChanges",
            "会計方針の変更",
            initial.notes.accountingPolicyChanges,
            "空なら出しません",
            2,
          )}
          {text(
            "notes.presentationChanges",
            "表示方法の変更",
            initial.notes.presentationChanges,
            "空なら出しません",
            2,
          )}
        </div>
        {text(
          "notes.errorCorrections",
          "誤謬の訂正",
          initial.notes.errorCorrections,
          "その他の注記の先頭に出します。空なら出しません",
          2,
        )}
        <div className="flex flex-col gap-3">
          {noteFields}
          {noteRows < MAX_OTHER_NOTES ? (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setNoteRows(noteRows + 1)}>
                その他の注記を追加
              </Button>
            </div>
          ) : null}
        </div>
      </Group>

      <Group
        title="事業報告"
        description={
          hints.businessReportFromTemplate
            ? "雛形の文です。直して保存します。"
            : "株主数が 1 名でないときは、その他の重要な事項に書きます。"
        }
      >
        {text("businessReport.progress", "事業の経過及びその成果", initial.businessReport.progress)}
        {text("businessReport.issues", "対処すべき課題", initial.businessReport.issues)}
        {text(
          "businessReport.otherMatters",
          "その他の重要な事項",
          initial.businessReport.otherMatters,
        )}
      </Group>

      <Group title="消費税">
        <FormField
          label="簡易課税の事業区分"
          htmlFor={field("simplifiedTaxClass")}
          help="消費税の集計の簡易課税の概算に使います"
          error={fieldError("simplifiedTaxClass")}
          className="md:max-w-md"
        >
          <Select
            id={field("simplifiedTaxClass")}
            name="simplifiedTaxClass"
            defaultValue={initial.simplifiedTaxClass}
            {...describedBy(field("simplifiedTaxClass"), {
              help: true,
              error: fieldError("simplifiedTaxClass"),
            })}
          >
            {taxClassOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FormField>
      </Group>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
