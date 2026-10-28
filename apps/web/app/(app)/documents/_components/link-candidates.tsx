"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { linkDocumentAction } from "../actions";

/** A link candidate, formatted on the server. */
export interface CandidateView {
  kind: "wallet_transaction" | "journal_entry";
  id: string;
  /** 2026/11/07 */
  date: string;
  /** 同じ日 / 2 日差 */
  apart: string;
  /** The wallet of a statement line, or 第1期 No. 12 of an entry. */
  where: string;
  description: string;
  /** With 3-digit grouping (a statement line keeps its sign). */
  amount: string;
  /** e.g. 登録済み for a statement line already registered. */
  note: string | null;
}

function CandidateTable({
  label,
  rows,
  linking,
  onLink,
}: {
  label: string;
  rows: readonly CandidateView[];
  linking: string | null;
  onLink: (row: CandidateView) => void;
}) {
  return (
    <div className="mt-2">
      <h3 className="mb-1 text-[12px] font-bold text-muted">{label}</h3>
      <div
        role="table"
        aria-label={`${label}の候補`}
        className="overflow-hidden rounded-card border border-border"
      >
        {rows.map((row) => (
          <div
            key={row.id}
            role="row"
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-3 py-2 last:border-b-0"
          >
            <span role="cell" className="min-w-0">
              <span className="num block text-[12px] text-muted">
                {row.date} · {row.apart} · {row.where}
                {row.note ? ` · ${row.note}` : ""}
              </span>
              <span className="block truncate text-[13px]">{row.description}</span>
            </span>
            <span role="cell" className="flex items-center gap-2">
              <span className="num text-[13px] font-bold">{row.amount}</span>
              <Button
                size="sm"
                variant="primary"
                disabled={linking !== null}
                onClick={() => onLink(row)}
                aria-label={`${row.date} ${row.description} ${row.amount} に紐づける`}
              >
                {linking === row.id ? "処理中…" : "紐づける"}
              </Button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 候補 (13 §4). With an amount: statement lines and entries of the same amount near the date
 * (「同じ金額・近い日付」). Without one: pending statement lines near the date, any amount. 紐づける
 * fills the document's empty date, amount and partner from the other side.
 */
export function LinkCandidates({
  documentId,
  basis,
  walletTransactions,
  journalEntries,
}: {
  documentId: string;
  basis: "amount" | "date";
  walletTransactions: readonly CandidateView[];
  journalEntries: readonly CandidateView[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [linking, setLinking] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function link(row: CandidateView) {
    setLinking(row.id);
    startTransition(async () => {
      const result = await linkDocumentAction({ kind: row.kind, id: row.id, documentId });
      setLinking(null);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast("紐づけました");
      router.refresh();
    });
  }

  const entries = basis === "amount" ? journalEntries : [];
  const none = walletTransactions.length === 0 && entries.length === 0;
  return (
    <section aria-labelledby="document-candidates">
      <h2 id="document-candidates" className="text-[15px] font-extrabold">
        {basis === "amount" ? "同じ金額・近い日付" : "近い日付の未処理の明細"}
      </h2>
      {basis === "date" ? (
        <p className="mt-0.5 text-[12px] text-muted">
          金額を入れると、同じ金額の明細と取引に絞り込めます
        </p>
      ) : null}
      {none ? (
        <p className="mt-2 text-[13px] text-muted">近い日付の候補はありません</p>
      ) : (
        <>
          {walletTransactions.length > 0 ? (
            <CandidateTable
              label="明細"
              rows={walletTransactions}
              linking={linking}
              onLink={link}
            />
          ) : null}
          {entries.length > 0 ? (
            <CandidateTable label="取引" rows={entries} linking={linking} onLink={link} />
          ) : null}
        </>
      )}
    </section>
  );
}
