import {
  findLinkCandidates,
  getDocumentDetail,
  listPartners,
  type DocumentDetail,
  type DocumentLinkEntry,
} from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_LINK_KIND_LABELS,
  DOCUMENT_SOURCE_LABELS,
  ENTRY_STATUS_LABELS,
  formatYen,
  formatYenInput,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { Band } from "../_components/band";
import { DocumentHistory } from "../_components/document-history";
import { DocumentLinks, type LinkView } from "../_components/document-links";
import { DocumentMeta, type DocumentItems } from "../_components/document-meta";
import { DocumentPreview } from "../_components/document-preview";
import { LinkCandidates, type CandidateView } from "../_components/link-candidates";
import { documentTitle } from "../_components/list-query";
import { ReplaceDocumentButton } from "../_components/replace-document";
import { VoidDocumentButton } from "../_components/void-document";

export const metadata: Metadata = { title: "証憑の詳細" };

/** States of a statement line (05-ui-ux §2.2), for the summaries. */
const LINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: "未処理",
  registered: "登録済み",
  transfer: "振替",
  ignored: "無視",
};

function apart(days: number): string {
  return days === 0 ? "同じ日" : `${days} 日差`;
}

/** 「登録済み · 証憑あり」: a candidate that another document already evidences is marked. */
function candidateNote(status: string | null, documentCount: number): string | null {
  const notes = [status, documentCount > 0 ? "証憑あり" : null].filter(Boolean);
  return notes.length > 0 ? notes.join(" · ") : null;
}

/** 「第1期 No. 12 · 2026/11/05 · 摘要 · 1,650」 and the like (13 §4). */
function linkView(link: DocumentLinkEntry): LinkView {
  const label = DOCUMENT_LINK_KIND_LABELS[link.kind];
  switch (link.kind) {
    case "journal_entry":
      return {
        kind: link.kind,
        id: link.id,
        label,
        summary: `第${link.fiscalYearNo}期 No. ${link.no} · ${formatDate(link.entryDate)} · ${link.description} · ${formatYen(link.amount)}`,
        href: `/entries/${link.id}`,
        note: link.status === "posted" ? null : ENTRY_STATUS_LABELS[link.status],
      };
    case "wallet_transaction":
      return {
        kind: link.kind,
        id: link.id,
        label,
        summary: `${link.walletName} · ${formatDate(link.txnDate)} · ${link.description} · ${formatYen(link.amount)}`,
        href: null,
        note: link.status === "pending" ? null : (LINE_STATUS_LABELS[link.status] ?? null),
      };
    case "invoice":
      return { kind: link.kind, id: link.id, label, summary: link.number, href: null, note: null };
  }
}

/** 「この証憑から取引を登録」: the 支出 form with the document's items (empty ones left out). */
function newEntryHref(detail: DocumentDetail): string {
  const params = new URLSearchParams({ type: "expense" });
  if (detail.txnDate) params.set("date", detail.txnDate);
  if (detail.amount !== null && detail.amount > 0n) params.set("amount", detail.amount.toString());
  if (detail.partnerId) params.set("partner", detail.partnerId);
  params.set("document", detail.id);
  return `/entries/new?${params.toString()}`;
}

/** The state bands (13 §4): 無効, 差し替え済み → 新しい証憑, （元）の差し替え. */
function Bands({ detail }: { detail: DocumentDetail }) {
  const bands: ReactNode[] = [];
  if (detail.status === "voided") {
    bands.push(
      <Band key="voided">
        無効（{detail.voidedAt ? formatDateTime(detail.voidedAt) : "—"} · 理由:{" "}
        {detail.voidReason ?? "—"}）
      </Band>,
    );
  }
  if (detail.supersededBy) {
    bands.push(
      <Band key="superseded-by">
        差し替え済み →{" "}
        <Link
          href={`/documents/${detail.supersededBy.id}`}
          className="font-bold underline underline-offset-4"
        >
          {documentTitle(detail.supersededBy)}
        </Link>
      </Band>,
    );
  }
  if (detail.supersedes) {
    bands.push(
      <Band key="supersedes">
        <Link
          href={`/documents/${detail.supersedes.id}`}
          className="font-bold underline underline-offset-4"
        >
          {documentTitle(detail.supersedes)}
        </Link>{" "}
        の差し替え
      </Band>,
    );
  }
  if (detail.status === "voided" && !detail.supersededBy) {
    bands.push(
      <Band key="fixed">
        無効にした証憑は変えられません。正しいファイルは新しい証憑として保存します
      </Band>,
    );
  }
  if (bands.length === 0) return null;
  return <div className="mb-4 flex flex-col gap-2">{bands}</div>;
}

