import {
  compareSegments,
  PERIOD_PRESET_LABELS,
  PERIOD_PRESETS,
  segmentLabels,
} from "@niho-finance/reports";
import type { ReportPeriod, ReportSource } from "@niho-finance/reports";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { reportHref, withPreset, type ExtraParams } from "../_lib/query";
import { SEGMENT_TABS, type ReportTab } from "../_lib/tabs";
import { AutoSubmitSelect } from "./auto-submit-select";

export const COMPACT_CONTROL = "w-auto min-h-8 py-1 text-[13px]";

/**
 * The conditions of every tab as a GET form (14-reports §2): 期 (only with 2 or more years),
 * 今月 / 今期 / 任意 (任意 shows the dates), セグメント. Selects submit on change; 「表示」 submits
 * the dates, and every field without JavaScript.
 */
export function ConditionForm({
  tab,
  source,
  period,
  hidden = {},
  linkParams = {},
  controls,
}: {
  tab: ReportTab;
  source: ReportSource;
  period: ReportPeriod;
  /** Tab parameters kept when the conditions change (総勘定元帳's account …). */
  hidden?: ExtraParams;
  /** Tab parameters that are controls of the form and kept by the 今月 / 今期 / 任意 links. */
  linkParams?: ExtraParams;
  /** Tab controls inside the form (仕訳帳's state). */
  controls?: ReactNode;
}) {
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const segments = source.segments.filter((segment) => segment.isActive).sort(compareSegments);
  const labels = segmentLabels(segments);
  const showSegment = SEGMENT_TABS.has(tab);
  const custom = period.preset === "custom";
  const keep = Object.entries(hidden).filter(
    (entry): entry is [string, string | number] =>
      entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
  );
  const presetExtra = { ...linkParams, ...Object.fromEntries(keep) };

  return (
    <form
      method="get"
      action={`/reports/${tab}`}
      aria-label="表示の条件"
      className="flex flex-wrap items-center gap-2"
    >
      {years.length > 1 ? (
        <AutoSubmitSelect
          name="fy"
          aria-label="会計期間"
          defaultValue={String(period.fiscalYear.no)}
          className={COMPACT_CONTROL}
        >
          {years.map((year) => (
            <option key={year.id} value={year.no}>
              第{year.no}期
            </option>
          ))}
        </AutoSubmitSelect>
      ) : (
        <input type="hidden" name="fy" value={period.fiscalYear.no} />
      )}

      <input type="hidden" name="period" value={period.preset} />
      <div
        role="group"
        aria-label="期間"
        className="inline-flex rounded-[10px] border border-border bg-surface p-[3px]"
      >
        {PERIOD_PRESETS.map((preset) => {
          const active = preset === period.preset;
          return (
            <Link
              key={preset}
              href={reportHref(tab, withPreset(period, preset), presetExtra)}
              aria-current={active ? "true" : undefined}
              className={`rounded-[7px] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap ${
                active ? "bg-text text-white" : "text-muted hover:text-text"
              }`}
            >
              {PERIOD_PRESET_LABELS[preset]}
            </Link>
          );
        })}
      </div>

      {custom ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <Input
            type="date"
            name="from"
            aria-label="開始日"
            defaultValue={period.from}
            min={period.fiscalYear.startDate}
            max={period.fiscalYear.endDate}
            className={COMPACT_CONTROL}
          />
          <span aria-hidden="true" className="text-muted">
            –
          </span>
          <Input
            type="date"
            name="to"
            aria-label="終了日"
            defaultValue={period.to}
            min={period.fiscalYear.startDate}
            max={period.fiscalYear.endDate}
            className={COMPACT_CONTROL}
          />
        </span>
      ) : null}

      {showSegment ? (
        <AutoSubmitSelect
          name="segment"
          aria-label="セグメント"
          defaultValue={period.segmentId ?? ""}
          className={COMPACT_CONTROL}
        >
          <option value="">全社</option>
          {segments.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {labels.get(segment.id) ?? segment.name}
            </option>
          ))}
          {period.segmentId && !segments.some((segment) => segment.id === period.segmentId) ? (
            <option value={period.segmentId}>
              {source.segments.find((segment) => segment.id === period.segmentId)?.name}
            </option>
          ) : null}
        </AutoSubmitSelect>
      ) : period.segmentId ? (
        <input type="hidden" name="segment" value={period.segmentId} />
      ) : null}

      {controls}
      {keep.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {custom ? (
        <Button type="submit" size="sm">
          表示
        </Button>
      ) : (
        <noscript>
          <Button type="submit" size="sm">
            表示
          </Button>
        </noscript>
      )}
    </form>
  );
}
