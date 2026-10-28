import {
  EXPENSE_PAYMENTS_LIMIT,
  listWallets,
  loadExpenseOverview,
  todayInJapan,
} from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { walletLabel } from "@/lib/format";
import { PaymentsTable, VoidedClaims } from "./_components/history-sections";
import { UnpaidSection } from "./_components/unpaid-section";
import { toGroupView, toPaymentView, toVoidedView } from "./_components/views";

export const metadata: Metadata = { title: "立替精算" };

/** 「さらに表示」 adds this many payments. */
const MORE_PAYMENTS = 20;
const MAX_PAYMENTS = 1_000;

function paymentsLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return EXPENSE_PAYMENTS_LIMIT;
  return Math.min(Math.max(parsed, EXPENSE_PAYMENTS_LIMIT), MAX_PAYMENTS);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 立替精算 (23-users-and-expenses §6): 未払 per claimant (支払う・取消), 支払済み (支払の取消, the latest
 * 20 and 「さらに表示」) and 取消済み folded.
 */
export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const { payments: paymentsParam } = await searchParams;
  const limit = paymentsLimit(paymentsParam);
  const prisma = await db();
  const overview = await loadExpenseOverview(prisma, { paymentsLimit: limit });
  const wallets = (await listWallets(prisma))
    .filter((wallet) => wallet.isActive && (wallet.kind === "bank" || wallet.kind === "cash"))
    .map((wallet) => ({ id: wallet.id, name: wallet.name, label: walletLabel(wallet) }));
  const { unpaid, payments, voided } = overview;

  return (
    <>
      <PageHeader
        title="立替精算"
        meta={
          <span className="num">
            未払 {unpaid.count} 件・{formatYen(unpaid.total)} 円
          </span>
        }
        actions={
          <ButtonLink href="/expenses/new" variant="primary" size="sm">
            立替を出す
          </ButtonLink>
        }
      />
      <div className="flex flex-col gap-8">
        <Section title="未払">
          {unpaid.groups.length === 0 ? (
            <EmptyState
              title="未払の立替精算はありません"
              description="立替を出す と、計上の仕訳が登録されます。"
            />
          ) : (
            <UnpaidSection
              groups={unpaid.groups.map(toGroupView)}
              wallets={wallets}
              today={todayInJapan()}
            />
          )}
        </Section>

        <Section title="支払済み">
          {payments.rows.length === 0 ? (
            <p className="text-[13px] text-muted">支払はまだありません</p>
          ) : (
            <PaymentsTable payments={payments.rows.map(toPaymentView)} />
          )}
          {payments.hasMore ? (
            <Link
              href={`/expenses?payments=${limit + MORE_PAYMENTS}`}
              scroll={false}
              className="w-fit text-[13px] font-bold text-muted underline-offset-4 hover:underline"
            >
              さらに表示
            </Link>
          ) : null}
        </Section>

        <VoidedClaims claims={voided.map(toVoidedView)} />
      </div>
    </>
  );
}
