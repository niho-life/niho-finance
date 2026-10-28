import {
  listImportableWallets,
  listImportBatches,
  type ImportableWallet,
  type ImportBatchSummary,
} from "@niho-finance/db";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { RowLink } from "./_components/row-link";
import { SyncButton } from "./_components/sync-button";
import { firstLine, IMPORT_SOURCE_LABELS } from "./_lib/format";
import { importerLabel } from "./_lib/labels";

export const metadata: Metadata = { title: "明細の取込" };

const WALLET_COLUMNS = {
  columns: "minmax(0,1.2fr) 72px minmax(0,1.3fr) minmax(0,1.1fr) 132px 72px",
  mobileColumns: "minmax(0,1fr) auto",
};

const HISTORY_COLUMNS = {
  columns: "128px minmax(0,1fr) 60px minmax(0,1.4fr) 112px minmax(0,1fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * A sync stamps `lastSyncedAt` when it starts and its batch a moment later: only a sync clearly
 * after the latest batch is one that fetched nothing new.
 */
const SYNC_AFTER_BATCH_MS = 60_000;

/**
 * 最終取込 of a wallet: its latest batch, or — for Stripe — a later sync that fetched nothing new
 * (such a sync records no batch, 12-imports §4.2).
 */
function lastImport(wallet: ImportableWallet): { at: Date; text: string; failed: boolean } | null {
  const batch = wallet.lastBatch;
  const synced = wallet.stripe?.lastSyncedAt ?? null;
  if (synced && (!batch || synced.getTime() - batch.executedAt.getTime() > SYNC_AFTER_BATCH_MS)) {
    return { at: synced, text: "新規 0 件", failed: false };
  }
  if (!batch) return null;
  return batch.error
    ? { at: batch.executedAt, text: "失敗", failed: true }
    : { at: batch.executedAt, text: `新規 ${batch.importedCount} 件`, failed: false };
}

function LastImport({ wallet }: { wallet: ImportableWallet }) {
  const last = lastImport(wallet);
  if (!last) return <span className="text-muted-2">—</span>;
  return (
    <>
      <span className="num text-muted">{formatDateTime(last.at)}</span>{" "}
      <span className={last.failed ? "font-bold text-danger" : ""}>{last.text}</span>
    </>
  );
}

/** 操作: CSV を取り込む (bank / card / other), 同期 or 接続する (Stripe). */
function WalletAction({ wallet }: { wallet: ImportableWallet }) {
  if (!wallet.stripe) {
    return (
      <ButtonLink href={`/imports/csv?wallet=${wallet.id}`} size="sm">
        CSV を取り込む
      </ButtonLink>
    );
  }
  if (wallet.stripe.connected) return <SyncButton walletId={wallet.id} walletName={wallet.name} />;
  return (
    <ButtonLink href={`/imports/wallets/${wallet.id}`} size="sm">
      接続する
    </ButtonLink>
  );
}

function SettingsLink({ wallet }: { wallet: ImportableWallet }) {
  return (
    <RowLink href={`/imports/wallets/${wallet.id}`} label={`${wallet.name} の取込の設定`}>
      設定
    </RowLink>
  );
}

/**
 * PC: 名前・種類・取込形式・最終取込・操作・設定. Phones: 名前 and the action on the first line,
 * 取込形式・最終取込 and 設定 on the second.
 */
function WalletsTable({ wallets }: { wallets: readonly ImportableWallet[] }) {
  return (
    <Table label="取り込める口座" minWidth={720}>
      <TableHead {...WALLET_COLUMNS}>
        <Th>名前</Th>
        <Th>種類</Th>
        <Th>取込形式</Th>
        <Th>最終取込</Th>
        <Th />
        <Th />
      </TableHead>
      {wallets.map((wallet) => (
        <TableRow key={wallet.id} {...WALLET_COLUMNS}>
          <Td className="font-bold break-words">
            {wallet.name}
            <span className="ml-2 text-[11px] font-normal text-muted-2 md:hidden">
              {WALLET_KIND_LABELS[wallet.kind]}
            </span>
          </Td>
          <Td sm="hide" className="text-muted">
            {WALLET_KIND_LABELS[wallet.kind]}
          </Td>
          <Td sm="hide" className="truncate">
            {importerLabel(wallet)}
          </Td>
          <Td sm="hide" className="text-[13px]">
            <LastImport wallet={wallet} />
          </Td>
          <Td className="flex justify-end">
            <WalletAction wallet={wallet} />
          </Td>
          <Td sm="hide" className="flex justify-end">
            <SettingsLink wallet={wallet} />
          </Td>
          <span
            role="cell"
            data-sm="full"
            className="flex min-w-0 items-center gap-2 text-[12px] text-muted md:hidden"
          >
            {/* Two lines: a format's name alone can fill a 320px row. */}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{importerLabel(wallet)}</span>
              <span className="truncate">
                <LastImport wallet={wallet} />
              </span>
            </span>
            <SettingsLink wallet={wallet} />
          </span>
        </TableRow>
      ))}
    </Table>
  );
}

/** ファイル名 (CSV) or the period fetched (Stripe). */
function batchSubject(batch: ImportBatchSummary): string {
  if (batch.source === "csv") return batch.originalName ?? "—";
  if (batch.periodFrom && batch.periodTo) {
    return batch.periodFrom === batch.periodTo
      ? formatDate(batch.periodFrom)
      : `${formatDate(batch.periodFrom)} – ${formatDate(batch.periodTo)}`;
  }
  return "—";
}

function BatchStatus({ batch }: { batch: ImportBatchSummary }) {
  if (!batch.error) return <span className="text-muted">完了</span>;
  const reason = firstLine(batch.error);
  return (
    <span className="block min-w-0 truncate" title={reason}>
      <span className="font-bold text-danger">失敗</span>
      <span className="ml-1.5 text-[12px] text-muted">{reason}</span>
    </span>
  );
}

function HistoryTable({ batches }: { batches: readonly ImportBatchSummary[] }) {
  return (
    <Table label="取込の履歴" minWidth={760}>
      <TableHead {...HISTORY_COLUMNS}>
        <Th>日時</Th>
        <Th>口座</Th>
        <Th>元</Th>
        <Th>ファイル名・期間</Th>
        <Th align="right">新規 / 重複 / 失敗</Th>
        <Th>状態</Th>
      </TableHead>
      {batches.map((batch) => {
        const counts = `${batch.importedCount} / ${batch.duplicateCount} / ${batch.failedCount}`;
        return (
          <TableRow key={batch.id} {...HISTORY_COLUMNS} className="relative hover:bg-black/[0.02]">
            <Td sm="hide" className="num text-[13px] text-muted">
              {formatDateTime(batch.executedAt)}
            </Td>
            <Td>
              <span className="num mr-2 text-[12px] text-muted md:hidden">
                {formatDateTime(batch.executedAt)}
              </span>
              <Link
                href={`/imports/${batch.id}`}
                className="font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
              >
                {batch.walletName}
              </Link>
            </Td>
            <Td sm="hide" className="text-muted">
              {IMPORT_SOURCE_LABELS[batch.source]}
            </Td>
            <Td sm="hide" className="truncate text-[13px]">
              <span title={batchSubject(batch)}>{batchSubject(batch)}</span>
            </Td>
            <Td sm="hide" align="right">
              {counts}
            </Td>
            <Td className="text-[13px]">
              <BatchStatus batch={batch} />
            </Td>
            <span
              role="cell"
              data-sm="full"
              className="num min-w-0 truncate text-[12px] text-muted md:hidden"
            >
              {IMPORT_SOURCE_LABELS[batch.source]} · {batchSubject(batch)} · 新規{" "}
              {batch.importedCount}・重複 {batch.duplicateCount}・失敗 {batch.failedCount}
            </span>
          </TableRow>
        );
      })}
    </Table>
  );
}

/** 明細の取込 (12-imports §1.1): the importable wallets and the latest 20 imports. */
export default async function ImportsPage() {
  const prisma = await db();
  const wallets = await listImportableWallets(prisma);
  const batches = await listImportBatches(prisma, { limit: 20 });

  return (
    <>
      <PageHeader
        title="明細の取込"
        actions={
          <Link
            href="/settings/wallets"
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
          >
            口座の設定
            <span aria-hidden="true">›</span>
          </Link>
        }
      />
      <section aria-labelledby="imports-wallets" className="mb-8">
        <h2 id="imports-wallets" className="mb-2 text-[15px] font-extrabold">
          口座
        </h2>
        {wallets.length > 0 ? (
          <WalletsTable wallets={wallets} />
        ) : (
          <EmptyState
            title="取り込める口座がありません。設定 › 口座 で銀行・カード・Stripe を登録する"
            action={
              <ButtonLink href="/settings/wallets" size="sm">
                口座を登録
              </ButtonLink>
            }
          />
        )}
      </section>
      <section aria-labelledby="imports-history">
        <h2 id="imports-history" className="mb-2 text-[15px] font-extrabold">
          取込の履歴
        </h2>
        {batches.length > 0 ? (
          <HistoryTable batches={batches} />
        ) : (
          <EmptyState title="まだ取込がありません。口座の「CSV を取り込む」から始める" />
        )}
      </section>
    </>
  );
}
