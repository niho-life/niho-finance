import { loadReportSource, todayInJapan } from "@niho-finance/db";
import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import {
  isJournalStatusFilter,
  isPeriodPreset,
  periodSearchParams,
  resolveReportPeriod,
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

export function parseReportParams(raw: RawSearchParams, source: ReportSource): ReportParams {
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
  };
}

/** The book and today, read once per request (the frame and the page share it). */
export const loadReports = cache(async () => {
  const prisma = await db();
  const source = await loadReportSource(prisma);
  return { prisma, source, today: todayInJapan() };
});

/** `null` without a fiscal year (the setup creates the first one, so only in odd states). */
export function resolvePeriodOrNull(
  source: ReportSource,
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
