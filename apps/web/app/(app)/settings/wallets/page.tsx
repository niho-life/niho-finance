import { getCompany, listAccountOptions, listSegmentOptions, listWallets } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { WalletsTable } from "./wallets-table";

export const metadata: Metadata = { title: "口座" };

/** 設定 › 口座: the list, and a sheet to add or edit (10 §4.5). */
export default async function WalletsPage() {
  const prisma = await db();
  const wallets = await listWallets(prisma);
  const accounts = await listAccountOptions(prisma, { kinds: ["asset", "liability"] });
  const segments = await listSegmentOptions(prisma);
  const company = await getCompany(prisma);
  return (
    <>
      <PageHeader title="口座" back={{ href: "/settings", label: "設定" }} />
      <WalletsTable
        wallets={wallets.map((wallet) => ({
          ...wallet,
          openingBalance: wallet.openingBalance === null ? null : String(wallet.openingBalance),
        }))}
        accounts={accounts}
        segments={segments}
        foundedOn={company?.foundedOn ?? null}
      />
    </>
  );
}
