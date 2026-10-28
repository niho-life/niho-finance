"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { saveInvoicePdfAction } from "../actions";

/** PDF を証憑に保存 (18 §11): for an issued document whose PDF was not saved on issue. */
export function SavePdfButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await saveInvoicePdfAction(invoiceId);
          if (!result.ok) {
            toast(result.error, { tone: "error" });
            return;
          }
          toast("PDF を証憑に保存しました");
          router.refresh();
        })
      }
    >
      {pending ? "保存中…" : "PDF を証憑に保存"}
    </Button>
  );
}
