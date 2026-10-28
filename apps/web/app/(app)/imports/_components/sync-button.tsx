"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { syncStripeAction } from "../actions";
import { countsText } from "../_lib/format";

/**
 * 同期 of a connected Stripe wallet (12-imports §4.4): runs at once, tells the result in a toast
 * (新規・重複・失敗, or why it failed) and refreshes the page, whose history shows the batch.
 */
export function SyncButton({
  walletId,
  walletName,
  variant = "secondary",
  size = "sm",
}: {
  walletId: string;
  walletName: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function sync() {
    startTransition(async () => {
      const result = await syncStripeAction(walletId);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
      } else if (result.data.error) {
        toast(`${walletName} を同期できませんでした。${result.data.error}`, { tone: "error" });
      } else {
        toast(`${walletName} を同期しました。${countsText(result.data)}`);
      }
      router.refresh();
    });
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={sync}
      disabled={pending}
      aria-label={`${walletName} を同期`}
    >
      {pending ? "同期中…" : "同期"}
    </Button>
  );
}
