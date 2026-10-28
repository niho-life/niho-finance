"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";
import { useToast } from "@/components/ui/toast";
import { uploadDocument } from "@/lib/documents/upload-client";
import { NavIcon } from "./icons";

/**
 * 証憑を撮影, the centre of the phone tabs (10 §1.1, 13 §2): a `<label>` around a hidden camera
 * input, drawn as the primary round button. The photo is saved (`source: camera`) and its detail
 * opens, where unprocessed statement lines of nearby dates are offered (13 §4): 撮影 → 保存して詳細
 * → 紐づける. The list is reached through その他 › 証憑. The messages are those of the uploader.
 */
export function CaptureTab() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Taking a photo of the same file again must fire `change` again.
    input.value = "";
    if (!file || busy) return;
    setBusy(true);
    const result = await uploadDocument(file, { source: "camera" });
    setBusy(false);
    if (result.outcome === "error") {
      toast(result.message, { tone: "error" });
      return;
    }
    toast(
      result.outcome === "saved"
        ? "証憑を保存しました"
        : "保存済みのファイルと同じです。保存済みの証憑を開きます",
    );
    router.push(`/documents/${result.documentId}`);
  }

  return (
    <label
      className={`flex min-h-12 flex-col items-center justify-center ${
        busy ? "cursor-progress" : "cursor-pointer"
      }`}
    >
      {/* The input sits in the circle so that its keyboard focus rings the circle. */}
      <span
        className={`-mt-4 flex size-11 items-center justify-center rounded-full bg-primary text-white shadow-float has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary ${
          busy ? "opacity-60 motion-safe:animate-pulse" : ""
        }`}
      >
        <NavIcon name="camera" className="size-[22px]" />
        <input
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="証憑を撮影"
          aria-busy={busy || undefined}
          className="sr-only"
          disabled={busy}
          onChange={(event) => void save(event)}
        />
      </span>
      <span role="status" className="sr-only">
        {busy ? "保存しています" : ""}
      </span>
    </label>
  );
}
