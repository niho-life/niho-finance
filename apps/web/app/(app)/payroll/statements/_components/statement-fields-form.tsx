"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, describedBy, FormField, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { saveStatementFieldsAction } from "../actions";

/** A relative's name as the form holds it. */
export interface PersonDraft {
  /** 「控除対象扶養親族 (1) · 特定扶養親族」 */
  label: string;
  name: string;
  furigana: string;
  nonResident: boolean;
}

/** 法定調書の欄 (22-payroll §12.2) as text: what the page fills and the form sends. */
export interface StatementFieldsDraft {
  recipient: { furigana: string; address: string; municipalityCode: string; recipientNo: string };
  /** 受給者番号 when left empty (the employee id). */
  defaultRecipientNo: string;
  spouse: PersonDraft | null;
  dependents: PersonDraft[];
  specificRelatives: PersonDraft[];
  /** 前職の支払者, when the 申告 has 前職分. */
  previousPayer: { name: string; address: string; leftOn: string } | null;
}

const person = ({ name, furigana, nonResident }: PersonDraft) => ({ name, furigana, nonResident });

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-[12px] font-bold text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * 法定調書の欄の入力: 受給者のフリガナ・翌年 1 月 1 日現在の住所・提出先市町村コード・受給者番号, the
 * names of the 申告's relatives and 前職の支払者 (audit log; DB only). Never a マイナンバー: that is
 * typed on the CSV form only, for one download.
 */
