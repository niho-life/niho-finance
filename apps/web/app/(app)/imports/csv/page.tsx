import { listImportableWallets, MAX_CSV_FILE_BYTES } from "@niho-finance/db";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { csvFormatOptions, isCsvFormatKey, isCsvWalletKind } from "../_lib/labels";
import type { CsvWalletOption } from "../_lib/types";
import { CsvImportForm } from "./csv-import-form";

export const metadata: Metadata = { title: "CSV の取込" };

/**
 * CSV の取込 (12-imports §1.2): ファイル → プレビュー → 取込 on one page. `?wallet=` picks the
 * wallet (a bank / card / other wallet; otherwise the first one).
 */
export default async function CsvImportPage({ searchParams }: PageProps<"/imports/csv">) {
  const { wallet: requested } = await searchParams;
  const wallets: CsvWalletOption[] = (await listImportableWallets(await db()))
    .filter((wallet) => isCsvWalletKind(wallet.kind))
    .map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      kindLabel: WALLET_KIND_LABELS[wallet.kind],
      importer: isCsvFormatKey(wallet.importer) ? wallet.importer : null,
      config: wallet.importerConfig,
    }));
  const initial = wallets.find((wallet) => wallet.id === requested) ?? wallets[0];

  return (
    <>
      <PageHeader title="CSV の取込" back={{ href: "/imports", label: "明細の取込" }} />
      {initial ? (
        <CsvImportForm
          wallets={wallets}
          formats={csvFormatOptions()}
          initialWalletId={initial.id}
          maxBytes={MAX_CSV_FILE_BYTES}
        />
      ) : (
        <EmptyState
          title="CSV を取り込める口座がありません"
          description="設定 › 口座 で銀行・カードを登録します"
          action={
            <ButtonLink href="/settings/wallets" size="sm">
              口座を登録
            </ButtonLink>
          }
        />
      )}
    </>
  );
}
