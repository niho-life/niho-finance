"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { linkDocumentAction } from "../actions";

/** A document of the inbox as the sheet lists it (formatted on the server). */
export interface InboxDocument {
  id: string;
  title: string;
  /** 領収書 … */
  kind: string;
  /** 2026/11/07, or `null` (未整理). */
  date: string | null;
  /** With grouping, or `null` (未整理). */
  amount: string | null;
  partner: string | null;
  /** The same amount as the entry's debit total: listed first. */
  sameAmount: boolean;
}

/**
 * 受信箱から選ぶ (13 §9, 取引の詳細): the inbox in a sheet, the documents of the entry's amount
 * first, each with 「紐づける」. The sheet stays open to link more than one.
 */
export function InboxPicker({
  entryId,
  documents,
}: {
  entryId: string;
  documents: readonly InboxDocument[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function link(item: InboxDocument) {
    setLinking(item.id);
    startTransition(async () => {
      const result = await linkDocumentAction({
        kind: "journal_entry",
        id: entryId,
        documentId: item.id,
      });
      setLinking(null);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast(`「${item.title}」を紐づけました`);
      router.refresh();
    });
  }

  const unsorted = <span className="text-muted">未整理</span>;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        受信箱から選ぶ
      </Button>
      {open ? (
        <Sheet
          open
          onClose={() => setOpen(false)}
          title="受信箱から選ぶ"
          description="この取引と同じ金額の証憑を先に並べています"
        >
          {documents.length === 0 ? (
            <p className="text-[14px] text-muted">受信箱は空です</p>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {documents.map((item) => (
                <li
                  key={item.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-1 py-2.5 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{item.title}</span>
                    <span className="num block text-[12px] text-muted">
                      {item.kind} · {item.date ?? unsorted} · {item.amount ?? unsorted}
                      {item.partner ? ` · ${item.partner}` : ""}
                      {item.sameAmount ? (
                        <span className="ml-1.5 rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-bold text-primary-ink">
                          同じ金額
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={linking !== null}
                    onClick={() => link(item)}
                    aria-label={`「${item.title}」を紐づける`}
                  >
                    {linking === item.id ? "処理中…" : "紐づける"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
