import type { ReportFrameSource } from "@niho-finance/db";
import type { ReportPeriod } from "@niho-finance/reports";
import { Suspense, type ReactNode } from "react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ButtonsSkeleton, ContentSkeleton } from "@/components/ui/skeleton";
import { fiscalYearLabel } from "../_lib/format";
import { exportHref, type ExtraParams } from "../_lib/query";
import type { ReportTab } from "../_lib/tabs";
import { ConditionForm } from "./condition-form";
import { ReportTabs } from "./report-tabs";

/** The CSV / PDF links once the report says whether there is anything to write. */
async function WhenExportable({
  exportable,
  children,
}: {
  exportable: Promise<boolean>;
  children: ReactNode;
}) {
  return (await exportable) ? children : null;
}

/**
 * The frame of every tab (14-reports §2): 「報告」 with 第 n 期, the conditions, 「CSV」「PDF」 for
 * the tab as it is shown, and the tab row. With `streamKey` the frame shows at once and the tab's
 * content (and the CSV / PDF links, which depend on it) after a skeleton (05-ui-ux §3.1).
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
  conditions = true,
  segmentSwitch,
  meta,
  streamKey,
  children,
}: {
  tab: ReportTab;
  source: ReportFrameSource;
  period: ReportPeriod;
  /** Tab parameters the condition form keeps (総勘定元帳's account and sub-account). */
  hidden?: ExtraParams;
  /** Tab parameters that are form controls, kept by the 今月 / 今期 / 任意 links (仕訳帳's state). */
  linkParams?: ExtraParams;
  controls?: ReactNode;
  /** Tab parameters of the CSV / PDF links. */
  exportParams?: ExtraParams;
  /**
   * `false` when there is nothing to write (empty report, no account chosen). A promise when the
   * content is streamed: the links come with it.
   */
  exportable: boolean | Promise<boolean>;
  /** `false`: the tab takes no conditions (資金繰り, 21 §6) and the form is left out. */
  conditions?: boolean;
  /** Overrides whether the segment switch is shown (集計's segment axis hides it). */
  segmentSwitch?: boolean;
  /** Replaces 「第 n 期 …」 next to the title (資金繰り shows its 90 days). */
  meta?: ReactNode;
  /**
   * The conditions of the URL when `children` is streamed (`conditionsKey`): new conditions start
   * the content and the links over from their skeleton, never the old numbers under them.
   */
  streamKey?: string;
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
  const exportLinks = (
    <span className="flex items-center gap-2">
      {exportLink("csv", "CSV")}
      {exportLink("pdf", "PDF")}
    </span>
  );
  let exports: ReactNode = exportable === true ? exportLinks : null;
  if (typeof exportable !== "boolean") {
    exports = (
      <Suspense key={streamKey} fallback={<ButtonsSkeleton count={2} width="w-[3.25rem]" />}>
        <WhenExportable exportable={exportable}>{exportLinks}</WhenExportable>
      </Suspense>
    );
  }
  return (
    <>
      <PageHeader
        title="報告"
        meta={meta ?? fiscalYearLabel(period)}
        actions={
          <>
            {conditions ? (
              <ConditionForm
                tab={tab}
                source={source}
                period={period}
                hidden={hidden}
                linkParams={linkParams}
                controls={controls}
                segmentSwitch={segmentSwitch}
              />
            ) : null}
            {exports}
          </>
        }
      />
      <ReportTabs current={tab} period={period} />
      {streamKey === undefined ? (
        children
      ) : (
        <Suspense key={streamKey} fallback={<ContentSkeleton />}>
          {children}
        </Suspense>
      )}
    </>
  );
}
