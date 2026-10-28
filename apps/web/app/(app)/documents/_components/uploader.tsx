"use client";

import type { DocumentLinkKind, DocumentSource } from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { NavIcon } from "@/components/app-shell/icons";
import { buttonClass } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  uploadDocuments,
  type UploadResult,
  type UploadState,
} from "@/lib/documents/upload-client";
import { linkDocumentAction } from "../actions";

/** Images (HEIC too), PDF and CSV (13 §3.1). */
export const DOCUMENT_ACCEPT = "image/*,.heic,.heif,application/pdf,.pdf,text/csv,.csv";

type Progress =
  | { phase: "waiting" | UploadState }
  | { phase: "saved"; documentId: string }
  /** `linked`: the stored document was linked to `link` instead (the same file was chosen). */
  | { phase: "duplicate"; documentId: string; linked: boolean }
  | { phase: "error"; message: string };

interface Row {
  key: number;
  name: string;
  progress: Progress;
}

export interface UploadOutcome {
  /** Documents stored now. */
  saved: string[];
  /** Documents that already had a chosen file. */
  duplicates: string[];
}

const PHASE_LABELS: Readonly<Record<"waiting" | UploadState, string>> = {
  waiting: "待機中",
  hashing: "計算中",
  uploading: "送信中",
  registering: "登録中",
};

function toProgress(result: UploadResult): Progress {
  if (result.outcome === "error") return { phase: "error", message: result.message };
  if (result.outcome === "duplicate") {
    return { phase: "duplicate", documentId: result.documentId, linked: false };
  }
  return { phase: "saved", documentId: result.documentId };
}

function ProgressText({ progress }: { progress: Progress }) {
  switch (progress.phase) {
    case "waiting":
    case "hashing":
    case "uploading":
    case "registering":
      return <span className="text-muted">{PHASE_LABELS[progress.phase]}…</span>;
    case "saved":
      return <span className="text-primary-ink">保存済み</span>;
    case "duplicate":
      return (
        <span>
          保存済みのファイルと同じ
          {progress.linked ? "（保存済みの証憑を紐づけました）" : ""}
          <Link
            href={`/documents/${progress.documentId}`}
            className="ml-2 font-bold underline underline-offset-4"
          >
            開く
          </Link>
        </span>
      );
    case "error":
      return <span className="font-bold text-danger">エラー（{progress.message}）</span>;
  }
}

/**
 * 保存 of evidence files (13 §3.1). PC: a drop zone (click / Enter / Space choose files). Phones:
 * 「撮影」 (the camera, `capture`) and 「選ぶ」. Files go one after another through
 * `upload-client.ts`; a small table shows each one's state. One file saved (or already stored)
 * opens its detail; several refresh the list. Afterwards only failures and duplicates stay listed.
 *
 * `link` links every new document in the same transaction (an already stored file is linked as
 * it is). `compact`: one small button (and 「撮影」 on phones), for a section of another page.
 * `onSaved` replaces the navigation afterwards (e.g. refresh the page the uploader sits on).
 * `actions`: more buttons in the compact row (e.g. 「受信箱から選ぶ」).
 */
