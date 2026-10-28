"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { voidDocumentAction } from "../actions";
import { ReasonDialog } from "./reason-dialog";

/**
 * 無効にする (13 §4): a danger confirmation with the reason (required, 200 characters). The file
 * and the links stay; the page stays and shows the band.
 */
export function VoidDocumentButton({ documentId, title }: { documentId: string; title: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setError(null);
  }

  function confirm(reason: string) {
    startTransition(async () => {
      const result = await voidDocumentAction(documentId, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      toast("証憑を無効にしました");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={() => setOpen(true)}
      >
        無効にする
      </Button>
      <ReasonDialog
        open={open}
        title={
          <>
            「<span className="wrap-anywhere">{title}</span>」を無効にします
          </>
        }
        confirmLabel="無効にする"
        variant="danger"
        pending={pending}
        error={error}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>紐づけは残り、検索にも理由つきで出ます。ファイルは消えません。無効は元に戻せません。</p>
      </ReasonDialog>
    </>
  );
}
