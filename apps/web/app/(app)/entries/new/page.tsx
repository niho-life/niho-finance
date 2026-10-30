import {
  getDocumentDetail,
  listRecurringEntryTemplates,
  loadEntryCandidates,
  loadEntryFormOptions,
  todayInJapan,
  VOUCHER_KINDS,
  type RecurringEntryTemplate,
} from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  formatYenInput,
  isCalendarDate,
  parseYenInput,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import Form from "next/form";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { EntryTypeSwitch, isEntryType } from "../_components/entry-type-switch";
import { SimpleEntryForm, type SimpleEntryInitial } from "../_components/simple-entry-form";
import { TransferForm, type TransferInitial } from "../_components/transfer-form";
import { VoucherForm } from "../_components/voucher-form";

export const metadata: Metadata = { title: "取引の登録" };

/** A query value (the first of a repeated key) of at most `max` characters, else `null`. */
function queryText(value: string | string[] | undefined, max: number): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text !== "" && text.length <= max ? text : null;
}

/**
 * 「テンプレートから」 (21-cashflow §10.7): the active recurring items whose entry can be built, by
 * name. A GET form: without JS the select and 「開く」 open `/entries/new?template=<id>`.
 */
function TemplatePicker({
  templates,
  current,
}: {
  templates: readonly RecurringEntryTemplate[];
  current: string | null;
}) {
  return (
    <Form action="/entries/new" className="flex items-center gap-2">
      <label className="min-w-0">
        <span className="sr-only">テンプレートから</span>
        <AutoSubmitSelect name="template" defaultValue={current ?? ""} className="min-w-44">
          <option value="">テンプレートから</option>
          {templates.map((template) => (
            <option key={template.recurringItemId} value={template.recurringItemId}>
              {template.name}
            </option>
          ))}
        </AutoSubmitSelect>
      </label>
      <Button type="submit" size="sm">
        開く
      </Button>
    </Form>
  );
}

type FlowTemplate = Extract<RecurringEntryTemplate, { type: "income" | "expense" }>;
type TransferTemplate = Extract<RecurringEntryTemplate, { type: "transfer" }>;

/** A 収入 / 支出 template as the form's first values (the date stays today). */
function simpleInitialOf(template: FlowTemplate): SimpleEntryInitial {
  return {
    counterpart: `wallet:${template.walletId}`,
    accountId: template.accountId,
    ...(template.taxCategoryCode ? { taxCategoryCode: template.taxCategoryCode } : {}),
    ...(template.segmentId ? { segmentId: template.segmentId } : {}),
    ...(template.partnerId ? { partnerId: template.partnerId } : {}),
    amount: formatYenInput(template.amount),
    description: template.description,
  };
}

/** A 振替 template: 出金元 → 入金先, the amount and the name. */
function transferInitialOf(template: TransferTemplate): TransferInitial {
  return {
    fromWalletId: template.fromWalletId,
    toWalletId: template.toWalletId,
    amount: formatYenInput(template.amount),
    description: template.description,
  };
}

/** 取引の登録 (11 §4): 収入 / 支出 / 振替 / 伝票, 支出 by default. */
export default async function NewEntryPage({ searchParams }: PageProps<"/entries/new">) {
  const {
    type,
    date,
    amount,
    partner,
    document: documentParam,
    template: templateParam,
  } = await searchParams;
  const prisma = await db();
  const templates = await listRecurringEntryTemplates(prisma);
  const templateId = queryText(templateParam, 64);
  const template = templateId
    ? (templates.find((item) => item.recurringItemId === templateId) ?? null)
    : null;
  // A template opens the form of its type (収入 / 支出 / 振替); the registration is a manual entry.
  const entryType = template ? template.type : isEntryType(type) ? type : "expense";
  const options = await loadEntryFormOptions(prisma);
  const candidates = await loadEntryCandidates(prisma);
  const today = todayInJapan();
  const entryDate = queryText(date, 10);
  // `?date=` (from a document or a 予定日) comes first; the forms default to `defaultEntryDate`.
  const dateParam = entryDate && isCalendarDate(entryDate) ? entryDate : undefined;
  const transferInitial: TransferInitial = {
    ...(template?.type === "transfer" ? transferInitialOf(template) : {}),
    ...(dateParam ? { entryDate: dateParam } : {}),
  };
  // 「この証憑から取引を登録」 (13 §4): the document's items start the 収入 / 支出 form, and the
  // document is linked once the entry is registered. Malformed values are left out.
  const initial: SimpleEntryInitial =
    template && template.type !== "transfer" ? simpleInitialOf(template) : {};
  if (dateParam) initial.entryDate = dateParam;
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
      <EntryTypeSwitch
        current={entryType}
        aside={
          templates.length > 0 ? (
            <TemplatePicker templates={templates} current={template?.recurringItemId ?? null} />
          ) : undefined
        }
      />
      {entryType === "voucher" ? (
        <VoucherForm
          key={dateParam ?? "voucher"}
          options={options}
          candidates={candidates}
          today={today}
          {...(dateParam ? { entryDate: dateParam } : {})}
          kinds={VOUCHER_KINDS}
          mode={{ kind: "new" }}
        />
      ) : entryType === "transfer" ? (
        <TransferForm
          key={[template?.recurringItemId ?? "transfer", dateParam].join("|")}
          options={options}
          today={today}
          initial={transferInitial}
        />
      ) : (
        <SimpleEntryForm
          key={[
            entryType,
            template?.recurringItemId,
            linkDocument?.id,
            initial.entryDate,
            initial.amount,
            initial.partnerId,
          ].join("|")}
          type={entryType}
          options={options}
          candidates={candidates}
          today={today}
          initial={initial}
          linkDocument={linkDocument}
        />
      )}
    </>
  );
}
