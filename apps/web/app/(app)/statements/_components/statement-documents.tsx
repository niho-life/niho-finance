"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { linkDocumentAction, unlinkDocumentAction } from "../../documents/actions";
import { Uploader } from "../../documents/_components/uploader";
import {
  loadStatementDocumentsAction,
  type StatementDocumentItem,
  type StatementDocumentsView,
} from "../actions";
import type { ClientStatementRow } from "./model";
import { lineSummary } from "./row-dialogs";

function Meta({ item }: { item: StatementDocumentItem }) {
  const unsorted = <span className="text-muted-2">未整理</span>;
  return (
    <span className="block truncate text-[12px] text-muted">
      {item.kind} · <span className="num">{item.date ?? unsorted}</span> ·{" "}
      <span className="num">{item.amount === null ? unsorted : `${item.amount} 円`}</span>
      {item.partner ? ` · ${item.partner}` : ""}
    </span>
  );
}

/**
 * 証憑 of a statement line (15 §5): the linked documents (外す), 「証憑を追加」 (upload or the camera,
 * linked to the line as it is saved, 13 §9) and the inbox with the same amount and the nearest
 * dates first (紐づける). The sheet stays open to link more than one; the list refreshes after each
 * change so that 「証憑なし」 goes away.
 */
export function StatementDocumentsSheet({
  row,
  thisYear,
  onClose,
}: {
  row: ClientStatementRow;
  thisYear: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [view, setView] = useState<StatementDocumentsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<StatementDocumentItem | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let current = true;
    void loadStatementDocumentsAction(row.id).then((result) => {
      if (!current) return;
      if (result.ok) {
        setView(result.data);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, [row.id, version]);

  /** After a change: reload the sheet and the list (the row's 「証憑なし」). */
  function changed(message: string) {
    toast(message);
    setVersion((value) => value + 1);
    router.refresh();
  }

  function link(item: StatementDocumentItem) {
    setBusyId(item.id);
    startTransition(async () => {
      const result = await linkDocumentAction({
        kind: "wallet_transaction",
        id: row.id,
        documentId: item.id,
      });
      setBusyId(null);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      changed(`「${item.title}」を紐づけました`);
    });
  }

  function unlink() {
    const item = unlinking;
    if (!item) return;
    setBusyId(item.id);
    startTransition(async () => {
      const result = await unlinkDocumentAction({
        kind: "wallet_transaction",
        id: row.id,
        documentId: item.id,
      });
      setBusyId(null);
      if (!result.ok) {
        setUnlinkError(result.error);
        return;
      }
      setUnlinking(null);
      setUnlinkError(null);
      changed(`「${item.title}」の紐づけを外しました`);
    });
  }

  return (
    <Sheet open onClose={onClose} title="証憑" description={lineSummary(row, thisYear)}>
      {loadError ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {loadError}
        </p>
      ) : null}

      <section aria-labelledby="statement-documents-linked">
        <h3 id="statement-documents-linked" className="mb-1 text-[13px] font-bold text-muted">
          紐づいた証憑
        </h3>
        {view === null && !loadError ? (
          <p className="py-2 text-[13px] text-muted">読み込み中…</p>
        ) : view && view.linked.length === 0 ? (
          <p className="py-2 text-[13px] text-muted">この明細に紐づく証憑はありません</p>
        ) : (
          <ul>
            {view?.linked.map((item) => (
              <li
                key={item.id}
                className={`flex items-center gap-2 border-b border-border py-2 last:border-b-0 ${
                  item.voided ? "text-muted" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <Link
                    href={`/documents/${item.id}`}
                    className="block truncate text-[14px] font-semibold underline-offset-4 hover:underline"
                  >
                    {item.title}
                  </Link>
                  <Meta item={item} />
                  {item.voided ? (
                    <span className="block text-[11px] text-muted">{item.status}</span>
                  ) : null}
                </span>
                {item.voided ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === item.id}
                    onClick={() => {
                      setUnlinkError(null);
                      setUnlinking(item);
                    }}
                  >
                    外す
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4">
        <Uploader
          compact
          link={{ kind: "wallet_transaction", id: row.id }}
          onSaved={(outcome) =>
            changed(
              outcome.saved.length + outcome.duplicates.length > 1
                ? "証憑を保存して紐づけました"
                : "証憑を紐づけました",
            )
          }
        />
      </section>

      <section aria-labelledby="statement-documents-inbox" className="mt-5">
        <h3 id="statement-documents-inbox" className="mb-1 text-[13px] font-bold text-muted">
          受信箱から選ぶ
        </h3>
        <p className="mb-1 text-[12px] text-muted-2">同じ金額・近い日付の証憑を先に並べます</p>
        {view && view.inbox.length === 0 ? (
          <p className="py-2 text-[13px] text-muted">受信箱に証憑はありません</p>
        ) : (
          <ul>
            {view?.inbox.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 border-b border-border py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <Link
                      href={`/documents/${item.id}`}
                      className="min-w-0 truncate text-[14px] font-semibold underline-offset-4 hover:underline"
                    >
                      {item.title}
                    </Link>
                    {item.sameAmount ? (
                      <span className="shrink-0 rounded-full bg-primary-soft px-2 text-[11px] font-bold text-primary-ink">
                        同じ金額
                      </span>
                    ) : null}
                  </span>
                  <Meta item={item} />
                </span>
                <Button
                  size="sm"
                  variant={item.sameAmount ? "primary" : "secondary"}
                  disabled={busyId === item.id}
                  onClick={() => link(item)}
                >
                  紐づける
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={unlinking !== null}
        title="証憑の紐づけを外します"
        confirmLabel="外す"
        pending={unlinking !== null && busyId === unlinking.id}
        error={unlinkError}
        onCancel={() => {
          setUnlinking(null);
          setUnlinkError(null);
        }}
        onConfirm={unlink}
      >
        <p>
          「{unlinking?.title}
          」とこの明細の紐づけを外します。証憑は残り、ほかに紐づけがなければ受信箱に戻ります。
        </p>
      </ConfirmDialog>
    </Sheet>
  );
}
