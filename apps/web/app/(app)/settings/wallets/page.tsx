import {
  getCompany,
  getStripeAccountLink,
  listAccountOptions,
  listImportableWallets,
  listSegmentOptions,
  listWallets,
  type PrismaClient,
  type WalletSettings,
} from "@niho-finance/db";
import type { Metadata } from "next";
import {
  csvImporterLabel,
  isCsvWalletKind,
  stripeImporterLabel,
} from "@/app/(app)/imports/_lib/labels";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { WalletsTable } from "./wallets-table";

export const metadata: Metadata = { title: "口座" };

/**
 * 取込形式 of each wallet (12-imports §1.5): the format of a bank / card / other wallet, whether a
 * Stripe wallet is connected, and `null` for cash and 役員立替 (entered by hand).
 */
async function importerLabels(
  prisma: PrismaClient,
  wallets: readonly WalletSettings[],
): Promise<Map<string, string | null>> {
  const importable = new Map(
    (await listImportableWallets(prisma)).map((wallet) => [wallet.id, wallet]),
  );
  const labels = new Map<string, string | null>();
  for (const wallet of wallets) {
    if (wallet.kind === "stripe") {
      // Inactive wallets are not importable: their connection is looked up on its own.
      const listed = importable.get(wallet.id)?.stripe;
      const connected = listed
        ? listed.connected
        : (await getStripeAccountLink(prisma, wallet.id)) !== null;
      labels.set(wallet.id, stripeImporterLabel(connected));
    } else {
      labels.set(
        wallet.id,
        isCsvWalletKind(wallet.kind) ? csvImporterLabel(wallet.importer) : null,
      );
    }
  }
  return labels;
}

/** 設定 › 口座: the list, and a sheet to add or edit (10 §4.5). */
export default async function WalletsPage() {
  const prisma = await db();
  const wallets = await listWallets(prisma);
  const accounts = await listAccountOptions(prisma, { kinds: ["asset", "liability"] });
  const segments = await listSegmentOptions(prisma);
  const company = await getCompany(prisma);
  const importers = await importerLabels(prisma, wallets);
  return (
    <>
      <PageHeader title="口座" back={{ href: "/settings", label: "設定" }} />
      <WalletsTable
        wallets={wallets.map((wallet) => ({
          ...wallet,
          openingBalance: wallet.openingBalance === null ? null : String(wallet.openingBalance),
          importerLabel: importers.get(wallet.id) ?? null,
        }))}
        accounts={accounts}
        segments={segments}
        foundedOn={company?.foundedOn ?? null}
      />
    </>
  );
}
