"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { pauseRecurringInvoiceAction, resumeRecurringInvoiceAction } from "../actions";

/**
 * 停止 / 再開 (18 §14.1, §14.5) through a confirmation: a paused recurring invoice has no due dates;
 * resumed, the due dates of the last 3 months come back (the months already made stay made).
 */
export function PauseButton({
  id,
  name,
  isActive,
}: {
  id: string;
  name: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = isActive
        ? await pauseRecurringInvoiceAction(id)
        : await resumeRecurringInvoiceAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      toast(isActive ? `${name} を停止しました` : `${name} を再開しました`);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" variant={isActive ? "ghost" : "secondary"} onClick={() => setOpen(true)}>
        {isActive ? "停止" : "再開"}
      </Button>
      <ConfirmDialog
        open={open}
        title={isActive ? `${name} を停止します` : `${name} を再開します`}
        confirmLabel={isActive ? "停止" : "再開"}
        pending={pending}
        error={error}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={confirm}
      >
        <p>
          {isActive
            ? "停止すると予定日が来ても下書きを作りません。作成済みの下書きと請求書はそのままです。再開すればまた予定日に出ます"
            : "再開すると、過ぎた 3 か月以内の予定日のうち未作成の月も「下書きを作る」に出ます"}
        </p>
      </ConfirmDialog>
    </>
  );
}
