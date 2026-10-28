import {
  getDocumentDetail,
  loadEntryFormOptions,
  todayInJapan,
  VOUCHER_KINDS,
} from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  formatYenInput,
  isCalendarDate,
  parseYenInput,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { EntryTypeSwitch, isEntryType } from "../_components/entry-type-switch";
import { SimpleEntryForm } from "../_components/simple-entry-form";
import { TransferForm } from "../_components/transfer-form";
import { VoucherForm } from "../_components/voucher-form";

export const metadata: Metadata = { title: "取引の登録" };

/** A query value (the first of a repeated key) of at most `max` characters, else `null`. */
function queryText(value: string | string[] | undefined, max: number): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text !== "" && text.length <= max ? text : null;
}

/** 取引の登録 (11 §4): 収入 / 支出 / 振替 / 伝票, 支出 by default. */
export default async function NewEntryPage({ searchParams }: PageProps<"/entries/new">) {
  const { type, date, amount, partner, document: documentParam } = await searchParams;
  const entryType = isEntryType(type) ? type : "expense";
  const prisma = await db();
  const options = await loadEntryFormOptions(prisma);
  const today = todayInJapan();
  // 「この証憑から取引を登録」 (13 §4): the document's items start the 収入 / 支出 form, and the
  // document is linked once the entry is registered. Malformed values are left out.
  const initial: { entryDate?: string; amount?: string; partnerId?: string } = {};
  const entryDate = queryText(date, 10);
  if (entryDate && isCalendarDate(entryDate)) initial.entryDate = entryDate;
  const yen = parseYenInput(queryText(amount, 32) ?? "");
  if (yen !== null && yen >= 1n) initial.amount = formatYenInput(yen);
  const partnerId = queryText(partner, 64);
  if (partnerId && options.partners.some((item) => item.id === partnerId)) {
    initial.partnerId = partnerId;
  }
  const documentId = queryText(documentParam, 64);
  const simple = entryType === "income" || entryType === "expense";
  const source = documentId && simple ? await getDocumentDetail(prisma, documentId) : null;
  const linkDocument =
    source && source.status !== "voided"
      ? { id: source.id, name: source.originalName ?? DOCUMENT_KIND_LABELS[source.kind] }
      : undefined;
  return (
    <>
      <PageHeader title="取引の登録" back={{ href: "/entries", label: "取引" }} />
      <EntryTypeSwitch current={entryType} />
      {entryType === "voucher" ? (
        <VoucherForm options={options} today={today} kinds={VOUCHER_KINDS} mode={{ kind: "new" }} />
      ) : entryType === "transfer" ? (
        <TransferForm options={options} today={today} />
      ) : (
        <SimpleEntryForm
          key={[
            entryType,
            linkDocument?.id,
            initial.entryDate,
            initial.amount,
            initial.partnerId,
          ].join("|")}
          type={entryType}
          options={options}
          today={today}
          initial={initial}
          linkDocument={linkDocument}
        />
      )}
    </>
  );
}
