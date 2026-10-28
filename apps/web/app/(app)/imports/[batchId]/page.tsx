import { getImportBatch } from "@niho-finance/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { FailuresTable, WarningsList } from "../_components/results";
import { IMPORT_SOURCE_LABELS } from "../_lib/format";

export const metadata: Metadata = { title: "取込の結果" };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-b border-border py-2 last:border-b-0 md:grid-cols-[128px_minmax(0,1fr)]">
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-[14px]">{children}</dd>
    </div>
  );
}

/** 取込の結果 (12-imports §1.3): the summary, why a sync failed, the failed rows and the warnings. */
export default async function ImportBatchPage({ params }: PageProps<"/imports/[batchId]">) {
  const { batchId } = await params;
  const batch = await getImportBatch(await db(), batchId);
  if (!batch) notFound();
  const period =
    batch.periodFrom && batch.periodTo
      ? `${formatDate(batch.periodFrom)} – ${formatDate(batch.periodTo)}`
      : "—";

  return (
    <>
      <PageHeader
        title="取込の結果"
        meta={`${batch.walletName} · ${formatDateTime(batch.executedAt)}`}
        back={{ href: "/imports", label: "明細の取込" }}
      />
      {batch.error ? (
        <p className="mb-4 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger">
          同期できませんでした。{batch.error}
        </p>
      ) : null}
      <dl className="mb-6 max-w-2xl">
        <Item label="口座">{batch.walletName}</Item>
        <Item label="元">{IMPORT_SOURCE_LABELS[batch.source]}</Item>
        {batch.source === "csv" ? (
          <Item label="ファイル名">{batch.originalName ?? "—"}</Item>
        ) : null}
        <Item label={batch.source === "csv" ? "期間" : "取得した期間"}>
          <span className="num">{period}</span>
        </Item>
        <Item label="日時">
          <span className="num">{formatDateTime(batch.executedAt)}</span>
        </Item>
        <Item label="件数">
          <span className="num">
            新規 {batch.importedCount} 件・重複 {batch.duplicateCount} 件・失敗 {batch.failedCount}{" "}
            件
          </span>
        </Item>
        <Item label="状態">
          {batch.error ? <span className="font-bold text-danger">失敗</span> : "完了"}
        </Item>
      </dl>
      {batch.failures.length > 0 ? (
        <section aria-labelledby="batch-failures" className="mb-6">
          <h2 id="batch-failures" className="mb-1 text-[15px] font-extrabold">
            失敗した行
          </h2>
          <p className="mb-2 text-[12px] text-muted">
            これらの行は明細になっていません。元のファイルを直すか、手入力で登録してください。
          </p>
          <FailuresTable failures={batch.failures} />
        </section>
      ) : null}
      {batch.warnings.length > 0 ? (
        <section aria-labelledby="batch-warnings" className="mb-6">
          <h2 id="batch-warnings" className="mb-2 text-[15px] font-extrabold">
            警告
          </h2>
          <WarningsList warnings={batch.warnings} />
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <ButtonLink href="/imports" variant="primary">
          取込へ
        </ButtonLink>
        <span aria-disabled="true" className="text-[13px] font-bold text-muted-2">
          明細を見る（準備中）
        </span>
      </div>
    </>
  );
}
