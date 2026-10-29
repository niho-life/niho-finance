import { loadBonusPayslip } from "@niho-finance/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { PAYSLIP_PRINT_CSS, PayslipSheet } from "../../../../_components/payslip-sheet";
import { PrintButton } from "../../../../_components/print-button";
import { bonusPayslipData } from "../../../../_lib/payslip-lines";

export const metadata: Metadata = { title: "賞与明細" };

/** 賞与明細 (22-payroll §10.5): one A4 portrait sheet, printable, and 「PDF を保存」. */
export default async function BonusPayslipPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>;
}) {
  const { id, employeeId } = await params;
  const payslip = await loadBonusPayslip(await db(), id, employeeId);
  if (!payslip) notFound();
  const data = bonusPayslipData(payslip);

  return (
    <>
      <style>{PAYSLIP_PRINT_CSS}</style>
      <div data-print="hide">
        <PageHeader
          title="賞与明細"
          meta={`${data.employeeName} · ${data.payMonthLabel}`}
          back={{ href: `/payroll/bonus/${payslip.runId}`, label: payslip.title }}
          actions={
            <>
              <PrintButton />
              {/* A plain link: a download must not be prefetched (the audit log records it). */}
              <a
                href={`/payroll/bonus/${payslip.runId}/payslips/${payslip.employee.id}/pdf`}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                PDF を保存
              </a>
            </>
          }
        />
      </div>
      <PayslipSheet data={data} />
    </>
  );
}
