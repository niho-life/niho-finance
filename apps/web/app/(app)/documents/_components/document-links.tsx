"use client";

import type { DocumentLinkKind } from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { unlinkDocumentAction } from "../actions";

/** One link of a document, summarized on the server (no bigint crosses to the client). */
export interface LinkView {
  /** `import_batch`: the import that read this file (S4); it cannot be unlinked here. */
  kind: DocumentLinkKind | "import_batch";
  id: string;
  /** 仕訳 / 明細 / 請求書 */
  label: string;
  /** 「第1期 No. 12 · 2026/11/05 · 摘要 · 1,650」 */
  summary: string;
  /** The other side's page, when it has one. */
  href: string | null;
  /** e.g. 取消済み */
  note: string | null;
}

/**
 * 紐づけ (13 §4): the entries, statement lines and invoices the document is linked to, each with
 * 「外す」 (a confirmation). A voided document keeps its links as its record: no 「外す」.
 */
export function DocumentLinks({
  documentId,
  links,
  canUnlink,
}: {
  documentId: string;
  links: readonly LinkView[];
  canUnlink: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [asking, setAsking] = useState<LinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setAsking(null);
    setError(null);
  }

  function unlink() {
    if (!asking || asking.kind === "import_batch") return;
    const target = { ...asking, kind: asking.kind };
    startTransition(async () => {
      const result = await unlinkDocumentAction({
        kind: target.kind,
        id: target.id,
        documentId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      toast("紐づけを外しました");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="document-links">
      <h2 id="document-links" className="mb-2 text-[15px] font-extrabold">
        紐づけ
      </h2>
      {links.length === 0 ? (
        <p className="text-[13px] text-muted">まだどこにも紐づいていません</p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-border">
          {links.map((link) => (
            <li
              key={`${link.kind}:${link.id}`}
              className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
            >
              <span className="shrink-0 rounded-md bg-track px-1.5 py-0.5 text-[11px] font-bold text-muted">
                {link.label}
              </span>
              <span className="min-w-0 flex-1 text-[13px] break-words">
                {link.href ? (
                  <Link href={link.href} className="font-semibold underline underline-offset-4">
                    {link.summary}
                  </Link>
                ) : (
                  link.summary
                )}
                {link.note ? <span className="ml-1 text-muted">（{link.note}）</span> : null}
              </span>
              {canUnlink && link.kind !== "import_batch" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAsking(link)}
                  aria-label={`${link.label}「${link.summary}」との紐づけを外す`}
                >
                  外す
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={asking !== null}
        title="紐づけを外す"
        confirmLabel="外す"
        pending={pending}
        error={error}
        onCancel={close}
        onConfirm={unlink}
      >
        {asking ? (
          <>
            <p>
              {asking.label}「<span className="break-words">{asking.summary}</span>
              」との紐づけを外します。
            </p>
            <p className="mt-2 text-[13px] text-muted">
              証憑のファイルと項目、相手の記録はそのまま残ります。紐づけが 0
              件になると受信箱に戻ります。
            </p>
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
