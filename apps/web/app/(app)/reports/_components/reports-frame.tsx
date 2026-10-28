import type { ReportPeriod, ReportSource } from "@niho-finance/reports";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { fiscalYearLabel } from "../_lib/format";
import { exportHref, type ExtraParams } from "../_lib/query";
import type { ReportTab } from "../_lib/tabs";
import { ConditionForm } from "./condition-form";
import { ReportTabs } from "./report-tabs";

/**
 * The frame of every tab (14-reports §2): 「報告」 with 第 n 期, the conditions, 「CSV」「PDF」 for
 * the tab as it is shown, and the tab row.
 */
export function ReportsFrame({
  tab,
  source,
  period,
  hidden,
  linkParams,
  controls,
  exportParams = {},
  exportable,
  children,
}: {
  tab: ReportTab;
  source: ReportSource;
  period: ReportPeriod;
  /** Tab parameters the condition form keeps (総勘定元帳's account and sub-account). */
  hidden?: ExtraParams;
  /** Tab parameters that are form controls, kept by the 今月 / 今期 / 任意 links (仕訳帳's state). */
  linkParams?: ExtraParams;
  controls?: ReactNode;
  /** Tab parameters of the CSV / PDF links. */
  exportParams?: ExtraParams;
  /** `false` when there is nothing to write (empty report, no account chosen). */
  exportable: boolean;
  children: ReactNode;
}) {
  // Plain links (not next/link): a download must not be prefetched or fetched as a page, or the
  // audit log would record exports nobody asked for.
  const exportLink = (format: "csv" | "pdf", label: string) => (
    <a
      href={exportHref(tab, format, period, exportParams)}
      className={buttonClass({ variant: "secondary", size: "sm" })}
    >
      {label}
    </a>
  );
  return (
    <>
      <PageHeader
        title="報告"
        meta={fiscalYearLabel(period)}
        actions={
          <>
            <ConditionForm
              tab={tab}
              source={source}
              period={period}
              hidden={hidden}
              linkParams={linkParams}
              controls={controls}
            />
            {exportable ? (
              <span className="flex items-center gap-2">
                {exportLink("csv", "CSV")}
                {exportLink("pdf", "PDF")}
              </span>
            ) : null}
          </>
        }
      />
      <ReportTabs current={tab} period={period} />
      {children}
    </>
  );
}
