import { extensionForMime, isPreviewableMime } from "@niho-finance/ledger";
import type { ReactNode } from "react";
import { formatByteSize } from "./list-query";

/**
 * プレビュー (13 §4): images in `<img>`, PDF in an `<iframe>`, other formats (HEIC, CSV) only as a
 * file. Under it: 「ファイルを開く」, the size, the format, the SHA-256 (the ground for tamper
 * detection) and the document ID (the key between paper originals and the stored files).
 */
export function DocumentPreview({
  id,
  title,
  mime,
  byteSize,
  sha256,
}: {
  id: string;
  title: string;
  mime: string;
  byteSize: number;
  sha256: string;
}) {
  const fileHref = `/api/documents/${id}/file`;
  const format = (extensionForMime(mime) ?? mime).toUpperCase();
  let preview: ReactNode;
  if (!isPreviewableMime(mime)) {
    preview = (
      <p className="px-4 py-10 text-center text-[14px] text-muted">
        この形式はプレビューできません
      </p>
    );
  } else if (mime === "application/pdf") {
    preview = (
      <iframe
        src={fileHref}
        title={`${title} のプレビュー`}
        className="block h-[50vh] w-full bg-surface lg:h-[70vh]"
      />
    );
  } else {
    preview = (
      // eslint-disable-next-line @next/next/no-img-element -- evidence is served as stored, never re-encoded
      <img
        src={fileHref}
        alt={`${title} のプレビュー`}
        className="mx-auto block max-h-[50vh] w-auto max-w-full object-contain lg:max-h-[70vh]"
      />
    );
  }
  return (
    <section aria-label="プレビュー" className="min-w-0">
      <div className="overflow-hidden rounded-card border border-border bg-surface-2">
        {preview}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <a
          href={fileHref}
          target="_blank"
          rel="noopener"
          className="font-bold underline underline-offset-4"
        >
          ファイルを開く
        </a>
        <span className="num text-muted">
          {formatByteSize(byteSize)} · {format}
        </span>
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-[12px] text-muted">
        <div className="min-w-0">
          <dt className="inline font-bold">SHA-256</dt>{" "}
          <dd className="inline">
            <code className="num break-all">{sha256}</code>
          </dd>
        </div>
        <div className="text-[11px] text-muted">
          <dt className="inline">証憑 ID</dt>{" "}
          <dd className="inline">
            <code className="num break-all">{id}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}
