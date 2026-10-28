import { listWallets, loadPayrollDraft, todayInJapan } from "@niho-finance/db";
import { formatYenInput } from "@niho-finance/ledger";
import {
  isYearMonth,
  PREMIUM_TIMING_LABELS,
  PREMIUM_TIMINGS,
  premiumMonthFor,
  yearMonthLabel,
  yearMonthOf,
} from "@niho-finance/payroll";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { walletLabel } from "@/lib/format";
import { attemptPayroll } from "../../_lib/errors";
import { coverageNotes, loadRunPreview } from "../../_lib/views";
import { RunForm, type RunDraft, type RunEmployee } from "./run-form";

export const metadata: Metadata = { title: "支給の計算" };

/**
 * 支給の計算と確定 (22-payroll §6.3) of `?month=YYYY-MM` (today's month when missing or invalid).
 * A confirmed month opens the confirmed run.
 */
export default async function NewPayrollRunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { month } = await searchParams;
  const payMonth =
    typeof month === "string" && isYearMonth(month) ? month : yearMonthOf(todayInJapan());
  const prisma = await db();
  const draft = await loadPayrollDraft(prisma, payMonth);
  if (draft.confirmedRunId) redirect(`/payroll/runs/${draft.confirmedRunId}`);
  const title = `${yearMonthLabel(draft.payMonth)}の支給`;

  if (draft.employees.length === 0) {
    return (
      <>
        <PageHeader title={title} back={{ href: "/payroll", label: "給与" }} />
        <EmptyState
          title="支給する従業員がいません"
          description="有効な役員・従業員がいないので、支給を計算できません。従業員を追加するか、無効にした従業員を有効に戻します。"
          action={
            <ButtonLink href="/payroll/employees?add=1" variant="primary" size="sm">
              従業員を追加
            </ButtonLink>
          }
        />
      </>
    );
  }

  const initialPreview = await attemptPayroll(() => loadRunPreview(prisma, draft.input));
  const wallets = (await listWallets(prisma)).filter((wallet) => wallet.isActive);
  const walletOptions = draft.wallets.map((wallet) => {
    const settings = wallets.find((candidate) => candidate.id === wallet.id);
    return { value: wallet.id, label: settings ? walletLabel(settings) : wallet.name };
  });
  const employees: RunEmployee[] = draft.employees.map(({ employee, coverage }) => ({
    id: employee.id,
    name: employee.name,
    kind: employee.kind,
    coverageNotes: coverageNotes(coverage, employee.kind, draft.premiumMonth, employee),
  }));
  const initialDraft: RunDraft = {
    paymentDate: draft.input.paymentDate,
    premiumTiming: draft.input.premiumTiming,
    payFromWalletId: draft.input.payFromWalletId ?? "",
    withholdingSpecialDue: draft.input.withholdingSpecialDue,
    residentTaxSpecialDue: draft.input.residentTaxSpecialDue,
    items: draft.input.items.map((item) => ({
      employeeId: item.employeeId,
      taxablePay: formatYenInput(item.taxablePay),
      commuteAllowance: formatYenInput(item.commuteAllowance),
      residentTax: formatYenInput(item.residentTax),
      incomeTaxAdjustment: "",
      socialInsuranceAdjustment: "",
      adjustmentNote: "",
    })),
  };

  return (
    <>
      <PageHeader
        title={title}
        meta="計算して確定します"
        back={{ href: "/payroll", label: "給与" }}
      />
      <RunForm
        payMonth={draft.payMonth}
        payMonthLabel={yearMonthLabel(draft.payMonth)}
        employees={employees}
        wallets={walletOptions}
        premiumTimings={PREMIUM_TIMINGS.map((timing) => ({
          value: timing,
          label: `${PREMIUM_TIMING_LABELS[timing]}（${yearMonthLabel(premiumMonthFor(draft.payMonth, timing))}分を控除）`,
        }))}
        premiumTimingLocked={draft.premiumTimingLocked}
        initialDraft={initialDraft}
        initialPreview={initialPreview}
      />
    </>
  );
}
