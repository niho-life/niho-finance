"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { readDocumentAction } from "../reading-actions";

interface Progress {
  /** The document being read, from 1. */
  current: number;
  total: number;
  stopping: boolean;
}

/** 「12 件を読み取りました（要確認 3 件・読み取れず 1 件）」 */
function summary(read: number, needsReview: number, failed: number): string {
  const notes = [
    needsReview > 0 ? `要確認 ${needsReview} 件` : null,
    failed > 0 ? `読み取れず ${failed} 件` : null,
  ].filter(Boolean);
  return `${read} 件を読み取りました${notes.length > 0 ? `（${notes.join("・")}）` : ""}`;
}

/**
 * 受信箱の一括読み取り (20-reader §10.2): 「読み取っていない証憑 n 件」 and まとめて読み取る. After a
 * confirmation with the estimated cost, the browser reads the documents one by one (oldest
 * first, at most `ids.length` = 20 at a time) with `readDocumentAction`; 止める stops before the
 * next one. A reading only stores a proposal: the items stay as they are. Leaving the page stops
 * the run the same way.
 */
export function BulkReader({
  ids,
  total,
  costPerDocument,
}: {
  /** The unread inbox documents to read now, oldest first (at most 20). */
  ids: readonly string[];
  /** All unread inbox documents. */
  total: number;
  /** 「$0.0007」 */
  costPerDocument: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    // Each reading revalidates the page: the list of ids is taken once, here.
    const targets = [...ids];
    setAsking(false);
    setError(null);
    stopped.current = false;
    let read = 0;
    let needsReview = 0;
    let failed = 0;
    for (const [index, id] of targets.entries()) {
      if (stopped.current || !mounted.current) break;
      setProgress((current) => ({
        current: index + 1,
        total: targets.length,
        stopping: current?.stopping ?? false,
      }));
      const result = await readDocumentAction(id);
      if (!result.ok) {
        // Not a failed reading (that is stored and counted): something the owner must see.
        setError(result.error);
        break;
      }
      read += 1;
      if (result.data.status === "failed") failed += 1;
      else if (result.data.issueCount > 0) needsReview += 1;
    }
    setProgress(null);
    if (read > 0) toast(summary(read, needsReview, failed));
    router.refresh();
  }

  function stop() {
    stopped.current = true;
    setProgress((current) => (current ? { ...current, stopping: true } : current));
  }

  if (total === 0 && progress === null && error === null) return null;

  const count = ids.length;
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        {progress ? (
          <>
            <p className="num text-[13px]" aria-live="polite">
              読み取り中 {progress.current} / {progress.total}
            </p>
            <Button size="sm" variant="ghost" disabled={progress.stopping} onClick={stop}>
              {progress.stopping ? "止めています…" : "止める"}
            </Button>
          </>
        ) : total > 0 ? (
          <>
            <p className="num text-[13px]">
              読み取っていない証憑 {total.toLocaleString("ja-JP")} 件
            </p>
            <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
              まとめて読み取る
            </Button>
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[12px] font-bold break-words text-danger">
          読み取りを止めました（{error}）
        </p>
      ) : null}
      <ConfirmDialog
        open={asking}
        title={`${count} 件を読み取ります`}
        confirmLabel="読み取る"
        onCancel={() => setAsking(false)}
        onConfirm={() => void run()}
      >
        <p>
          1 件あたり約 <span className="num">{costPerDocument}</span>
          。読み取った内容は提案として入り、項目は変わりません。
        </p>
        {total > count ? (
          <p className="mt-2 text-[13px] text-muted">
            読み取っていない {total.toLocaleString("ja-JP")} 件のうち、保存の古い順に {count}{" "}
            件です（1 回に {count} 件まで）。
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
