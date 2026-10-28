import { loadInvoiceDraftInput, loadInvoiceFormOptions } from "@niho-finance/db";
import { INVOICE_DOC_TYPE_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { InvoiceForm } from "../../_components/invoice-form";

export const metadata: Metadata = { title: "下書きの編集" };

/**
 * 編集 of a draft (18 §8). An issued (or void) document is never edited: back to its detail, whose
 * band says how to correct it (void and copy).
 */
export default async function EditInvoicePage({ params }: PageProps<"/invoices/[id]/edit">) {
  const { id } = await params;
  const prisma = await db();
  const source = await loadInvoiceDraftInput(prisma, id);
  if (!source) notFound();
  if (source.status !== "draft") redirect(`/invoices/${id}?blocked=edit`);
  const { values } = source;
  const options = await loadInvoiceFormOptions(prisma, {
    includeIds: [values.partnerId, values.revenueAccountId, values.segmentId].filter(Boolean),
  });
  const typeLabel = INVOICE_DOC_TYPE_LABELS[source.docType];
  return (
    <>
      <PageHeader
        title={`${typeLabel}（下書き）の編集`}
        back={{ href: `/invoices/${id}`, label: `${typeLabel}（下書き）` }}
      />
      <InvoiceForm
        mode={{ kind: "edit", id }}
        docType={source.docType}
        options={options}
        initial={values}
      />
    </>
  );
}
