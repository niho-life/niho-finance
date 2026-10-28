import {
  getPrismaClient,
  getSetupProgress,
  loadBackupSource,
  loadDocumentsForArchive,
  loadReportSource,
  recordExport,
  todayInJapan,
} from "@niho-finance/db";
import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import {
  buildBackupFiles,
  buildBeancount,
  buildDocumentsArchive,
  compactDate,
  csvText,
  CSV_CONTENT_TYPES,
  encodeCsv,
  fiscalYearOn,
  freeeJournalRows,
  isCsvEncoding,
  yayoiJournalRows,
  zipFiles,
  type CsvEncoding,
  type ReportSource,
} from "@niho-finance/reports";
import { redirect } from "next/navigation";
import { actor } from "@/lib/env";
import { csvResponse, textResponse, zipResponse } from "@/lib/pdf/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["freee", "yayoi", "beancount", "documents", "backup"] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

interface Range {
  from: CalendarDate;
  to: CalendarDate;
  fiscalYearNo: number | null;
}

/**
 * The period of a download: `fy=<n>` (that year), `fy=all` (every year), `fy=custom` or no `fy`
 * with `from` / `to` (swapped when reversed), or else the current year. `null` when the dates
 * of a custom period are missing.
 */
function resolveRange(
  params: URLSearchParams,
  source: ReportSource,
  today: CalendarDate,
): Range | null {
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const fy = params.get("fy");
  const from = params.get("from");
  const to = params.get("to");
  if (fy === "all") {
    const first = years[0];
    const last = years[years.length - 1];
    return first && last ? { from: first.startDate, to: last.endDate, fiscalYearNo: null } : null;
  }
  if (fy !== null && /^\d{1,4}$/.test(fy)) {
    const year = years.find((candidate) => candidate.no === Number(fy));
    if (year) return { from: year.startDate, to: year.endDate, fiscalYearNo: year.no };
  }
  if (fy === "custom" || from !== null || to !== null) {
    if (!isCalendarDate(from) || !isCalendarDate(to)) return null;
    const [start, end] = from <= to ? [from, to] : [to, from];
    const year = years.find(
      (candidate) => candidate.startDate <= start && candidate.endDate >= end,
    );
    return { from: start, to: end, fiscalYearNo: year?.no ?? null };
  }
  const year = fiscalYearOn(years, today);
  return year ? { from: year.startDate, to: year.endDate, fiscalYearNo: year.no } : null;
}

const JST_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `20261028-2015` (JST) for the backup's file name. */
function stamp(now: Date): string {
  const parts = Object.fromEntries(
    JST_PARTS.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}`;
}

function encodingOf(params: URLSearchParams, fallback: CsvEncoding): CsvEncoding {
  const value = params.get("encoding");
  return isCsvEncoding(value) ? value : fallback;
}

/**
 * `GET /settings/export/download?kind=freee|yayoi|beancount|documents|backup` (14-reports §10):
 * the journal for freee / 弥生, beancount, the documents' archive and the backup. Every download
 * is written to the audit log (`export.download`).
 */
export async function GET(request: Request): Promise<Response> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  if (!isKind(kind)) redirect("/settings/export?error=kind");
  const audit = { actor: actor() };

  if (kind === "backup") {
    const now = new Date();
    const files = await buildBackupFiles(await loadBackupSource(prisma), { now });
    const zip = zipFiles(files);
    await recordExport(prisma, { kind, format: "zip" }, audit);
    return zipResponse(zip, `backup_${stamp(now)}.zip`);
  }

  const source = await loadReportSource(prisma);
  const range = resolveRange(params, source, todayInJapan());
  if (!range) redirect("/settings/export?error=period");
  const name = `${compactDate(range.from)}-${compactDate(range.to)}`;
  const logged = { fiscalYearNo: range.fiscalYearNo, from: range.from, to: range.to };

  switch (kind) {
    case "freee":
    case "yayoi": {
      const encoding = encodingOf(params, kind === "freee" ? "utf8" : "sjis");
      const rows =
        kind === "freee"
          ? freeeJournalRows(source, { from: range.from, to: range.to })
          : yayoiJournalRows(source, { from: range.from, to: range.to });
      const bytes = encodeCsv(csvText(rows), encoding);
      await recordExport(prisma, { kind, format: "csv", encoding, ...logged }, audit);
      return csvResponse(bytes, `${kind}_${name}.csv`, CSV_CONTENT_TYPES[encoding]);
    }
    case "beancount": {
      const text = buildBeancount(source, { from: range.from, to: range.to });
      await recordExport(prisma, { kind, format: "beancount", ...logged }, audit);
      return textResponse(text, `ledger_${name}.beancount`, "text/plain; charset=utf-8");
    }
    case "documents": {
      const documents = await loadDocumentsForArchive(prisma, { from: range.from, to: range.to });
      // S6 stores the files; until then the archive holds the index only (no fetchFile).
      const archive = await buildDocumentsArchive(documents);
      await recordExport(prisma, { kind, format: "zip", ...logged }, audit);
      return zipResponse(archive.zip, `documents_${name}.zip`);
    }
  }
}
