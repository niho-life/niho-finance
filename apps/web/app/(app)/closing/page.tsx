import {
  closingQuerySchema,
  findClosingYear,
  loadEntryFormOptions,
  loadYearEndBalances,
  loadYearEndChecklist,
  type ClosingYearOption,
  type YearEndChecklist,
  type YearEndStep,
} from "@niho-finance/db";
import {
  CORPORATE_SEGMENT_CODE,
  DEPRECIATION_METHOD_LABELS,
  displayDate,
  FISCAL_YEAR_STATUS_LABELS,
  formatYen,
  formatYenInput,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDateTime, formatPeriod } from "@/lib/format";
import { AccrualSheet, type AccrualAccountOption } from "./_components/accrual-sheet";
import { CheckToggle } from "./_components/check-toggle";
import { CloseYearButton } from "./_components/close-year-button";
import { ConsumptionTaxSheet } from "./_components/consumption-tax-sheet";
import { CorporateTaxForm } from "./_components/corporate-tax-form";
import {
  DepreciationTables,
  PostDepreciationButton,
  type DeferredView,
  type DepreciationAssetView,
  type StepMode,
} from "./_components/depreciation-step";
import { Band, Facts, Note } from "./_components/parts";
import {
  AccrualsDetails,
  AdjustingEntries,
  BalancesDetails,
  ClosingBalances,
  ConsumptionTaxDetails,
  CorporateTaxDetails,
} from "./_components/step-details";
import { StepItem } from "./_components/step-item";
import {
  CancelYearEndButton,
  ReopenYearButton,
  StartYearEndButton,
  type TransitionYear,
} from "./_components/year-end-transitions";

export const metadata: Metadata = { title: "決算" };

/** The year select of the header (GET, sent on change; 表示 without JS). */
function YearSelect({ years, current }: { years: readonly ClosingYearOption[]; current: number }) {
  return (
    <form method="get" action="/closing" className="flex items-center gap-2">
      <AutoSubmitSelect
        name="year"
        aria-label="会計期間"
        defaultValue={String(current)}
        className="min-h-8 w-auto py-1 text-[13px]"
      >
        {years.map((year) => (
          <option key={year.id} value={year.no}>
            第 {year.no} 期
          </option>
        ))}
      </AutoSubmitSelect>
      <noscript>
        <Button type="submit" size="sm">
          表示
        </Button>
      </noscript>
    </form>
  );
}

/** The state band and its transition (16 §3). */
function StateBand({ checklist }: { checklist: YearEndChecklist }) {
  const year = checklist.fiscalYear;
  const transitionYear: TransitionYear = {
    id: year.id,
    no: year.no,
    status: year.status,
    endDate: year.endDate,
    lockedThrough: year.lockedThrough,
  };
  if (year.status === "closing") {
    return (
      <Band actions={<CancelYearEndButton year={transitionYear} />}>
        決算整理中です。通常の仕訳は登録できません。
      </Band>
    );
  }
  if (year.status === "closed") {
    const nextClosed = checklist.next?.status === "closed";
    return (
      <Band actions={nextClosed ? undefined : <ReopenYearButton year={transitionYear} />}>
        締め済みです。第 {year.no} 期の仕訳は登録・取消・訂正できません。
        {nextClosed
          ? `第 ${checklist.next?.no ?? year.no + 1} 期が締め済みのため、締めは戻せません。`
          : "直すには締めを戻します。"}
      </Band>
    );
  }
  if (checklist.canStart) {
    return (
      <Band
        actions={
          <StartYearEndButton
            year={transitionYear}
            normalEntryCount={checklist.normalEntryCount}
            lockedThroughAfterStart={checklist.lockedThroughAfterStart}
          />
        }
      >
        期末を過ぎました。上から確かめて、決算整理を始めます。
      </Band>
    );
  }
  return <Band>{checklist.startBlockedReason ?? "まだ決算整理を始められません。"}</Band>;
}

function checkRecord(record: { at: string; actor: string } | null) {
  return record ? { actor: record.actor, at: formatDateTime(record.at) } : null;
}

const WAIT_FOR_START = "決算整理を始めると計上できます";

