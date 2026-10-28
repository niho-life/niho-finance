import {
  getPrismaClient,
  getSetupProgress,
  recordExport,
  type PrismaClient,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import { PayrollTableMissingError } from "@niho-finance/payroll";
import { redirect } from "next/navigation";
import { createElement } from "react";
import { actor } from "@/lib/actor";
import { pdfResponse } from "@/lib/pdf/download";
import { renderPdf } from "@/lib/pdf/render";
import { StatementFormDocument, type StatementForm } from "@/lib/pdf/statement-form";
import { TABLE_MISSING_HINT } from "../../_lib/labels";

/*
 * What the 法定調書 routes share (22-payroll §12.2): the database once the setup is done, plain-text
 * refusals (never cached), the year's period for the export log, and a PDF of forms with its audit
 * log `export.download`. The routes authorize first; nothing here reads a マイナンバー.
 */

export async function setUpPrisma(): Promise<PrismaClient> {
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");
  return prisma;
}

export function plainResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A missing yearly table as a 404 with the way to import it; other errors are thrown. */
export function tableMissingResponse(error: unknown): Response {
  if (!(error instanceof PayrollTableMissingError)) throw error;
  return plainResponse(`${error.message}。${TABLE_MISSING_HINT}`, 404);
}

export function yearPeriod(year: number): { from: CalendarDate; to: CalendarDate } {
  const y = String(year).padStart(4, "0");
  return { from: `${y}-01-01` as CalendarDate, to: `${y}-12-31` as CalendarDate };
}

/** The forms as one PDF, the download written to the audit log (`export.download`). */
export async function formsPdfResponse(
  prisma: PrismaClient,
  options: {
    kind: string;
    year: number;
    title: string;
    author: string;
    forms: readonly StatementForm[];
    fileName: { ascii: string; utf8: string };
  },
): Promise<Response> {
  const bytes = await renderPdf(
    createElement(StatementFormDocument, {
      title: options.title,
      author: options.author,
      forms: options.forms,
    }),
  );
  await recordExport(
    prisma,
    { kind: options.kind, format: "pdf", ...yearPeriod(options.year) },
    { actor: await actor() },
  );
  return pdfResponse(bytes, options.fileName.ascii, options.fileName.utf8);
}

/** The id part of an ASCII file name (`withholding-slip_2026_9k3f2a7q.pdf`). */
export const shortId = (id: string) => id.slice(-8).toLowerCase();
