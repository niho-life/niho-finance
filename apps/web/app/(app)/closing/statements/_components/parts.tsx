import type { FinancialStatementsFiscalYear } from "@niho-finance/reports";
import type { ReactNode } from "react";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/** A section of the page: a noun-phrase heading, muted notes, and downloads on the right. */
export function Section({
  id,
  title,
  aside,
  actions,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-4 pb-8">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`${id}-heading`} className="text-[16px] font-extrabold">
            {title}
          </h2>
          {aside ? <span className="text-[12px] text-muted">{aside}</span> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A table inside a section (貸借対照表, 損益計算書 …) with its 「PDF」 at the top right. */
export function SubSection({
  title,
  aside,
  actions,
  children,
}: {
  title: string;
  aside?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-bold">{title}</h3>
          {aside ? <span className="text-[12px] text-muted">{aside}</span> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

/** The year select of the header (only with 2 or more years): a GET form sent on change. */
export function FiscalYearSelect({
  action,
  years,
  current,
}: {
  action: string;
  years: readonly FinancialStatementsFiscalYear[];
  current: FinancialStatementsFiscalYear;
}) {
  if (years.length < 2) return null;
  return (
    <form method="get" action={action} className="flex items-center gap-2">
      <AutoSubmitSelect
        name="fy"
        aria-label="会計期間"
        defaultValue={String(current.no)}
        className="w-auto min-h-8 py-1 text-[13px]"
      >
        {years.map((year) => (
          <option key={year.id} value={year.no}>
            第{year.no}期
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

/** No fiscal year at all (the setup creates the first one, so only in odd states). */
export function NoFiscalYear({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title="会計期間がありません"
        description="会計期間を作ると、決算書を表示します。"
        action={
          <ButtonLink href="/settings/fiscal-years" size="sm">
            会計期間を作る
          </ButtonLink>
        }
      />
    </>
  );
}

/** A problem with the request (a download that could not be made): warn, not red. */
export function AlertBand({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="mb-4 rounded-card bg-warn-soft px-4 py-3 text-[14px] text-warn">
      {children}
    </div>
  );
}
