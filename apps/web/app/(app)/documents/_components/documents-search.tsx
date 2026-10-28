"use client";

import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  isCalendarDate,
  type DocumentTab,
} from "@niho-finance/ledger";
import Form from "next/form";
import Link from "next/link";
import { useEffect, useId, useRef, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";

/** The conditions as the fields show them (what the URL says, even when it did not parse). */
export interface SearchValues {
  tab: DocumentTab;
  from: string;
  to: string;
  amountMin: string;
  amountMax: string;
  partner: string;
  kind: string;
  q: string;
}

interface SearchProps {
  values: SearchValues;
  /** Active partners' names (the datalist of 取引先). */
  partnerNames: readonly string[];
  /** A condition is set: the phone's 「検索の条件」 starts open and 「条件を消す」 shows. */
  narrowed: boolean;
  /** The list without conditions, on the same tab. */
  clearHref: string;
  /** Why the URL's conditions were not used (shown above the fields). */
  error: string | null;
}

const LABEL = "text-[12px] font-bold text-muted";

/** A date sends the form once it is a whole date (or empty), after typing pauses. */
const DATE_DELAY_MS = 600;

function SearchForm({
  values,
  listId,
  narrowed,
  clearHref,
  wide,
}: {
  values: SearchValues;
  listId: string;
  narrowed: boolean;
  clearHref: string;
  /** PC: the fields wrap into 1–2 lines. Phones: one field per line. */
  wide: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function submitDate(event: ChangeEvent<HTMLInputElement>) {
    const { form, value } = event.currentTarget;
    if (timer.current) clearTimeout(timer.current);
    // Typing a year goes through 0002, 0020, 0202 … : wait for a real date.
    if (value !== "" && !(isCalendarDate(value) && value >= "1900-01-01")) return;
    timer.current = setTimeout(() => form?.requestSubmit(), DATE_DELAY_MS);
  }

  const group = wide ? "min-w-0 grow" : "min-w-0";
  return (
    <Form
      action="/documents"
      role="search"
      aria-label="証憑の検索"
      className={wide ? "flex flex-wrap items-end gap-3" : "flex flex-col gap-3"}
    >
      {values.tab !== "inbox" ? <input type="hidden" name="tab" value={values.tab} /> : null}
      <fieldset className={`${group} ${wide ? "basis-[300px]" : ""}`}>
        <legend className={`mb-1 ${LABEL}`}>取引年月日</legend>
        <div className="flex items-center gap-1.5">
          <input
            name="from"
            type="date"
            aria-label="取引年月日の始まり"
            defaultValue={values.from}
            onChange={submitDate}
            className="control min-w-0 flex-1"
          />
          <span aria-hidden="true" className="text-muted">
            〜
          </span>
          <input
            name="to"
            type="date"
            aria-label="取引年月日の終わり"
            defaultValue={values.to}
            onChange={submitDate}
            className="control min-w-0 flex-1"
          />
        </div>
      </fieldset>
      <fieldset className={`${group} ${wide ? "basis-[240px]" : ""}`}>
        <legend className={`mb-1 ${LABEL}`}>金額（円）</legend>
        <div className="flex items-center gap-1.5">
          <MoneyInput
            name="amountMin"
            aria-label="金額の下限"
            placeholder="下限"
            defaultValue={values.amountMin}
            className="min-w-0 flex-1"
          />
          <span aria-hidden="true" className="text-muted">
            〜
          </span>
          <MoneyInput
            name="amountMax"
            aria-label="金額の上限"
            placeholder="上限"
            defaultValue={values.amountMax}
            className="min-w-0 flex-1"
          />
        </div>
      </fieldset>
      <label className={`flex flex-col gap-1 ${group} ${wide ? "basis-[160px]" : ""}`}>
        <span className={LABEL}>種別</span>
        <select
          name="kind"
          defaultValue={values.kind}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="control"
        >
          <option value="">すべて</option>
          {DOCUMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {DOCUMENT_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className={`flex flex-col gap-1 ${group} ${wide ? "basis-[200px]" : ""}`}>
        <span className={LABEL}>取引先</span>
        <input
          name="partner"
          list={listId}
          defaultValue={values.partner}
          placeholder="名前の一部"
          autoComplete="off"
          maxLength={200}
          className="control"
        />
      </label>
      <label className={`flex flex-col gap-1 ${group} ${wide ? "basis-[220px]" : ""}`}>
        <span className={LABEL}>キーワード</span>
        <input
          name="q"
          type="search"
          defaultValue={values.q}
          placeholder="ファイル名・メモ・取引先"
          maxLength={200}
          className="control"
        />
      </label>
      <div className="flex min-h-10 items-center gap-3">
        <Button type="submit" size="sm">
          検索
        </Button>
        {narrowed ? (
          <Link
            href={clearHref}
            className="text-[13px] font-bold whitespace-nowrap text-muted underline underline-offset-4 hover:text-text"
          >
            条件を消す
          </Link>
        ) : null}
      </div>
    </Form>
  );
}

/**
 * 検索 of the list (13 §3.2): a GET form, so the URL is the truth and a reload or a shared link
 * shows the same rows. The select and the dates send it when they change; 「検索」 sends it too.
 * PC shows the fields in 1–2 lines; phones fold them under 「検索の条件」 (open while narrowed).
 * The two forms are separate elements: only the visible one is ever sent.
 */
export function DocumentsSearch({ values, partnerNames, narrowed, clearHref, error }: SearchProps) {
  const listId = useId();
  return (
    <div className="mb-4">
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}（条件を外して一覧を表示しています）
        </p>
      ) : null}
      <datalist id={listId}>
        {partnerNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="hidden md:block">
        <SearchForm
          values={values}
          listId={listId}
          narrowed={narrowed}
          clearHref={clearHref}
          wide
        />
      </div>
      <details open={narrowed} className="group rounded-card border border-border md:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-[14px] font-bold [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted group-open:rotate-90">
            ›
          </span>
          検索の条件
          {narrowed ? (
            <span className="text-[12px] font-normal text-muted">（条件あり）</span>
          ) : null}
        </summary>
        <div className="border-t border-border px-3.5 py-3">
          <SearchForm
            values={values}
            listId={listId}
            narrowed={narrowed}
            clearHref={clearHref}
            wide={false}
          />
        </div>
      </details>
    </div>
  );
}
