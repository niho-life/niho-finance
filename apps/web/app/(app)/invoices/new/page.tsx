import {
  loadInvoiceDraftInput,
  loadInvoiceFormOptions,
  todayInJapan,
  type InvoiceDraftFormValues,
} from "@niho-finance/db";
import {
  canConvertInvoice,
  defaultDueDate,
  INVOICE_CONVERSIONS,
  INVOICE_DOC_TYPE_LABELS,
  isDraftInvoiceNumber,
  isInvoiceDocType,
  type CalendarDate,
  type InvoiceDocType,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { DocTypeSwitch } from "../_components/doc-type-switch";
import { InvoiceForm } from "../_components/invoice-form";
import { documentName } from "../_components/list-query";

export const metadata: Metadata = { title: "書類の作成" };

function blankValues(docType: InvoiceDocType, today: CalendarDate): InvoiceDraftFormValues {
  return {
    docType,
    partnerId: "",
    title: "",
    issueDate: today,
    dueDate: defaultDueDate(docType, today) ?? "",
    pricesIncludeTax: false,
    note: "",
    revenueAccountId: "",
    segmentId: "",
    sourceInvoiceId: "",
    lines: [],
  };
}

function param(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length <= 64 ? first : null;
}

/**
 * 新規 (18 §8): `?type=` 請求書 / 見積書 / 納品書; `?from=` a conversion of an issued document (the
 * source's partner, title, lines, note and accounts, dated today); `?copy=` a copy of the same type
 * (「<番号> の再発行」 at the head of the note when the source is void).
 */
export default async function NewInvoicePage({ searchParams }: PageProps<"/invoices/new">) {
  const query = await searchParams;
  const typeParam = isInvoiceDocType(param(query.type))
    ? (param(query.type) as InvoiceDocType)
    : null;
  const fromId = param(query.from);
  const copyId = param(query.copy);
  const prisma = await db();
  const today = todayInJapan();

  let docType: InvoiceDocType = typeParam ?? "invoice";
  let initial = blankValues(docType, today);
  let sourceNote: string | null = null;
  let back = { href: "/invoices", label: "請求" };

  if (fromId) {
    const source = await loadInvoiceDraftInput(prisma, fromId);
    if (!source) notFound();
    const to =
      typeParam && canConvertInvoice(source.docType, typeParam)
        ? typeParam
        : INVOICE_CONVERSIONS[source.docType][0];
    const issued =
      source.status === "issued" || source.status === "sent" || source.status === "paid";
    back = { href: `/invoices/${source.id}`, label: documentName(source) };
    if (!to || !issued) {
      return (
        <>
          <PageHeader title="書類の作成" back={back} />
          <EmptyState
            title={
              to
                ? `${documentName(source)} は発行していないため、変換できません`
                : `${INVOICE_DOC_TYPE_LABELS[source.docType]}からは変換できません`
            }
            description="見積書から納品書・請求書を、納品書から請求書を、発行した書類から作れます"
            action={
              <ButtonLink href={`/invoices/${source.id}`} size="sm">
                元の書類へ戻る
              </ButtonLink>
            }
          />
        </>
      );
    }
    docType = to;
    initial = {
      ...source.values,
      docType: to,
      issueDate: today,
      dueDate: defaultDueDate(to, today) ?? "",
      sourceInvoiceId: source.id,
    };
    sourceNote = `${documentName(source)} から${INVOICE_DOC_TYPE_LABELS[to]}を作ります`;
  } else if (copyId) {
    const source = await loadInvoiceDraftInput(prisma, copyId);
    if (!source) notFound();
    docType = source.docType;
    const reissue = source.status === "void" && !isDraftInvoiceNumber(source.number);
    const note = reissue
      ? [`${source.number} の再発行`, source.values.note].filter(Boolean).join("\n")
      : source.values.note;
    initial = {
      ...source.values,
      issueDate: today,
      dueDate: defaultDueDate(source.docType, today) ?? "",
      sourceInvoiceId: "",
      note,
    };
    back = { href: `/invoices/${source.id}`, label: documentName(source) };
    sourceNote = `${documentName(source)} を複製します`;
  }

  const options = await loadInvoiceFormOptions(prisma, {
    includeIds: [initial.partnerId, initial.revenueAccountId, initial.segmentId].filter(Boolean),
  });
  const plain = !fromId && !copyId;

  return (
    <>
      <PageHeader title={`${INVOICE_DOC_TYPE_LABELS[docType]}の作成`} back={back} />
      {plain ? <DocTypeSwitch current={docType} /> : null}
      <InvoiceForm
        key={`${docType}-${fromId ?? ""}-${copyId ?? ""}`}
        mode={{ kind: "new" }}
        docType={docType}
        options={options}
        initial={initial}
        sourceNote={sourceNote}
      />
    </>
  );
}