/**
 * 証憑の詳細 (13 §4): the preview, the items edited in place, the links, the candidates, 無効にする,
 * 差し替える, 「この証憑から取引を登録」 and the history. PC: preview left, the rest in 380px right.
 */
export default async function DocumentDetailPage({ params }: PageProps<"/documents/[id]">) {
  const { id } = await params;
  const prisma = await db();
  const detail = await getDocumentDetail(prisma, id);
  if (!detail) notFound();
  const voided = detail.status === "voided";
  const candidates = voided ? null : await findLinkCandidates(prisma, { documentId: detail.id });
  const partners = (await listPartners(prisma))
    .filter((partner) => partner.isActive || partner.id === detail.partnerId)
    .map((partner) => ({
      value: partner.id,
      label: partner.isActive ? partner.name : `${partner.name}（無効）`,
    }));

  const title = documentTitle(detail);
  const meta = [
    DOCUMENT_KIND_LABELS[detail.kind],
    `${formatDateTime(detail.uploadedAt)} に ${detail.uploadedBy} が保存`,
    DOCUMENT_SOURCE_LABELS[detail.source],
  ].join(" · ");
  const items: DocumentItems = {
    kind: detail.kind,
    txnDate: detail.txnDate ?? "",
    amount: formatYenInput(detail.amount),
    partnerId: detail.partnerId ?? "",
    partnerName: detail.partnerName ?? "",
    partnerLabel: detail.displayPartnerName ?? "",
    invoiceRegistrationNumber: detail.invoiceRegistrationNumber ?? "",
    note: detail.note ?? "",
  };
  const linkKey = detail.links.map((link) => `${link.kind}:${link.id}`).join(",");
  const lineCandidates: CandidateView[] = (candidates?.walletTransactions ?? []).map((line) => ({
    kind: "wallet_transaction",
    id: line.id,
    date: formatDate(line.txnDate),
    apart: apart(line.daysApart),
    where: line.walletName,
    description: line.description,
    amount: formatYen(line.amount),
    note: candidateNote(
      line.status === "pending" ? null : (LINE_STATUS_LABELS[line.status] ?? null),
      line.documentCount,
    ),
  }));
  const entryCandidates: CandidateView[] = (candidates?.journalEntries ?? []).map((entry) => ({
    kind: "journal_entry",
    id: entry.id,
    date: formatDate(entry.entryDate),
    apart: apart(entry.daysApart),
    where: `第${entry.fiscalYearNo}期 No. ${entry.no}`,
    description: entry.description,
    amount: formatYen(entry.amount),
    note: candidateNote(null, entry.documentCount),
  }));

  return (
    <>
      <PageHeader
        title={<span className="wrap-anywhere">{title}</span>}
        meta={meta}
        back={{ href: "/documents", label: "証憑" }}
        actions={
          voided ? undefined : (
            <>
              <ButtonLink href={newEntryHref(detail)} size="sm">
                この証憑から取引を登録
              </ButtonLink>
              <ReplaceDocumentButton documentId={detail.id} title={title} />
              <VoidDocumentButton documentId={detail.id} title={title} />
            </>
          )
        }
      />
      <Bands detail={detail} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <DocumentPreview
          id={detail.id}
          title={title}
          mime={detail.mime}
          byteSize={detail.byteSize}
          sha256={detail.sha256}
        />
        <div className="flex min-w-0 flex-col gap-6">
          {/* A new link can fill empty items on the server: the cells start over from them. */}
          <DocumentMeta
            key={`${detail.status}|${linkKey}`}
            id={detail.id}
            items={items}
            partners={partners}
            voided={voided}
            unsorted={detail.unsorted}
          />
          <DocumentLinks
            documentId={detail.id}
            links={detail.links.map(linkView)}
            canUnlink={!voided}
          />
          {candidates ? (
            <LinkCandidates
              documentId={detail.id}
              basis={candidates.basis}
              walletTransactions={lineCandidates}
              journalEntries={entryCandidates}
            />
          ) : null}
        </div>
      </div>
      <DocumentHistory rows={detail.history} />
    </>
  );
}
