import { loadExpenseFormOptions, todayInJapan } from "@niho-finance/db";
import { DOCUMENT_KIND_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { currentUser } from "@/lib/authz";
import { db } from "@/lib/data";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { ExpenseClaimForm } from "../_components/expense-claim-form";

export const metadata: Metadata = { title: "立替を出す" };

/** 立替を出す (23-users-and-expenses §6): the claimant is yourself by default. */
export default async function NewExpenseClaimPage() {
  const user = await currentUser();
  const prisma = await db();
  const options = await loadExpenseFormOptions(prisma);
  const self = options.claimants.find((claimant) => claimant.email === user.email);
  return (
    <>
      <PageHeader title="立替を出す" back={{ href: "/expenses", label: "立替精算" }} />
      {options.claimants.length === 0 ? (
        <p className="mb-4 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
          立替えた人に選べる利用者がいません。設定 › 利用者 で追加してください
        </p>
      ) : null}
      <ExpenseClaimForm
        claimants={options.claimants.map((claimant) => ({
          id: claimant.id,
          label:
            claimant.name && claimant.name !== claimant.email
              ? `${claimant.name}（${claimant.email}）`
              : claimant.email,
        }))}
        defaultClaimantId={self?.id ?? options.claimants[0]?.id ?? ""}
        options={options.entry}
        accounts={options.expenseAccounts}
        inbox={options.inboxDocuments.map((row) => ({
          id: row.id,
          title: row.originalName ?? DOCUMENT_KIND_LABELS[row.kind],
          kind: DOCUMENT_KIND_LABELS[row.kind],
          date: row.txnDate ? formatDate(row.txnDate) : null,
          amount: row.amount === null ? null : formatYenDisplay(row.amount),
          partner: row.partnerName,
        }))}
        today={todayInJapan()}
      />
    </>
  );
}
