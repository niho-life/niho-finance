import { loadWithholdingLedger } from "@niho-finance/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { PrintButton } from "../../../../_components/print-button";
import {
  WITHHOLDING_LEDGER_PRINT_CSS,
  WithholdingLedgerSheet,
} from "../../../../_components/withholding-ledger-sheet";
import { withholdingLedgerData } from "../../../../_lib/withholding-ledger-lines";

export const metadata: Metadata = { title: "源泉徴収簿" };

/** 源泉徴収簿 (22-payroll §11.4): A4 landscape, printable, and 「PDF を保存」. */
export default async function WithholdingLedgerPage({
  params,
}: {
  params: Promise<{ year: string; employeeId: string }>;
}) {
  const { year: yearText, employeeId } = await params;
  if (!/^\d{4}$/.test(yearText)) notFound();
  const year = Number(yearText);
  const ledger = await loadWithholdingLedger(await db(), year, employeeId);
  if (!ledger) notFound();
  const data = withholdingLedgerData(ledger);

  return (
    <>
      <style>{WITHHOLDING_LEDGER_PRINT_CSS}</style>
      <div data-print="hide">
        <PageHeader
          title="源泉徴収簿"
          meta={`${data.employeeName} · ${data.yearLabel}`}
          back={{ href: `/payroll/year-end/${year}/${ledger.employee.id}`, label: "年末調整" }}
          actions={
            <>
              <PrintButton />
              {/* A plain link: a download must not be prefetched (the audit log records it). */}
              <a
                href={`/payroll/year-end/${year}/${ledger.employee.id}/ledger/pdf`}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                PDF を保存
              </a>
            </>
          }
        />
      </div>
      <WithholdingLedgerSheet data={data} />
    </>
  );
}
