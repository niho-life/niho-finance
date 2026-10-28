"use client";

import type { OpeningInput } from "@niho-finance/db";
import { useRef, useState, useTransition } from "react";
import { ActionButton } from "@/components/settings/action-button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import type { ActionError, ActionResult } from "@/lib/action-types";
import type { OpeningPreviewView } from "@/lib/opening-view";
import { postOpeningAction, previewOpeningAction, skipOpeningAction } from "../actions";
import { OpeningEntriesTable } from "./opening-table";

interface CostRow {
  key: string;
  description: string;
  amount: string;
  date: string;
  paidFromWalletId: string;
  taxCategoryCode: string;
}

type Group = "formationCosts" | "startupCosts";

interface Draft {
  capital: { date: string; amount: string; walletId: string };
  formationCosts: CostRow[];
  startupCosts: CostRow[];
}

/** Rows sent with a request, to put `formationCosts.<n>.<field>` errors back on the right row. */
type SentKeys = Record<Group, string[]>;

const isBlank = (row: CostRow) => row.description.trim() === "" && row.amount.trim() === "";

function toInput(draft: Draft): { input: OpeningInput; keys: SentKeys } {
  const sent = (rows: CostRow[]) => rows.filter((row) => !isBlank(row));
  const line = (row: CostRow) => ({
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidFromWalletId: row.paidFromWalletId,
    taxCategoryCode: row.taxCategoryCode,
  });
  const formation = sent(draft.formationCosts);
  const startup = sent(draft.startupCosts);
  return {
    input: {
      capital: draft.capital,
      formationCosts: formation.map(line),
      startupCosts: startup.map(line),
    },
    keys: {
      formationCosts: formation.map((row) => row.key),
      startupCosts: startup.map((row) => row.key),
    },
  };
}

const GROUPS: readonly { group: Group; title: string; help: string; example: string }[] = [
  {
    group: "formationCosts",
    title: "設立の費用（創立費）",
    help: "登録免許税・定款認証など、会社を作るためにかかった費用",
    example: "例: 登録免許税",
  },
  {
    group: "startupCosts",
    title: "設立後から開業までの費用（開業費）",
    help: "設立してから事業を始めるまでの準備の費用",
    example: "例: 開業前の備品",
  },
];

/**
 * Step 5: 資本金の払込, 創立費 and 開業費 → a preview of the entries → 「登録」 (10 §3). The preview
 * comes from the same builder the registration uses (a Server Action, nothing is written).
 */
