"use client";

import {
  DEFERRED_AMORTIZATION_MODE_LABELS,
  DEFERRED_AMORTIZATION_MODES,
  type DeferredAmortizationMode,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { entryNo } from "@/lib/format";
import { postDeferredAmortizationAction, postDepreciationAction } from "../actions";
import { VoidYearEndEntryButton } from "./void-year-end-entry-button";

/** open: amounts only. closing: 計上 and 取り消す. closed: read only. */
export type StepMode = "open" | "closing" | "closed";

interface EntryView {
  id: string;
  no: number;
}

export interface DepreciationAssetView {
  assetId: string;
  name: string;
  methodLabel: string;
  /** The year's amount, formatted. */
  amount: string;
  entries: EntryView[];
}

export interface DeferredView {
  accountId: string;
  name: string;
  /** The amount for each choice, formatted, and whether it is 0. */
  amounts: Record<DeferredAmortizationMode, { text: string; zero: boolean }>;
  /** Amortized this year (the entry in force), formatted. */
  postedAmount: string;
  balance: string;
  posted: EntryView | null;
  /** Nothing left to amortize (and nothing posted this year). */
  finished: boolean;
}

const ASSET_COLUMNS = {
  columns: "minmax(0,1.4fr) minmax(0,1fr) 112px minmax(0,1.2fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

const DEFERRED_COLUMNS = {
  columns: "minmax(0,1fr) 112px 112px minmax(0,1.5fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function PostedState({ entries, mode }: { entries: readonly EntryView[]; mode: StepMode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[13px]">計上済み</span>
      {entries.map((entry) => (
        <span key={entry.id} className="inline-flex items-center gap-1">
          <Link
            href={`/entries/${entry.id}`}
            className="num text-[13px] font-bold whitespace-nowrap underline underline-offset-4"
          >
            {entryNo(entry.no)}
          </Link>
          {mode !== "closed" ? <VoidYearEndEntryButton entryId={entry.id} no={entry.no} /> : null}
        </span>
      ))}
    </span>
  );
}

/** 減価償却 (§4) and 繰延資産 (§6) of the year: the amounts, what is posted, 計上 and 取り消す. */
export function DepreciationTables({
  fiscalYearId,
  endDate,
  mode,
  assets,
  deferred,
}: {
  fiscalYearId: string;
  /** The year's last day, formatted (the entries' date). */
  endDate: string;
  mode: StepMode;
  assets: readonly DepreciationAssetView[];
  deferred: readonly DeferredView[];
}) {
  return (
    <>
      {assets.length === 0 ? (
        <p className="text-[13px] text-muted">当期に償却する固定資産はありません。</p>
      ) : (
        <Table label="減価償却">
          <TableHead {...ASSET_COLUMNS}>
            <Th>固定資産</Th>
            <Th sm="hide">償却方法</Th>
            <Th align="right">当期の額（円）</Th>
            <Th>状態</Th>
          </TableHead>
          {assets.map((asset) => (
            <TableRow key={asset.assetId} {...ASSET_COLUMNS}>
              <Td>
                <Link
                  href={`/closing/assets/${asset.assetId}`}
                  className="font-semibold break-words underline-offset-4 hover:underline"
                >
                  {asset.name}
                </Link>
                <span className="block text-[12px] text-muted md:hidden">{asset.methodLabel}</span>
              </Td>
              <Td sm="hide" className="text-[13px]">
                {asset.methodLabel}
              </Td>
              <Td align="right" className="font-bold">
                {asset.amount}
              </Td>
              <Td sm="full">
                {asset.entries.length > 0 ? (
                  <PostedState entries={asset.entries} mode={mode} />
                ) : (
                  <span className="text-[13px] text-muted">
                    {mode === "closed" ? "計上なし" : "未計上"}
                  </span>
                )}
              </Td>
            </TableRow>
          ))}
        </Table>
      )}
      {deferred.length > 0 ? (
        <Table label="繰延資産の償却">
          <TableHead {...DEFERRED_COLUMNS}>
            <Th>繰延資産</Th>
            <Th align="right">当期の額（円）</Th>
            <Th align="right" sm="hide">
              残高（円）
            </Th>
            <Th>状態</Th>
          </TableHead>
          {deferred.map((row) => (
            <DeferredRow
              key={row.accountId}
              row={row}
              mode={mode}
              fiscalYearId={fiscalYearId}
              endDate={endDate}
            />
          ))}
        </Table>
      ) : null}
      {deferred.length > 0 ? (
        <p className="text-[12px] text-muted">
          繰延資産（創立費・開業費）は 5
          年で均等に償却するか、残高の全額を償却するかを期ごとに選べます。税務は任意償却のため、どちらも損金になります。
        </p>
      ) : null}
      {mode === "open" && (assets.length > 0 || deferred.length > 0) ? (
        <p className="text-[13px] font-bold">決算整理を始めると計上できます。</p>
      ) : null}
    </>
  );
}

function DeferredRow({
  row,
  mode,
  fiscalYearId,
  endDate,
}: {
  row: DeferredView;
  mode: StepMode;
  fiscalYearId: string;
  endDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [choice, setChoice] = useState<DeferredAmortizationMode>("five_years");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const amount = row.amounts[choice];

  function post() {
    startTransition(async () => {
      const result = await postDeferredAmortizationAction(fiscalYearId, {
        accountId: row.accountId,
        mode: choice,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      toast(`${row.name}の償却を計上しました（${entryNo(result.data.no)}）`);
      router.refresh();
    });
  }

  const shown = row.posted ? row.postedAmount : row.finished ? "—" : amount.text;

  return (
    <TableRow {...DEFERRED_COLUMNS}>
      <Td className="font-semibold break-words">{row.name}</Td>
      <Td align="right" className="font-bold">
        {shown}
      </Td>
      <Td align="right" sm="hide">
        {row.balance}
      </Td>
      <Td sm="full">
        {row.posted ? (
          <PostedState entries={[row.posted]} mode={mode} />
        ) : row.finished ? (
          <span className="text-[13px] text-muted">償却済み</span>
        ) : mode === "closing" ? (
          <span className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`${row.name}の償却の額`}
              className="cell-input w-auto"
              value={choice}
              onChange={(event) => {
                setChoice(event.currentTarget.value as DeferredAmortizationMode);
                setError(null);
              }}
            >
              {DEFERRED_AMORTIZATION_MODES.map((option) => (
                <option key={option} value={option}>
                  {DEFERRED_AMORTIZATION_MODE_LABELS[option]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={amount.zero}
              aria-label={`${row.name}の償却を計上`}
              onClick={() => setConfirming(true)}
            >
              計上
            </Button>
            {amount.zero ? (
              <span className="text-[12px] text-muted">
                この選び方では当期に償却する額がありません
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-[13px] text-muted">
            {mode === "closed" ? "計上なし" : "未計上（5 年）"}
          </span>
        )}
        {error && !confirming ? (
          <p role="alert" className="mt-1 text-[12px] font-bold text-danger">
            {error}
          </p>
        ) : null}
      </Td>
      <ConfirmDialog
        open={confirming}
        title={`${row.name}の償却を計上します`}
        confirmLabel="計上"
        pending={pending}
        error={confirming ? error : null}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={post}
      >
        <p>
          {DEFERRED_AMORTIZATION_MODE_LABELS[choice]}の額{" "}
          <span className="num font-bold">{amount.text} 円</span> を、期末日 {endDate}{" "}
          付の決算整理仕訳で計上します。
        </p>
        <p className="mt-2 text-[13px] text-muted">
          借方 {row.name}償却 / 貸方 {row.name}。取り消すと計上し直せます。
        </p>
      </ConfirmDialog>
    </TableRow>
  );
}

/** 「減価償却を計上」: every asset with an amount and no entry yet, with the count and the total. */
export function PostDepreciationButton({
  fiscalYearId,
  endDate,
  count,
  total,
}: {
  fiscalYearId: string;
  endDate: string;
  count: number;
  /** Formatted. */
  total: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function post() {
    startTransition(async () => {
      const result = await postDepreciationAction(fiscalYearId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      toast(`減価償却 ${result.data.count} 件・${result.data.total} 円を計上しました`);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
        減価償却を計上
      </Button>
      <ConfirmDialog
        open={confirming}
        title="減価償却を計上します"
        confirmLabel="計上"
        pending={pending}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={post}
      >
        <p>
          固定資産 <span className="num font-bold">{count} 件</span>・合計{" "}
          <span className="num font-bold">{total} 円</span> を、期末日 {endDate} 付で資産ごとに 1
          件ずつ計上します。
        </p>
        <p className="mt-2 text-[13px] text-muted">
          借方 減価償却費 / 貸方
          減価償却累計額（即時償却・一括償却は資産の科目）。取り消すと計上し直せます。
        </p>
      </ConfirmDialog>
    </>
  );
}
