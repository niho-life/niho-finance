"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Textarea } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { uploadDocument, type UploadState } from "@/lib/documents/upload-client";
import { DOCUMENT_ACCEPT } from "./uploader";

const STATE_LABELS: Readonly<Record<UploadState, string>> = {
  hashing: "計算中",
  uploading: "送信中",
  registering: "登録中",
};

interface Problem {
  message: string;
  /** The stored document that already has the chosen file. */
  existingId?: string;
}

function ReplaceSheet({
  documentId,
  title,
  onClose,
}: {
  documentId: string;
  title: string;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const formId = `${id}-form`;
  const ready = file !== null && reason.trim() !== "" && !busy;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !file) return;
    setBusy(true);
    setProblem(null);
    const result = await uploadDocument(file, {
      source: "upload",
      supersedesId: documentId,
      reason: reason.trim(),
      onState: setState,
    });
    setBusy(false);
    setState(null);
    if (result.outcome === "error") {
      setProblem({ message: result.message });
      return;
    }
    if (result.outcome === "duplicate") {
      // Nothing changed: the original stays as it is.
      setProblem(
        result.documentId === documentId
          ? { message: "この証憑と同じファイルです。差し替える別のファイルを選んでください" }
          : {
              message: "このファイルは保存済みの証憑と同じです。元の証憑は変えていません",
              existingId: result.documentId,
            },
      );
      return;
    }
    toast("差し替えました");
    router.push(`/documents/${result.documentId}`);
  }

  return (
    <Sheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="差し替える"
      description={<span className="wrap-anywhere">{title}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!ready}>
            {busy ? "処理中…" : "差し替える"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          新しい証憑が元の項目（種別・取引年月日・金額・取引先・登録番号・メモ）と紐づけを引き継ぎ、元の証憑は「差し替え:
          理由」で無効になります。
        </p>
        <FormField label="理由" htmlFor={`${id}-reason`} required help="200 字まで">
          <Textarea
            id={`${id}-reason`}
            value={reason}
            maxLength={200}
            required
            disabled={busy}
            aria-describedby={`${id}-reason-help`}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </FormField>
        <FormField
          label="新しいファイル"
          htmlFor={`${id}-file`}
          required
          help="画像・PDF・CSV、20 MB まで"
        >
          <input
            id={`${id}-file`}
            type="file"
            accept={DOCUMENT_ACCEPT}
            required
            disabled={busy}
            aria-describedby={`${id}-file-help`}
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setProblem(null);
            }}
            className="block w-full min-w-0 text-[13px] text-muted file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-lg file:border file:border-border-2 file:bg-surface file:px-3 file:text-[13px] file:font-bold file:text-text"
          />
        </FormField>
        {state ? (
          <p aria-live="polite" className="text-[13px] text-muted">
            {STATE_LABELS[state]}…
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {problem.message}
            {problem.existingId ? (
              <>
                {" "}
                <Link
                  href={`/documents/${problem.existingId}`}
                  className="font-bold underline underline-offset-4"
                >
                  保存済みの証憑を開く
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

/**
 * 差し替える (13 §4): the reason and one new file. The new document inherits the items and the
 * links, and the original is voided with 「差し替え: 理由」; the page moves to the new document. A
 * file that is already stored changes nothing (a link to that document is shown).
 */
export function ReplaceDocumentButton({
  documentId,
  title,
}: {
  documentId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        差し替える
      </Button>
      {open ? (
        <ReplaceSheet documentId={documentId} title={title} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
