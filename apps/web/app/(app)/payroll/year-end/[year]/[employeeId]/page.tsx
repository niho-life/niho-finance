import { previewYearEnd, SettingsError, type YearEndPreview } from "@niho-finance/db";
import { PayrollTableMissingError } from "@niho-finance/payroll";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { TABLE_MISSING_HINT, TAX_COLUMN_LABELS, WORKER_KIND_LABELS } from "../../../_lib/labels";
import {
  declarationDraftOf,
  toYearEndPreviewView,
  yearEndOptions,
} from "../../../_lib/year-end-views";
import { YearEndForm } from "./year-end-form";

export const metadata: Metadata = { title: "年末調整" };

/**
 * 年末調整 of one person and year (22-payroll §11.5): the declaration's form, every step of the
 * calculation, 「年末調整を確定」 and the link to 源泉徴収簿. A confirmed one is shown read only.
 */
export default async function YearEndEmployeePage({
  params,
}: {
  params: Promise<{ year: string; employeeId: string }>;
}) {
  const { year: yearText, employeeId } = await params;
  if (!/^\d{4}$/.test(yearText)) notFound();
  const year = Number(yearText);
  const back = { href: `/payroll/year-end?year=${year}`, label: "年末調整" };
  let preview: YearEndPreview;
  try {
    preview = await previewYearEnd(await db(), year, employeeId);
  } catch (error) {
    if (error instanceof SettingsError) notFound();
    if (error instanceof PayrollTableMissingError) {
      return (
        <>
          <PageHeader title="年末調整" meta={`${year} 年分`} back={back} />
          <p
            role="alert"
            className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger"
          >
            {error.message}。{TABLE_MISSING_HINT}
          </p>
        </>
      );
    }
    throw error;
  }
  const { employee } = preview;
  const ledgerHref = `/payroll/year-end/${year}/${employee.id}/ledger`;
  const saved = preview.declaration ? declarationDraftOf(preview.declaration.declaration) : null;

  return (
    <>
      <PageHeader
        title={`${employee.name}さんの年末調整`}
        meta={`${year} 年分 · ${WORKER_KIND_LABELS[employee.kind]} · ${TAX_COLUMN_LABELS[preview.taxColumn]}${
          preview.confirmed ? " · 確定済み" : ""
        }`}
        back={back}
        actions={
          <ButtonLink href={ledgerHref} size="sm">
            源泉徴収簿を開く
          </ButtonLink>
        }
      />
      <YearEndForm
        key={preview.confirmed?.id ?? "draft"}
        year={year}
        employeeId={employee.id}
        employeeName={employee.name}
        initialDraft={declarationDraftOf(
          preview.confirmed?.input.declaration ?? preview.usedDeclaration,
        )}
        savedDraft={saved}
        initialView={toYearEndPreviewView(preview)}
        options={yearEndOptions(preview.birthDates)}
        readOnly={preview.confirmed !== null}
        ledgerHref={ledgerHref}
      />
    </>
  );
}