export function Uploader({
  link,
  compact = false,
  onSaved,
  actions,
}: {
  link?: { kind: DocumentLinkKind; id: string };
  compact?: boolean;
  onSaved?: (outcome: UploadOutcome) => void;
  actions?: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const pickRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function start(files: File[], source: DocumentSource) {
    if (files.length === 0 || busy) return;
    const base = nextKey.current;
    nextKey.current += files.length;
    setRows(
      files.map((file, index) => ({
        key: base + index,
        name: file.name,
        progress: { phase: "waiting" },
      })),
    );
    setBusy(true);
    const update = (index: number, progress: Progress) =>
      setRows((current) =>
        current.map((row) => (row.key === base + index ? { ...row, progress } : row)),
      );

    const results = await uploadDocuments(files, {
      source,
      link: link ?? null,
      onState: (index, state) => update(index, { phase: state }),
      onResult: (index, result) => update(index, toProgress(result)),
    });
    const outcomes: Progress[] = [];
    for (const [index, result] of results.entries()) {
      let progress = toProgress(result);
      // The file is already stored: link that document instead (the same as `complete` does).
      if (result.outcome === "duplicate" && link) {
        const linked = await linkDocumentAction({ ...link, documentId: result.documentId });
        progress = linked.ok
          ? { phase: "duplicate", documentId: result.documentId, linked: true }
          : { phase: "error", message: linked.error };
        update(index, progress);
      }
      outcomes.push(progress);
    }
    setBusy(false);
    // Only failures and duplicates stay in the table.
    setRows((current) => current.filter((row) => row.progress.phase !== "saved"));

    const outcome: UploadOutcome = {
      saved: outcomes.flatMap((item) => (item.phase === "saved" ? [item.documentId] : [])),
      duplicates: outcomes.flatMap((item) => (item.phase === "duplicate" ? [item.documentId] : [])),
    };
    if (onSaved) {
      onSaved(outcome);
      return;
    }
    const [only] = outcomes;
    if (files.length === 1 && only && (only.phase === "saved" || only.phase === "duplicate")) {
      toast(
        only.phase === "saved"
          ? "証憑を保存しました"
          : "保存済みのファイルと同じです。保存済みの証憑を開きます",
      );
      router.push(`/documents/${only.documentId}`);
      return;
    }
    if (outcome.saved.length > 0) toast(`${outcome.saved.length} 件を保存しました`);
    router.refresh();
  }

  function choose(input: HTMLInputElement, source: DocumentSource) {
    const files = Array.from(input.files ?? []);
    // Choosing the same file again must fire `change` again.
    input.value = "";
    void start(files, source);
  }

  function openPicker() {
    if (!busy) pickRef.current?.click();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void start(Array.from(event.dataTransfer.files), "upload");
  }

  /** A `<label>` around a hidden file input, drawn as a button (keyboard: the input has focus). */
  const pickLabel = (variant: "primary" | "secondary", size: "sm" | "md", extra = "") =>
    `${buttonClass({ variant, size })} has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary ${
      busy ? "pointer-events-none opacity-50" : "cursor-pointer"
    } ${extra}`;

  const camera = (size: "sm" | "md", extra = "") => (
    <label className={pickLabel("primary", size, extra)}>
      <NavIcon name="camera" className={size === "md" ? "size-5" : "size-4"} />
      撮影
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={busy}
        onChange={(event) => choose(event.currentTarget, "camera")}
      />
    </label>
  );

  const picker = (label: string, size: "sm" | "md", extra = "") => (
    <label className={pickLabel("secondary", size, extra)}>
      {label}
      <input
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        disabled={busy}
        onChange={(event) => choose(event.currentTarget, "upload")}
      />
    </label>
  );

  const progress =
    rows.length > 0 ? (
      <div
        role="table"
        aria-label="保存の状況"
        className="mt-3 overflow-hidden rounded-card border border-border text-[13px]"
      >
        <div role="rowgroup" aria-live="polite">
          {rows.map((row) => (
            <div
              key={row.key}
              role="row"
              className="grid grid-cols-1 gap-x-3 gap-y-0.5 border-b border-border px-3.5 py-2 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
            >
              <span role="cell" className="truncate font-semibold">
                {row.name}
              </span>
              <span role="cell" className="min-w-0 break-words">
                <ProgressText progress={row.progress} />
              </span>
            </div>
          ))}
        </div>
        {!busy ? (
          <div className="flex justify-end border-t border-border bg-surface-2 px-2 py-1">
            <button
              type="button"
              onClick={() => setRows([])}
              className="inline-flex min-h-8 items-center rounded-lg px-2 text-[12px] font-bold text-muted hover:bg-black/5 hover:text-text"
            >
              表示を消す
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  if (compact) {
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          {camera("sm", "md:hidden")}
          {picker("証憑を追加", "sm")}
          {actions}
        </div>
        {progress}
      </div>
    );
  }

  return (
    <div className="mb-5">
      <div className="grid grid-cols-2 gap-2 md:hidden">
        {camera("md", "min-h-12 text-[15px]")}
        {picker("選ぶ", "md", "min-h-12 text-[15px]")}
      </div>
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy || undefined}
        aria-label="証憑を保存する。ここにドロップ、または選ぶ"
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`hidden flex-col items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-dashed px-4 py-5 text-center md:flex ${
          dragging ? "border-primary bg-primary-soft" : "border-border-2 bg-surface"
        } ${busy ? "cursor-progress opacity-60" : "cursor-pointer hover:border-primary"}`}
      >
        <span className="text-[14px] font-bold">
          ここにドロップ、または
          <span className="text-primary-ink underline underline-offset-4">選ぶ</span>
        </span>
        <span className="text-[12px] text-muted">
          画像・PDF・CSV、1 ファイル 20 MB まで。複数まとめて保存できます
        </span>
      </div>
      {/* Outside the drop zone: its click must not bubble back into the zone. */}
      <input
        ref={pickRef}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(event) => choose(event.currentTarget, "upload")}
      />
      {progress}
    </div>
  );
}
