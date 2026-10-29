import {
  loadReportEntries,
  loadReportFrameSource,
  todayInJapan,
  type ReportFrameSource,
} from "@niho-finance/db";
import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import {
  isBreakdownAxis,
  isBreakdownSide,
  isBreakdownSort,
  isBreakdownTop,
  isJournalStatusFilter,
  isPeriodPreset,
  NONE_KEY,
  periodSearchParams,
  resolveReportPeriod,
  type BreakdownAxis,
  type BreakdownSide,
  type BreakdownSort,
  type BreakdownTop,
  type JournalStatusFilter,
  type ReportPeriod,
  type ReportQuery,
  type ReportSource,
} from "@niho-finance/reports";
import { cache } from "react";
import { db } from "@/lib/data";
import type { ExportFormat, ReportTab } from "./tabs";

/** What `searchParams` of a page (or `URLSearchParams` of a route) gives. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** 集計's conditions (14-reports §15). */
export interface BreakdownParams {
  axis: BreakdownAxis;
  side: BreakdownSide;
  top: BreakdownTop;
  sort: BreakdownSort;
}

export const BREAKDOWN_DEFAULTS: BreakdownParams = {
  axis: "partner",
  side: "revenue",
  top: "10",
  sort: "amount",
};

/** The URL of a report, parsed (14-reports §1). Unknown or malformed values are dropped. */
export interface ReportParams {
  query: ReportQuery;
  /** 仕訳帳: the page (1-based). */
  page: number;
  /** 仕訳帳: すべて / 登録済みだけ. */
  status: JournalStatusFilter;
  /** 総勘定元帳: the account and, optionally, one of its sub-accounts. */
  account: string | null;
  sub: string | null;
  /** 集計 and 総勘定元帳 (§15.3): an existing partner id or `none` (取引先なし). */
  partner: string | null;
  /** 集計 and 総勘定元帳: an existing tag id or `none` (タグなし). */
  tag: string | null;
  breakdown: BreakdownParams;
  /** 月次推移: 前年同月 (`compare=prior`, §15.6). */
  comparePrior: boolean;
}

function first(value: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function searchParamsRecord(params: URLSearchParams): RawSearchParams {
  const record: RawSearchParams = {};
  for (const key of new Set(params.keys())) record[key] = params.getAll(key);
  return record;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

function calendarDate(value: string | undefined): CalendarDate | null {
  return isCalendarDate(value) ? value : null;
}

/** The URL's conditions as one string: a tab's streamed part starts over when it changes. */
export function conditionsKey(raw: RawSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item);
    }
  }
  return params.toString();
}

export function parseReportParams(raw: RawSearchParams, source: ReportFrameSource): ReportParams {
  const period = first(raw.period);
  const segment = first(raw.segment);
  const status = first(raw.status);
  const account = first(raw.account);
  const sub = first(raw.sub);
  const accountId =
    account && source.accounts.some((candidate) => candidate.id === account) ? account : null;
  const subAccountId =
    accountId &&
    sub &&
    source.subAccounts.some(
      (candidate) => candidate.id === sub && candidate.accountId === accountId,
    )
      ? sub
      : null;
  const partner = first(raw.partner);
  const tag = first(raw.tag);
  const axis = first(raw.axis);
  const side = first(raw.side);
  const top = first(raw.top);
  const sort = first(raw.sort);
  return {
    query: {
      fy: positiveInteger(first(raw.fy)),
      period: isPeriodPreset(period) ? period : null,
      from: calendarDate(first(raw.from)),
      to: calendarDate(first(raw.to)),
      segment:
        segment && source.segments.some((candidate) => candidate.id === segment) ? segment : null,
    },
    page: positiveInteger(first(raw.page)) ?? 1,
    status: isJournalStatusFilter(status) ? status : "all",
    account: accountId,
    sub: subAccountId,
    partner:
      partner === NONE_KEY || source.partners.some((candidate) => candidate.id === partner)
        ? (partner ?? null)
        : null,
    tag:
      tag === NONE_KEY || source.memoTags.some((candidate) => candidate.id === tag)
        ? (tag ?? null)
        : null,
    breakdown: {
      axis: isBreakdownAxis(axis) ? axis : BREAKDOWN_DEFAULTS.axis,
      side: isBreakdownSide(side) ? side : BREAKDOWN_DEFAULTS.side,
      top: isBreakdownTop(top) ? top : BREAKDOWN_DEFAULTS.top,
      sort: isBreakdownSort(sort) ? sort : BREAKDOWN_DEFAULTS.sort,
    },
    comparePrior: first(raw.compare) === "prior",
  };
}

/**
 * 集計's parameters for a link: the defaults are left out (shorter URLs), the filters kept.
 * `overrides` replaces some (a drill-down, the 収益 / 費用 switch).
 */
export function breakdownLinkParams(
  params: Pick<ReportParams, "breakdown" | "partner" | "tag">,
  overrides: Partial<BreakdownParams> & { partner?: string | null; tag?: string | null } = {},
): ExtraParams {
  const merged = { ...params.breakdown, ...overrides };
  const keyed = (key: keyof BreakdownParams) =>
    merged[key] === BREAKDOWN_DEFAULTS[key] ? null : merged[key];
  return {
    axis: keyed("axis"),
    side: keyed("side"),
    top: keyed("top"),
    sort: keyed("sort"),
    partner: overrides.partner !== undefined ? overrides.partner : params.partner,
    tag: overrides.tag !== undefined ? overrides.tag : params.tag,
  };
}

/**
 * The master data and today, read once per request: all the frame needs (the heading, the
 * conditions, the tabs), so that it shows before the entries are read (05-ui-ux §3.1).
 */
export const loadReportFrame = cache(async () => {
  const prisma = await db();
  const source = await loadReportFrameSource(prisma);
  return { prisma, source, today: todayInJapan() };
});

/** The book (the frame's master data and every entry) and today, read once per request. */
export const loadReports = cache(async () => {
  const { prisma, source: frame, today } = await loadReportFrame();
  const source: ReportSource = { ...frame, entries: await loadReportEntries(prisma) };
  return { prisma, source, today };
});

/** `null` without a fiscal year (the setup creates the first one, so only in odd states). */
export function resolvePeriodOrNull(
  source: ReportFrameSource,
  query: ReportQuery,
  today: CalendarDate,
): ReportPeriod | null {
  return resolveReportPeriod(query, source.fiscalYears, today);
}

export type ExtraParams = Readonly<Record<string, string | number | null | undefined>>;

function withParams(base: Record<string, string>, extra: ExtraParams): string {
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  return params.toString();
}

/** A tab with the period kept (`fy` `period` `from` `to` `segment`) plus tab parameters. */
export function reportHref(tab: ReportTab, period: ReportPeriod, extra: ExtraParams = {}): string {
  return `/reports/${tab}?${withParams(periodSearchParams(period), extra)}`;
}

/** The CSV / PDF of a tab with the same conditions (`/reports/export`). */
export function exportHref(
  tab: ReportTab,
  format: ExportFormat,
  period: ReportPeriod,
  extra: ExtraParams = {},
): string {
  return `/reports/export?${withParams(
    { report: tab, format, ...periodSearchParams(period) },
    extra,
  )}`;
}

/** The same period with another preset (今月 / 今期 / 任意 keep the year and the segment). */
export function withPreset(period: ReportPeriod, preset: ReportPeriod["preset"]): ReportPeriod {
  return { ...period, preset };
}
