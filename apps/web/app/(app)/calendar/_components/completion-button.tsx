"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { completeCalendarItemAction, reopenCalendarItemAction } from "../actions";

/**
 * 完了にする / 未完了に戻す (24 §3). No confirmation: nothing is posted and one click undoes it.
 * The outcome is a toast; the row moves between the open list and the completed fold.
 */
export function CompletionButton({
  id,
  title,
  completed,
}: {
  id: string;
  title: string;
  completed: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const label = completed ? "未完了に戻す" : "完了にする";

  function run() {
    startTransition(async () => {
      const result = completed
        ? await reopenCalendarItemAction(id)
        : await completeCalendarItemAction(id);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast(completed ? `「${title}」を未完了に戻しました` : `「${title}」を完了にしました`);
      router.refresh();
    });
  }

  return (
    <Button
      size="sm"
      variant={completed ? "ghost" : "secondary"}
      disabled={pending}
      aria-label={`${title} を${label}`}
      onClick={run}
    >
      {pending ? "処理中…" : label}
    </Button>
  );
}
