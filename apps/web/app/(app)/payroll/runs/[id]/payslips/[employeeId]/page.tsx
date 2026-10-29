import { loadPayslip } from "@niho-finance/db";
import { yearMonthLabel } from "@niho-finance/payroll";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { PAYSLIP_PRINT_CSS, PayslipSheet } from "../../../../_components/payslip-sheet";
import { PrintButton } from "../../../../_components/print-button";
import { payslipData } from "../../../../_lib/payslip-lines";

export const metadata: Metadata = { title: "給与明細" };

/** 給与明細 (22-payroll §6.5): one A4 portrait sheet, printable, and 「PDF を保存」. */
export default async function PayslipPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>;
}) {
  const { id, employeeId } = await params;
  const payslip = await loadPayslip(await db(), id, employeeId);
  if (!payslip) notFound();
  const data = payslipData(payslip);

  return (
    <>
      <style>{PAYSLIP_PRINT_CSS}</style>
      <div data-print="hide">
        <PageHeader
          title="給与明細"
          meta={`${data.employeeName} · ${data.payMonthLabel}`}
          back={{
            href: `/payroll/runs/${payslip.runId}`,
            label: `${yearMonthLabel(payslip.payMonth)}の支給`,
          }}
          actions={
            <>
              <PrintButton />
              {/* A plain link: a download must not be prefetched (the audit log records it). */}
              <a
                href={`/payroll/runs/${payslip.runId}/payslips/${payslip.employee.id}/pdf`}
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
