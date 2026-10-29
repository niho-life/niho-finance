import {
  loadPayableFormOptions,
  todayInJapan,
  type PayableFormDocument,
  type PayableFormOptions,
} from "@niho-finance/db";
import { DOCUMENT_KIND_LABELS, formatYen, formatYenInput } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate, walletLabel } from "@/lib/format";
import { PayableForm, type PayableFormModel } from "../_components/payable-form";

export const metadata: Metadata = { title: "受領した請求書を登録" };

function param(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length <= 64 ? first : null;
}

/** The chosen document (25 §7.1): its file, the search items and 「証憑を開く」. */
function ChosenDocument({ document }: { document: PayableFormDocument }) {
  return (
    <section
      aria-label="選んだ証憑"
      className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 rounded-card border border-border bg-surface px-4 py-3"
    >
      <div className="min-w-0">
        <p className="font-bold break-words">{document.originalName ?? "ファイル名なし"}</p>
        <p className="num text-[13px] text-muted">
          {[
            DOCUMENT_KIND_LABELS[document.kind],
            document.txnDate ? formatDate(document.txnDate) : "取引年月日なし",
            document.amount === null ? "金額なし" : `${formatYen(document.amount)} 円`,
            document.partnerName ?? "取引先なし",
          ].join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <a
          href={`/api/documents/${document.id}/file`}
          target="_blank"
          rel="noopener"
          className="font-bold underline underline-offset-4"
        >
          証憑を開く
        </a>
        <Link href="/payables/new" className="text-muted underline underline-offset-4">
          別の証憑を選ぶ
        </Link>
      </div>
    </section>
  );
}

/** 候補 (25 §7.1): 受信箱か受領した請求書で、支払の登録がないもの, newest first. */
function Candidates({ options }: { options: PayableFormOptions }) {
  if (options.candidates.length === 0) {
    return (
      <EmptyState
        title="登録できる証憑がありません"
        description="受け取った請求書を 証憑 にアップロード（または撮影）してから登録します"
        action={
          <ButtonLink href="/documents" size="sm">
            証憑を開く
          </ButtonLink>
        }
      />
    );
  }
  return (
    <section aria-labelledby="payable-candidates">
      <h2 id="payable-candidates" className="mb-1 text-[15px] font-extrabold">
        受領した請求書を選ぶ
      </h2>
      <p className="mb-3 text-[13px] text-muted">
        受信箱の証憑と受領した請求書のうち、まだ登録していないものを新しい順に出します。ないときは
        証憑 に保存してから選びます
      </p>
      <ul className="overflow-hidden rounded-card border border-border bg-surface">
        {options.candidates.map((candidate) => (
          <li key={candidate.id} className="border-b border-border last:border-b-0">
            <Link
              href={`/payables/new?document=${candidate.id}`}
              className="flex min-h-12 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-2.5 hover:bg-black/[0.02]"
            >
              <span className="min-w-0 flex-1 font-bold break-words">
                {candidate.originalName ?? "ファイル名なし"}
              </span>
              <span className="num text-[13px] text-muted">
                {[
                  candidate.txnDate ? formatDate(candidate.txnDate) : null,
                  candidate.partnerName,
                  candidate.amount === null ? null : `${formatYen(candidate.amount)} 円`,
                ]
                  .filter(Boolean)
                  .join(" · ") || DOCUMENT_KIND_LABELS[candidate.kind]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 未払として登録 (25 §7.1): `?document=` the received invoice to register (from the document's
 * detail), else the candidates to choose from. The form is filled from the document's search items
 * and the partner's defaults.
 */
export default async function NewPayablePage({ searchParams }: PageProps<"/payables/new">) {
  const query = await searchParams;
  const documentId = param(query.document);
  const prisma = await db();
  const options = await loadPayableFormOptions(prisma, { documentId });
  if (documentId && !options.document) notFound();
  const { document, values } = options;

  let body;
  if (!document) {
    body = <Candidates options={options} />;
  } else if (document.problem || !values) {
    body = (
      <>
        <ChosenDocument document={document} />
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
          {document.problem}
          {document.registered ? (
            <ButtonLink href={`/payables/${document.id}`} size="sm">
              支払を開く
            </ButtonLink>
          ) : null}
        </p>
      </>
    );
  } else {
    const model: PayableFormModel = {
      documentId: document.id,
      documentRegistrationNumber: document.invoiceRegistrationNumber,
      partners: options.partners,
      accounts: options.accounts,
      taxCategories: options.taxCategories,
      segments: options.segments,
      wallets: options.wallets.map((wallet) => ({ id: wallet.id, label: walletLabel(wallet) })),
      fiscalYears: options.fiscalYears.map((year) => ({
        startDate: year.startDate,
        endDate: year.endDate,
        lockedThrough: year.lockedThrough,
        accountingMethod: year.accountingMethod,
      })),
      taxRules: options.taxRules,
      defaults: options.defaults,
      initial: {
        partnerId: values.partnerId ?? "",
        invoiceDate: values.invoiceDate ?? todayInJapan(),
        amount: formatYenInput(values.amount),
        walletId: values.walletId ?? "",
      },
    };
    body = (
      <>
        <ChosenDocument document={document} />
        <PayableForm key={document.id} model={model} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="受領した請求書を登録" back={{ href: "/payables", label: "支払" }} />
      {body}
    </>
  );
}