export function OpeningStep({
  foundedOn,
  wallets,
  payerOptions,
  taxOptions,
  defaultCapitalWalletId,
  defaultPayerWalletId,
  initialPreview,
}: {
  foundedOn: string;
  wallets: readonly { value: string; label: string }[];
  payerOptions: readonly { value: string; label: string }[];
  taxOptions: readonly { value: string; label: string }[];
  defaultCapitalWalletId: string;
  defaultPayerWalletId: string;
  initialPreview: ActionResult<OpeningPreviewView>;
}) {
  const nextKey = useRef(0);
  const blankRow = (key: string): CostRow => ({
    key,
    description: "",
    amount: "",
    date: foundedOn,
    paidFromWalletId: defaultPayerWalletId,
    taxCategoryCode: "purchase_out",
  });
  const [draft, setDraft] = useState<Draft>(() => ({
    capital: { date: foundedOn, amount: "50,000", walletId: defaultCapitalWalletId },
    formationCosts: [blankRow("formation-0")],
    startupCosts: [blankRow("startup-0")],
  }));
  const [preview, setPreview] = useState<{
    result: ActionResult<OpeningPreviewView>;
    keys: SentKeys;
  }>({
    result: initialPreview,
    keys: { formationCosts: [], startupCosts: [] },
  });
  const [submitted, setSubmitted] = useState<{ error: ActionError; keys: SentKeys } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [previewing, startPreview] = useTransition();
  const [registering, startRegister] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  function change(next: Draft) {
    setDraft(next);
    setSubmitted(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sequence.current += 1;
      const request = sequence.current;
      const { input, keys } = toInput(next);
      startPreview(async () => {
        const result = await previewOpeningAction(input);
        if (request === sequence.current) setPreview({ result, keys });
      });
    }, 400);
  }

  function changeRow(group: Group, key: string, patch: Partial<CostRow>) {
    change({
      ...draft,
      [group]: draft[group].map((row) => (row.key === key ? { ...row, ...patch } : row)),
    });
  }

  function addRow(group: Group) {
    nextKey.current += 1;
    change({ ...draft, [group]: [...draft[group], blankRow(`${group}-new-${nextKey.current}`)] });
  }

  function removeRow(group: Group, key: string) {
    change({ ...draft, [group]: draft[group].filter((row) => row.key !== key) });
  }

  function register() {
    const { input, keys } = toInput(draft);
    startRegister(async () => {
      const result = await postOpeningAction(input);
      if (result && !result.ok) {
        setSubmitted({ error: result, keys });
        setConfirming(false);
      }
    });
  }

  const shownError = submitted?.error ?? (preview.result.ok ? null : preview.result);
  const shownKeys = submitted?.keys ?? preview.keys;
  const capitalError = (field: string) => shownError?.fieldErrors[`capital.${field}`];
  const rowError = (group: Group, key: string, field: string) => {
    const index = shownKeys[group].indexOf(key);
    return index < 0 ? undefined : shownError?.fieldErrors[`${group}.${index}.${field}`];
  };
  const hasFieldError = Boolean(shownError && Object.keys(shownError.fieldErrors).length > 0);
  const view = preview.result.ok ? preview.result.data : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-extrabold">資本金の払込</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="日付" htmlFor="capital-date" error={capitalError("date")}>
            <Input
              id="capital-date"
              type="date"
              value={draft.capital.date}
              onChange={(event) =>
                change({ ...draft, capital: { ...draft.capital, date: event.currentTarget.value } })
              }
            />
          </FormField>
          <FormField label="金額（円）" htmlFor="capital-amount" error={capitalError("amount")}>
            <MoneyInput
              id="capital-amount"
              value={draft.capital.amount}
              onValueChange={(amount) =>
                change({ ...draft, capital: { ...draft.capital, amount } })
              }
            />
          </FormField>
          <FormField label="入金先の口座" htmlFor="capital-wallet" error={capitalError("walletId")}>
            <Select
              id="capital-wallet"
              value={draft.capital.walletId}
              onChange={(event) =>
                change({
                  ...draft,
                  capital: { ...draft.capital, walletId: event.currentTarget.value },
                })
              }
            >
              {wallets.map((wallet) => (
                <option key={wallet.value} value={wallet.value}>
                  {wallet.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      {GROUPS.map(({ group, title, help, example }) => (
        <section key={group} className="flex flex-col gap-3">
          <div>
            <h2 className="text-[15px] font-extrabold">{title}</h2>
            <p className="text-[12px] text-muted">{help}。空の行は登録しません</p>
          </div>
          <ul className="flex flex-col gap-3">
            {draft[group].map((row, index) => {
              const id = `${row.key}`;
              return (
                <li
                  key={row.key}
                  className="rounded-card border border-border bg-surface px-4 py-3.5"
                >
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_120px_150px]">
                    <FormField
                      label="名目"
                      htmlFor={`${id}-description`}
                      error={rowError(group, row.key, "description")}
                    >
                      <Input
                        id={`${id}-description`}
                        value={row.description}
                        placeholder={index === 0 ? example : undefined}
                        onChange={(event) =>
                          changeRow(group, row.key, { description: event.currentTarget.value })
                        }
                      />
                    </FormField>
                    <FormField
                      label="金額（円）"
                      htmlFor={`${id}-amount`}
                      error={rowError(group, row.key, "amount")}
                    >
                      <MoneyInput
                        id={`${id}-amount`}
                        value={row.amount}
                        onValueChange={(amount) => changeRow(group, row.key, { amount })}
                      />
                    </FormField>
                    <FormField
                      label="日付"
                      htmlFor={`${id}-date`}
                      error={rowError(group, row.key, "date")}
                    >
                      <Input
                        id={`${id}-date`}
                        type="date"
                        value={row.date}
                        onChange={(event) =>
                          changeRow(group, row.key, { date: event.currentTarget.value })
                        }
                      />
                    </FormField>
                    <FormField
                      label="支払元"
                      htmlFor={`${id}-payer`}
                      error={rowError(group, row.key, "paidFromWalletId")}
                    >
                      <Select
                        id={`${id}-payer`}
                        value={row.paidFromWalletId}
                        onChange={(event) =>
                          changeRow(group, row.key, { paidFromWalletId: event.currentTarget.value })
                        }
                      >
                        {payerOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField
                      label="税区分"
                      htmlFor={`${id}-tax`}
                      error={rowError(group, row.key, "taxCategoryCode")}
                    >
                      <Select
                        id={`${id}-tax`}
                        value={row.taxCategoryCode}
                        onChange={(event) =>
                          changeRow(group, row.key, { taxCategoryCode: event.currentTarget.value })
                        }
                      >
                        {taxOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <div className="flex items-end justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRow(group, row.key)}
                        aria-label={`${title}の ${index + 1} 行目を消す`}
                      >
                        行を消す
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div>
            <Button variant="ghost" onClick={() => addRow(group)}>
              ＋ 行を追加
            </Button>
          </div>
        </section>
      ))}

      <section className="flex flex-col gap-3" aria-live="polite">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-extrabold">登録される仕訳</h2>
          {previewing ? <span className="text-[12px] text-muted">更新中…</span> : null}
        </div>
        {view ? (
          <OpeningEntriesTable preview={view} />
        ) : (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            入力を直すと仕訳を表示します{shownError ? `（${shownError.error}）` : ""}
          </p>
        )}
        <p className="text-[12px] text-muted">
          仕訳の種類は「開始」、セグメントは「共通」で登録します。登録した仕訳は書き換えられず、直しは取引の訂正（反対仕訳）で行います。
        </p>
      </section>

      {submitted && !hasFieldError ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {submitted.error.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-end gap-2">
        <ActionButton action={skipOpeningAction} label="あとで" variant="ghost" />
        <Button
          variant="primary"
          disabled={!view || previewing || registering}
          onClick={() => setConfirming(true)}
        >
          登録
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="開始仕訳を登録します"
        confirmLabel="登録"
        pending={registering}
        error={submitted?.error.error ?? null}
        onCancel={() => setConfirming(false)}
        onConfirm={register}
      >
        {view ? (
          <>
            <p>
              <span className="num font-bold">{view.entries.length} 件</span>・借方と貸方の合計{" "}
              <span className="num font-bold">{view.debitTotal} 円</span>
            </p>
            <p className="mt-2 text-[13px] text-muted">
              登録した仕訳は書き換えられません。直すときは取引の訂正（反対仕訳）で行います。
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
