import { listAccounts, listSubAccounts, listTaxCategoryOptions } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { AccountsTable } from "./accounts-table";

export const metadata: Metadata = { title: "勘定科目" };

/** 設定 › 勘定科目: edited in the list; sub-accounts in the row's sheet (10 §4.3). */
export default async function AccountsPage() {
  const prisma = await db();
  const accounts = await listAccounts(prisma);
  const subAccounts = await listSubAccounts(prisma);
  const taxOptions = await listTaxCategoryOptions(prisma);
  return (
    <>
      <PageHeader title="勘定科目" back={{ href: "/settings", label: "設定" }} />
      <AccountsTable accounts={accounts} subAccounts={subAccounts} taxOptions={taxOptions} />
    </>
  );
}
