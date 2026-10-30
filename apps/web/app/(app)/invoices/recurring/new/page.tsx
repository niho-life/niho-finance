import {
  loadRecurringInvoiceFormOptions,
  RECURRING_DUE_DAYS,
  todayInJapan,
} from "@niho-finance/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { documentName } from "../../_components/list-query";
import { RecurringInvoiceForm } from "../_components/recurring-invoice-form";

export const metadata: Metadata = { title: "定期請求の追加" };

function param(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length <= 64 ? first : null;
}

/**
 * 定期請求の追加 (18 §14.5): blank (毎月 末日, 当月分, 翌月末, from today), or `?from=<invoiceId>` with
 * that invoice's body, issue day and due rule as the template (「この内容で定期請求を作る」).
 */
export default async function NewRecurringInvoicePage({
  searchParams,
}: PageProps<"/invoices/recurring/new">) {
  const query = await searchParams;
  const prisma = await db();
  const today = todayInJapan();
  const form = await loadRecurringInvoiceFormOptions(prisma, { today, from: param(query.from) });
  if (!form) notFound();
  const sourceNote = form.sourceProblem
    ? form.sourceProblem
    : form.source
      ? `${documentName(form.source)} を雛形にします。件名や品名に {対象月} を入れると、月ごとに置き換えます`
      : null;
  return (
    <>
      <PageHeader
        title="定期請求の追加"
        back={
          form.source
            ? { href: `/invoices/${form.source.id}`, label: documentName(form.source) }
            : { href: "/invoices/recurring", label: "定期請求" }
        }
      />
      <RecurringInvoiceForm
        mode={{ kind: "new" }}
        options={form.options}
        initial={form.values}
        today={today}
        dueWindowDays={RECURRING_DUE_DAYS}
        sourceNote={sourceNote}
      />
    </>
  );
}
