import {
  listAccounts,
  listSubAccounts,
  listTaxCategoryOptions,
  loadCurrentEtaxEdition,
} from "@niho-finance/db";
import { accountEtaxCodeViews } from "@niho-finance/reports";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { AccountsTable, type AccountCodeCell } from "./accounts-table";

export const metadata: Metadata = { title: "勘定科目" };

/** 設定 › 勘定科目: edited in the list; sub-accounts in the row's sheet (10 §4.3). */
export default async function AccountsPage() {
  const prisma = await db();
  const accounts = await listAccounts(prisma);
  const subAccounts = await listSubAccounts(prisma);
  const taxOptions = await listTaxCategoryOptions(prisma);
  // 勘定科目コード in today's edition (17-financial-statements §6.4).
  const edition = await loadCurrentEtaxEdition(prisma);
  const codes: Record<string, AccountCodeCell> = {};
  for (const view of accountEtaxCodeViews(accounts, edition)) {
    codes[view.accountId] = {
      displayCode: view.displayCode,
      tableLabel: view.tableLabel,
      originLabel: view.originLabel,
      note: view.note,
    };
  }
  return (
    <>
      <PageHeader title="勘定科目" back={{ href: "/settings", label: "設定" }} />
      <AccountsTable
        accounts={accounts}
        subAccounts={subAccounts}
        taxOptions={taxOptions}
        codes={codes}
        editionLabel={edition.label}
      />
    </>
  );
}
