import {
  loadRecurringInvoiceFormOptions,
  RECURRING_DUE_DAYS,
  todayInJapan,
} from "@niho-finance/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { RecurringInvoiceForm } from "../../_components/recurring-invoice-form";

export const metadata: Metadata = { title: "定期請求の編集" };

/**
 * 定期請求の編集 (18 §14.5): the template and the rule. The drafts and invoices made before keep
 * what they were made with.
 */
export default async function EditRecurringInvoicePage({
  params,
}: PageProps<"/invoices/recurring/[id]/edit">) {
  const { id } = await params;
  const prisma = await db();
  const today = todayInJapan();
  const form = await loadRecurringInvoiceFormOptions(prisma, { today, id });
  if (!form?.recurringInvoice) notFound();
  return (
    <>
      <PageHeader
        title={`${form.recurringInvoice.name} の編集`}
        back={{ href: `/invoices/recurring/${id}`, label: form.recurringInvoice.name }}
      />
      <RecurringInvoiceForm
        mode={{ kind: "edit", id }}
        options={form.options}
        initial={form.values}
        today={today}
        dueWindowDays={RECURRING_DUE_DAYS}
      />
    </>
  );
}