export function StatementFieldsForm({
  year,
  employeeId,
  initial,
}: {
  year: number;
  employeeId: string;
  initial: StatementFieldsDraft;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const field = (name: string) => `${id}-${name}`;
  const fieldError = (name: string) => error?.fieldErrors[name];
  const alerts = formLevelErrors(error, (name) =>
    /^(recipient\.\w+|spouse\.\w+|dependents\.\d+\.\w+|specificRelatives\.\d+\.\w+|previousPayer\.\w+)$/.test(
      name,
    ),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveStatementFieldsAction(year, employeeId, {
        recipient: draft.recipient,
        spouse: draft.spouse ? person(draft.spouse) : null,
        dependents: draft.dependents.map(person),
        specificRelatives: draft.specificRelatives.map(person),
        previousPayer: draft.previousPayer,
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast("法定調書の欄を保存しました");
      router.refresh();
    });
  }

  const personFields = (key: string, value: PersonDraft, onChange: (next: PersonDraft) => void) => (
    <div key={key} className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
      <FormField
        label={`${value.label} の氏名`}
        htmlFor={field(`${key}-name`)}
        error={fieldError(`${key}.name`)}
      >
        <Input
          id={field(`${key}-name`)}
          value={value.name}
          maxLength={30}
          autoComplete="off"
          onChange={(event) => onChange({ ...value, name: event.currentTarget.value })}
          {...describedBy(field(`${key}-name`), { error: fieldError(`${key}.name`) })}
        />
      </FormField>
      <FormField
        label="フリガナ"
        htmlFor={field(`${key}-kana`)}
        error={fieldError(`${key}.furigana`)}
      >
        <Input
          id={field(`${key}-kana`)}
          value={value.furigana}
          maxLength={60}
          autoComplete="off"
          onChange={(event) => onChange({ ...value, furigana: event.currentTarget.value })}
          {...describedBy(field(`${key}-kana`), { error: fieldError(`${key}.furigana`) })}
        />
      </FormField>
      <Checkbox
        id={field(`${key}-nonresident`)}
        label="非居住者"
        className="self-end"
        checked={value.nonResident}
        onChange={(event) => onChange({ ...value, nonResident: event.currentTarget.checked })}
      />
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <Group title="受給者">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            label="フリガナ"
            htmlFor={field("furigana")}
            error={fieldError("recipient.furigana")}
            help="CSV では半角カナにします"
          >
            <Input
              id={field("furigana")}
              value={draft.recipient.furigana}
              maxLength={60}
              autoComplete="off"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  recipient: { ...draft.recipient, furigana: event.currentTarget.value },
                })
              }
              {...describedBy(field("furigana"), {
                help: true,
                error: fieldError("recipient.furigana"),
              })}
            />
          </FormField>
          <FormField
            label="受給者番号"
            htmlFor={field("recipient-no")}
            error={fieldError("recipient.recipientNo")}
            help={`空なら ${initial.defaultRecipientNo}`}
          >
            <Input
              id={field("recipient-no")}
              value={draft.recipient.recipientNo}
              maxLength={25}
              autoComplete="off"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  recipient: { ...draft.recipient, recipientNo: event.currentTarget.value },
                })
              }
              {...describedBy(field("recipient-no"), {
                help: true,
                error: fieldError("recipient.recipientNo"),
              })}
            />
          </FormField>
        </div>
        <FormField
          label={`住所（${year + 1} 年 1 月 1 日現在。退職した人は退職時の住所）`}
          htmlFor={field("address")}
          error={fieldError("recipient.address")}
        >
          <Input
            id={field("address")}
            value={draft.recipient.address}
            maxLength={60}
            autoComplete="off"
            onChange={(event) =>
              setDraft({
                ...draft,
                recipient: { ...draft.recipient, address: event.currentTarget.value },
              })
            }
            {...describedBy(field("address"), { error: fieldError("recipient.address") })}
          />
        </FormField>
        <FormField
          label="提出先市町村コード"
          htmlFor={field("municipality")}
          error={fieldError("recipient.municipalityCode")}
          help="住所の市区町村の全国地方公共団体コード（6 桁）"
        >
          <Input
            id={field("municipality")}
            value={draft.recipient.municipalityCode}
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
            className="num w-[120px]"
            onChange={(event) =>
              setDraft({
                ...draft,
                recipient: { ...draft.recipient, municipalityCode: event.currentTarget.value },
              })
            }
            {...describedBy(field("municipality"), {
              help: true,
              error: fieldError("recipient.municipalityCode"),
            })}
          />
        </FormField>
      </Group>
      {draft.spouse || draft.dependents.length > 0 || draft.specificRelatives.length > 0 ? (
        <Group title="配偶者・扶養親族（申告の順）">
          {draft.spouse
            ? personFields("spouse", draft.spouse, (spouse) => setDraft({ ...draft, spouse }))
            : null}
          {draft.dependents.map((dependent, index) =>
            personFields(`dependents.${index}`, dependent, (next) =>
              setDraft({
                ...draft,
                dependents: draft.dependents.map((row, rowIndex) =>
                  rowIndex === index ? next : row,
                ),
              }),
            ),
          )}
          {draft.specificRelatives.map((relative, index) =>
            personFields(`specificRelatives.${index}`, relative, (next) =>
              setDraft({
                ...draft,
                specificRelatives: draft.specificRelatives.map((row, rowIndex) =>
                  rowIndex === index ? next : row,
                ),
              }),
            ),
          )}
        </Group>
      ) : (
        <p className="text-[13px] text-muted">
          申告に配偶者・扶養親族がいません。いるときは 給与 › 年末調整
          の申告で入れてから氏名を入れます。
        </p>
      )}
      {draft.previousPayer ? (
        <Group title="前職の支払者（摘要と CSV の他の支払者）">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField
              label="名称"
              htmlFor={field("prev-name")}
              error={fieldError("previousPayer.name")}
            >
              <Input
                id={field("prev-name")}
                value={draft.previousPayer.name}
                maxLength={30}
                autoComplete="off"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    previousPayer: { ...draft.previousPayer!, name: event.currentTarget.value },
                  })
                }
              />
            </FormField>
            <FormField
              label="退職日"
              htmlFor={field("prev-left")}
              error={fieldError("previousPayer.leftOn")}
            >
              <Input
                id={field("prev-left")}
                type="date"
                value={draft.previousPayer.leftOn}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    previousPayer: { ...draft.previousPayer!, leftOn: event.currentTarget.value },
                  })
                }
              />
            </FormField>
          </div>
          <FormField
            label="住所"
            htmlFor={field("prev-address")}
            error={fieldError("previousPayer.address")}
          >
            <Input
              id={field("prev-address")}
              value={draft.previousPayer.address}
              maxLength={60}
              autoComplete="off"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  previousPayer: { ...draft.previousPayer!, address: event.currentTarget.value },
                })
              }
            />
          </FormField>
        </Group>
      ) : null}
      <p className="text-[12px] text-muted">
        マイナンバーはここに入れません。統一 CSV を作る画面で、その 1 回の書き出しにだけ入れます。
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "法定調書の欄を保存"}
        </Button>
      </div>
    </form>
  );
}
