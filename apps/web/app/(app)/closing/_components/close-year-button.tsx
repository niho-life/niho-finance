"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { entryNo } from "@/lib/format";
import { closeYearAction } from "../actions";

/**
 * 「締める」 (16 §1.1, §10): the confirmation states the impact (当期純利益 → 繰越利益剰余金, every entry
 * read only) and lists the steps not done; they do not stop it.
 */
export function CloseYearButton({
  fiscalYearId,
  no,
  netIncome,
  isLoss,
  warnings,
}: {
  fiscalYearId: string;
  no: number;
  /** 当期純利益 (or the loss) before the closing entry, formatted without the sign. */
  netIncome: string;
  isLoss: boolean;
  warnings: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    startTransition(async () => {
      const result = await closeYearAction(fiscalYearId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      toast(
        result.data.closingEntryNo !== null
          ? `第 ${result.data.no} 期を締めました（決算振替 ${entryNo(result.data.closingEntryNo)}）`
          : `第 ${result.data.no} 期を締めました`,
      );
      // Stay on the closed year (the default year would move to the next one) to show its
      // closing entry and the next year's opening balances.
      router.replace(`/closing?year=${result.data.no}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
        締める
      </Button>
      <ConfirmDialog
        open={confirming}
        title={`第 ${no} 期を締めます`}
        confirmLabel="締める"
        pending={pending}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={close}
      >
        <p>
          {isLoss ? "当期純損失" : "当期純利益"}{" "}
          <span className="num font-bold">{netIncome} 円</span>{" "}
          を決算振替で繰越利益剰余金に振り替えます。
        </p>
        <p className="mt-2 font-bold">第 {no} 期の仕訳はすべて読み取り専用になります。</p>
        {warnings.length > 0 ? (
          <div className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <p className="font-bold">未完了の項目があります（締めることはできます）</p>
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-[13px] text-muted">
          直すときは「締めを戻す」で決算振替を取り消します（理由が要ります）。
        </p>
      </ConfirmDialog>
    </>
  );
}
