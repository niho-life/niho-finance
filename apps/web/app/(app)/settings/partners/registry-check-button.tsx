"use client";

import type { RegistryCheckResult } from "@niho-finance/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { checkPartnerRegistrationsAction } from "./registry-actions";

/** 「12 件を照合しました（登録あり 10 · 未登録 1 · 登録終了 1）」 (counts of 0 left out). */
function summary(result: RegistryCheckResult): string {
  const parts = [
    result.registered > 0 ? `登録あり ${result.registered}` : null,
    result.notRegistered > 0 ? `未登録 ${result.notRegistered}` : null,
    result.ended > 0 ? `登録終了 ${result.ended}` : null,
  ].filter(Boolean);
  return `${result.checked} 件を照合しました${parts.length > 0 ? `（${parts.join(" · ")}）` : ""}`;
}

/** 「1 件は照合できませんでした（理由）」, or `null` when every number was answered. */
function failureText(result: RegistryCheckResult): string | null {
  if (result.failed === 0) return null;
  const reasons = result.errors.length > 0 ? `（${result.errors.join(" / ")}）` : "";
  return `${result.failed} 件は照合できませんでした${reasons}`;
}

/**
 * 照合する (20-reader §10.3): after a confirmation with the count, every active partner's valid
 * registration number is looked up at the National Tax Agency's publication; 照合 of the list
 * shows the stored result. A failure stays beside the button.
 */
export function RegistryCheckButton({
  count,
  lastChecked,
}: {
  /** Active partners with a valid number. */
  count: number;
  /** 「最後の照合 2026/11/01」 */
  lastChecked: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function check() {
    startTransition(async () => {
      const result = await checkPartnerRegistrationsAction();
      setAsking(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(failureText(result.data));
      if (result.data.checked > 0) toast(summary(result.data));
      else if (result.data.failed === 0) toast("照合できる登録番号がありません");
      router.refresh();
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          setError(null);
          setAsking(true);
        }}
      >
        {pending ? "照合中…" : "照合する"}
      </Button>
      {lastChecked ? (
        <span className="num text-[12px] text-muted">最後の照合 {lastChecked}</span>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-[12px] font-bold break-words text-danger">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={asking}
        title={`${count.toLocaleString("ja-JP")} 件の登録番号を国税庁の公表サイトで照合します`}
        confirmLabel="照合する"
        pending={pending}
        onCancel={() => setAsking(false)}
        onConfirm={check}
      >
        <p className="text-[13px] text-muted">
          有効な取引先の、形式と検査用数字が正しい登録番号だけを送ります。10 件ずつ、1
          秒以上の間隔で問い合わせます。
        </p>
      </ConfirmDialog>
    </div>
  );
}
