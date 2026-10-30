import { listWallets, loadBonusDraft, todayInJapan } from "@niho-finance/db";
import { formatYenInput } from "@niho-finance/ledger";
import { isYearMonth, yearMonthLabel, yearMonthOf } from "@niho-finance/payroll";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatYenDisplay, walletLabel } from "@/lib/format";
import { taxColumnText } from "../../_lib/labels";
import { coverageNotes } from "../../_lib/views";
import { BonusForm, type BonusDraftView, type BonusEmployee } from "./bonus-form";

export const metadata: Metadata = { title: "賞与の計算" };

/**
 * 賞与の計算と確定 (22-payroll §10.5) of `?month=YYYY-MM` (today's month when missing or invalid).
 * A confirmed month opens the confirmed bonus.
 */
export default async function NewBonusRunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { month } = await searchParams;
  const payMonth =
    typeof month === "string" && isYearMonth(month) ? month : yearMonthOf(todayInJapan());
  const prisma = await db();
  const draft = await loadBonusDraft(prisma, payMonth);
  if (draft.confirmedRunId) redirect(`/payroll/bonus/${draft.confirmedRunId}`);
  const title = `${yearMonthLabel(draft.payMonth)}の賞与`;

  if (draft.employees.length === 0) {
    return (
      <>
        <PageHeader title={title} back={{ href: "/payroll/bonus", label: "賞与" }} />
        <EmptyState
          title="賞与を支給する従業員がいません"
          description="有効な役員・従業員がいないので、賞与を計算できません。従業員を追加するか、無効にした従業員を有効に戻します。"
          action={
            <ButtonLink href="/payroll/employees?add=1" variant="primary" size="sm">
              従業員を追加
            </ButtonLink>
          }
        />
      </>
    );
  }

  const wallets = (await listWallets(prisma)).filter((wallet) => wallet.isActive);
  const walletOptions = draft.wallets.map((wallet) => {
    const settings = wallets.find((candidate) => candidate.id === wallet.id);
    return { value: wallet.id, label: settings ? walletLabel(settings) : wallet.name };
  });
  const previousLabel = yearMonthLabel(draft.previousPayMonth);
  const employees: BonusEmployee[] = draft.employees.map(
    ({ employee, coverage, taxColumn, previousMonth }) => ({
      id: employee.id,
      name: employee.name,
      kind: employee.kind,
      coverageNotes: coverageNotes(coverage, employee.kind, draft.payMonth, employee),
      taxColumn: taxColumnText(
        taxColumn.column,
        taxColumn.column === "kou" ? taxColumn.dependents : (taxColumn.secondaryDependents ?? 0),
      ),
      previousMonthSource: previousMonth
        ? `${previousLabel}の支給から（${formatYenDisplay(previousMonth.pay)} 円・税額 ${formatYenDisplay(previousMonth.incomeTax)} 円）`
        : `${previousLabel}の支給にこの人はいません`,
    }),
  );
  const initialDraft: BonusDraftView = {
    paymentDate: draft.input.paymentDate,
    title: draft.input.title,
    calcPeriodOver6Months: draft.input.calcPeriodOver6Months,
    payFromWalletId: draft.input.payFromWalletId ?? "",
    withholdingSpecialDue: draft.input.withholdingSpecialDue,
    items: draft.input.items.map((item) => ({
      employeeId: item.employeeId,
      bonus: "",
      previousMonthPay: item.previousMonthPay === null ? "" : formatYenInput(item.previousMonthPay),
      previousMonthTax: formatYenInput(item.previousMonthTax),
      filingDate: "",
      filingAmount: "",
    })),
  };

  return (
    <>
      <PageHeader
        title={title}
        meta="計算して確定します"
        back={{ href: "/payroll/bonus", label: "賞与" }}
      />
      <BonusForm
        payMonth={draft.payMonth}
        payMonthLabel={yearMonthLabel(draft.payMonth)}
        previousPayMonthLabel={previousLabel}
        employees={employees}
        wallets={walletOptions}
        initialDraft={initialDraft}
      />
    </>
  );
}
