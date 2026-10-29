import {
  loadFinancialStatementsSource,
  loadFixedAssetLedger,
  loadFixedAssetRegister,
  loadHandoverDocuments,
  type HandoverDocumentRecord,
  type PrismaClient,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import {
  buildMonthlyTrend,
  handoverDocumentPath,
  handoverEstimateBytes,
  handoverPeriod,
  planHandoverBooks,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsSource,
  type HandoverDocument,
  type HandoverPackageEntry,
  type HandoverPackagePlan,
  type HandoverScreenOutputs,
} from "@niho-finance/reports";
import { createElement } from "react";
import { renderPdf } from "@/lib/pdf/render";
import {
  getDocumentStorage,
  StoredFileNotFoundError,
  StoredFileTooLargeError,
} from "@/lib/storage";
import { FinancialStatementsPdf } from "../../../../closing/statements/_pdf/documents";
import { defaultStatementsYear } from "../../../../closing/statements/_lib/query";
import { monthlyCsvRows, trialBalanceCsvRows } from "../../../../reports/_lib/csv-rows";
import { pdfPeriodLabel } from "../../../../reports/_lib/format";
import { buildTrialBalanceView } from "../../../../reports/_lib/trial-balance-view";
import { TrialBalancePdf } from "../../../../reports/_pdf/trial-balance";

/*
 * What goes into 受け渡しパッケージ (14-reports §16.2), gathered with the existing exports: S7's CSV
 * rows and PDFs, #15's statements, #14's fixed asset ledger and S6's index and storage. The screen's
 * direct download and the job (`lib/jobs/handover-package.ts`) build the same plan from here.
 */

/** The book and the documents of one fiscal year. */
export interface PackageBasis {
  source: FinancialStatementsSource;
  year: FinancialStatementsFiscalYear;
  documents: HandoverDocumentRecord[];
  /** Σ `byteSize` of the year's documents. */
  documentBytes: number;
}

/** `fiscalYearId`, or the default year of 決算書 (17 §2) when it is `null`; `null` without years. */
export async function loadPackageBasis(
  prisma: PrismaClient,
  options: { fiscalYearId?: string | null; fiscalYearNo?: number | null; today: CalendarDate },
): Promise<PackageBasis | null> {
  const source = await loadFinancialStatementsSource(prisma);
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const named =
    typeof options.fiscalYearId === "string"
      ? years.find((year) => year.id === options.fiscalYearId)
      : typeof options.fiscalYearNo === "number"
        ? years.find((year) => year.no === options.fiscalYearNo)
        : undefined;
  const year = named ?? defaultStatementsYear(years, options.today);
  if (!year) return null;
  const documents = await loadHandoverDocuments(prisma, {
    from: year.startDate,
    to: year.endDate,
  });
  const documentBytes = documents.reduce((sum, document) => sum + document.byteSize, 0);
  return { source, year, documents, documentBytes };
}

export function packageEstimate(basis: PackageBasis, includeDocuments: boolean): number {
  return handoverEstimateBytes({ includeDocuments, documentBytes: basis.documentBytes });
}

const NO_PDF = new Uint8Array();

function screenOutputs(
  basis: PackageBasis,
  options: { render: boolean; createdAt: Date },
): HandoverScreenOutputs {
  const period = handoverPeriod(basis.source, basis.year.id);
  const view = buildTrialBalanceView(basis.source, period);
  const monthly = buildMonthlyTrend(basis.source, period);
  const header = {
    company: basis.source.company.name,
    periodLabel: pdfPeriodLabel(period),
    exportedAt: options.createdAt,
  };
  return {
    trialBalanceCsv: {
      rows: trialBalanceCsvRows(view, null),
      count: view.balanceSheet.length + view.incomeStatement.length,
    },
    trialBalancePdf: async () =>
      options.render ? renderPdf(createElement(TrialBalancePdf, { view, header })) : NO_PDF,
    monthlyCsv: { rows: monthlyCsvRows(monthly), count: monthly.rows.length },
    statementsPdf: async (report) =>
      options.render
        ? renderPdf(
            createElement(FinancialStatementsPdf, { report, exportedAt: options.createdAt }),
          )
        : NO_PDF,
  };
}

/** The generated files (books/, closing/, statements/) and the notes about what is left out. */
export async function packageBooks(
  prisma: PrismaClient,
  basis: PackageBasis,
  options: { render: boolean; createdAt: Date },
): Promise<{ entries: HandoverPackageEntry[]; notes: string[] }> {
  const ledger = await loadFixedAssetLedger(prisma, basis.year.id);
  return planHandoverBooks({
    source: basis.source,
    fiscalYearId: basis.year.id,
    fixedAssets: ledger.rows,
    fixedAssetRegister: await loadFixedAssetRegister(prisma, basis.year.id),
    screens: screenOutputs(basis, options),
  });
}

/** The document's file from S6's storage; `null` when it is not there (it stays in the index). */
async function readDocument(storageKey: string): Promise<Uint8Array | null> {
  try {
    return await getDocumentStorage().read(storageKey);
  } catch (error) {
    if (error instanceof StoredFileNotFoundError || error instanceof StoredFileTooLargeError) {
      return null;
    }
    throw error;
  }
}

function packageDocuments(basis: PackageBasis): HandoverDocument[] {
  return basis.documents.map((document) => ({
    index: document.index,
    path: handoverDocumentPath(document.archive),
    mime: document.index.mime,
    byteSize: document.byteSize,
    fetch: () => readDocument(document.index.storageKey),
  }));
}

/** The whole plan, with the PDFs rendered: what the zip is written from. */
export async function buildPackagePlan(
  prisma: PrismaClient,
  basis: PackageBasis,
  options: {
    includeDocuments: boolean;
    createdBy: string;
    createdAt: Date;
    /** Extra README notes (e.g. why the files were left out). */
    notes?: readonly string[];
  },
): Promise<HandoverPackagePlan> {
  const books = await packageBooks(prisma, basis, {
    render: true,
    createdAt: options.createdAt,
  });
  return {
    company: basis.source.company.name,
    fiscalYear: {
      no: basis.year.no,
      startDate: basis.year.startDate,
      endDate: basis.year.endDate,
      status: basis.year.status,
    },
    createdAt: options.createdAt,
    createdBy: options.createdBy,
    includeDocuments: options.includeDocuments,
    entries: books.entries,
    documents: packageDocuments(basis),
    notes: [...books.notes, ...(options.notes ?? [])],
  };
}