function Waiting({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-muted">{children}</span>;
}

/** 決算 (16 §3): the checklist of 第 n 期, its state and the transitions. */
export default async function ClosingPage({ searchParams }: PageProps<"/closing">) {
  const query = closingQuerySchema.parse(await searchParams);
  const prisma = await db();
  const found = await findClosingYear(prisma, query.year);
  if (!found) {
    return (
      <>
        <PageHeader title="決算" />
        <EmptyState
          title="会計期間がありません"
          description="設定 › 会計期間 で期を作ると、決算のチェックリストが出ます"
          action={<ButtonLink href="/settings/fiscal-years">会計期間を開く</ButtonLink>}
        />
      </>
    );
  }

  const checklist = await loadYearEndChecklist(prisma, found.selected.id);
  const year = checklist.fiscalYear;
  const mode: StepMode =
    year.status === "closing" ? "closing" : year.status === "closed" ? "closed" : "open";
  const readOnly = mode === "closed";
  const balances = mode === "closed" ? await loadYearEndBalances(prisma, year.id) : null;
  const formOptions = mode === "closing" ? await loadEntryFormOptions(prisma) : null;
  const endDate = displayDate(year.endDate);
  const openKey = checklist.steps.find((step) => step.state === "todo")?.key ?? null;

  const assets: DepreciationAssetView[] = checklist.depreciation.map((row) => ({
    assetId: row.assetId,
    name: row.name,
    methodLabel: DEPRECIATION_METHOD_LABELS[row.method],
    amount: formatYen(row.amount),
    entries: row.entries.map((entry) => ({ id: entry.id, no: entry.no })),
  }));
  const deferred: DeferredView[] = checklist.deferred.map((row) => ({
    accountId: row.accountId,
    name: row.accountName,
    amounts: {
      five_years: { text: formatYen(row.fiveYears), zero: row.fiveYears <= 0n },
      full: { text: formatYen(row.full), zero: row.full <= 0n },
    },
    postedAmount: formatYen(row.amortizedThisYear),
    balance: formatYen(row.balance),
    posted: row.posted ? { id: row.posted.id, no: row.posted.no } : null,
    finished: !row.posted && row.cost - row.amortizedBefore <= 0n,
  }));
  const unposted = checklist.depreciation.filter(
    (row) => row.amount > 0n && row.entries.length === 0,
  );

  const accrualAccounts: AccrualAccountOption[] = (formOptions?.accounts ?? [])
    .filter(
      (account) => account.isActive && (account.kind === "expense" || account.kind === "revenue"),
    )
    .map((account) => ({
      id: account.id,
      label: `${account.code} ${account.name}`,
      kind: account.kind === "revenue" ? "revenue" : "expense",
      defaultSegmentId: account.defaultSegmentId,
    }));
  const segments = (formOptions?.segments ?? []).filter((segment) => segment.isActive);
  const corporateSegmentId =
    segments.find((segment) => segment.code === CORPORATE_SEGMENT_CODE)?.id ?? null;

  const tax = checklist.consumptionTax;
  const corporate = checklist.corporateTax;
  const netIncome = checklist.closing.netIncome;

  function stepParts(step: YearEndStep): { details?: ReactNode; actions?: ReactNode } {
    switch (step.key) {
      case "balances":
        return {
          details: <BalancesDetails wallets={checklist.wallets} endDate={endDate} />,
          actions: (
            <CheckToggle
              fiscalYearId={year.id}
              checkKey="balances"
              record={checkRecord(checklist.checks.balances)}
              label="照合した"
              doneText="照合しました"
              subject="残高の照合"
              readOnly={readOnly}
            />
          ),
        };
      case "depreciation":
        return {
          details: (
            <DepreciationTables
              fiscalYearId={year.id}
              endDate={endDate}
              mode={mode}
              assets={assets}
              deferred={deferred}
            />
          ),
          actions: (
            <>
              {mode === "closing" && unposted.length > 0 ? (
                <PostDepreciationButton
                  fiscalYearId={year.id}
                  endDate={endDate}
                  count={unposted.length}
                  total={formatYen(unposted.reduce((sum, row) => sum + row.amount, 0n))}
                />
              ) : null}
              <ButtonLink href="/closing/assets" variant="secondary" size="sm">
                固定資産台帳
              </ButtonLink>
            </>
          ),
        };
      case "accruals":
        return {
          details: <AccrualsDetails rows={checklist.accruals.entries} readOnly={readOnly} />,
          actions: (
            <>
              {mode === "closing" ? (
                <AccrualSheet
                  fiscalYearId={year.id}
                  endDate={endDate}
                  accounts={accrualAccounts}
                  segments={segments.map((segment) => ({ id: segment.id, name: segment.name }))}
                  corporateSegmentId={corporateSegmentId}
                  reversalAvailable={checklist.accruals.reversalAvailable}
                  reversalBlockedReason={checklist.accruals.reversalBlockedReason}
                  nextStartDate={checklist.next ? displayDate(checklist.next.startDate) : null}
                  hasSupplies={checklist.accruals.suppliesAccount !== null}
                />
              ) : mode === "open" ? (
                <Waiting>決算整理を始めると登録できます</Waiting>
              ) : null}
              <CheckToggle
                fiscalYearId={year.id}
                checkKey="accruals"
                record={checkRecord(checklist.checks.accruals)}
                label="確認した"
                doneText="確認しました"
                subject="前払・未払"
                readOnly={readOnly}
              />
            </>
          ),
        };
      case "consumption_tax":
        if (!tax.applicable) return {};
        return {
          details: <ConsumptionTaxDetails tax={tax} readOnly={readOnly} />,
          actions:
            mode === "closing" && !tax.posted ? (
              <ConsumptionTaxSheet
                fiscalYearId={year.id}
                endDate={endDate}
                exclusive={tax.accountingMethod === "tax_exclusive"}
                outputTax={formatYen(tax.outputTaxBalance)}
                inputTax={formatYen(tax.inputTaxBalance)}
                suggested={tax.suggestedPayable === 0n ? "" : formatYenInput(tax.suggestedPayable)}
              />
            ) : mode === "open" ? (
              <Waiting>{WAIT_FOR_START}</Waiting>
            ) : undefined,
        };
      case "corporate_tax":
        return {
          details: <CorporateTaxDetails summary={corporate} readOnly={readOnly} />,
          actions:
            mode === "closing" && !corporate.posted ? (
              <CorporateTaxForm
                fiscalYearId={year.id}
                endDate={endDate}
                estimate={formatYen(corporate.estimate.total)}
                booked={formatYen(corporate.booked)}
                suggested={corporate.suggested === 0n ? "" : formatYenInput(corporate.suggested)}
              />
            ) : mode === "open" ? (
              <Waiting>{WAIT_FOR_START}</Waiting>
            ) : undefined,
        };
      case "closing":
        if (balances) return { details: <ClosingBalances balances={balances} /> };
        if (mode === "open") {
          return { details: <Note>決算整理を始めてから締めます。</Note> };
        }
        return {
          details: (
            <>
              <Facts
                label="締めの影響"
                items={[
                  {
                    label: netIncome < 0n ? "当期純損失（円）" : "当期純利益（円）",
                    value: formatYen(netIncome < 0n ? -netIncome : netIncome),
                    strong: true,
                  },
                ]}
              />
              <Note>
                締めると、当期純利益を決算振替で繰越利益剰余金に振り替え、第 {year.no}{" "}
                期の仕訳はすべて読み取り専用になります。翌期の開始残高は仕訳から導きます。
              </Note>
            </>
          ),
          actions: (
            <CloseYearButton
              fiscalYearId={year.id}
              no={year.no}
              netIncome={formatYen(netIncome < 0n ? -netIncome : netIncome)}
              isLoss={netIncome < 0n}
              warnings={checklist.closing.warnings}
            />
          ),
        };
      case "statements":
      case "documents":
      case "statements_report":
      case "export":
        // 準備中 (S5, S6, #15): the summary says why; no entry point yet.
        return {};
    }
  }

  return (
    <>
      <PageHeader
        title="決算"
        meta={`第 ${year.no} 期 ${formatPeriod(year.startDate, year.endDate)} · ${FISCAL_YEAR_STATUS_LABELS[year.status]}`}
        actions={
          <>
            {found.years.length > 1 ? <YearSelect years={found.years} current={year.no} /> : null}
            <ButtonLink href="/closing/assets" variant="secondary" size="sm">
              固定資産台帳
            </ButtonLink>
          </>
        }
      />
      <StateBand checklist={checklist} />
      <ol aria-label={`第 ${year.no} 期の決算の項目`} className="mt-4">
        {checklist.steps.map((step) => {
          const parts = stepParts(step);
          return (
            <StepItem
              key={step.key}
              step={step}
              open={step.key === openKey}
              details={parts.details}
              actions={parts.actions}
            />
          );
        })}
      </ol>
      {checklist.adjustingEntries.length > 0 || mode === "closing" ? (
        <AdjustingEntries entries={checklist.adjustingEntries} readOnly={readOnly} />
      ) : null}
    </>
  );
}
