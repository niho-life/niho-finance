import { listRules, loadEntryFormOptions } from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { RulesTable } from "./rules-table";
import { toClientRule } from "./rule-values";

export const metadata: Metadata = { title: "ルール" };

/** 設定 › ルール (15 §10): the rules that fill the chips of /statements or settle lines on import. */
export default async function RulesPage() {
  const prisma = await db();
  const rules = await listRules(prisma);
  // The rows the rules refer to stay choosable in their Sheet even when inactive.
  const referenced = rules.flatMap((rule) =>
    [
      rule.walletId,
      rule.action.accountId,
      rule.action.taxCategoryCode,
      rule.action.partnerId,
      rule.action.segmentId,
      rule.action.transferToWalletId,
    ].flatMap((id) => (id ? [id] : [])),
  );
  const options = await loadEntryFormOptions(prisma, { includeIds: referenced });
  return (
    <>
      <PageHeader title="ルール" back={{ href: "/settings", label: "設定" }} />
      <RulesTable
        rules={rules.map(toClientRule)}
        options={{
          accounts: options.accounts,
          taxCategories: options.taxCategories,
          partners: options.partners,
          segments: options.segments,
          wallets: options.wallets,
        }}
      />
    </>
  );
}
