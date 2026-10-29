import {
  countDueRecurringOccurrences,
  listAccountOptions,
  listPartners,
  listRecurringEntries,
  listRecurringItems,
  listSegments,
  listTaxCategoryOptions,
  listWallets,
  todayInJapan,
} from "@niho-finance/db";
import { formatYenInput, type Money } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatAmount } from "@/lib/format";
import { RecurringTable, type RecurringRow } from "./recurring-table";

export const metadata: Metadata = { title: "定期取引" };

/**
 * 設定 › 定期取引 (21-cashflow §7): the list edited in place, the 「追加」 row at the end, the
 * monthly totals that move 現預金 above it, and how card payments work below it.
 */
export default async function RecurringPage() {
  const prisma = await db();
  const today = todayInJapan();
  const items = await listRecurringItems(prisma);
  const wallets = await listWallets(prisma);
  const accounts = await listAccountOptions(prisma);
  const partners = await listPartners(prisma);
  const segments = await listSegments(prisma);
  const taxOptions = await listTaxCategoryOptions(prisma);
  // 予定日の登録 n 件 (21 §10.4) and each item's 登録した取引 for its sheet (§10.8).
  const dueCount = await countDueRecurringOccurrences(prisma, today);
  const entriesById = new Map<string, Awaited<ReturnType<typeof listRecurringEntries>>>();
  for (const item of items) entriesById.set(item.id, await listRecurringEntries(prisma, item.id));

  // 毎月 入金 · 出金: active monthly items that have not ended and move 現預金 (§3.2).
  let deposits: Money = 0n;
  let withdrawals: Money = 0n;
  for (const item of items) {
    if (!item.isActive || item.frequency !== "monthly" || !item.cashEffect) continue;
    if (item.endDate !== null && item.endDate < today) continue;
    if (item.cashEffect > 0n) deposits += item.cashEffect;
    else withdrawals -= item.cashEffect;
  }

  const rows: RecurringRow[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    direction: item.amount < 0n ? "withdrawal" : "deposit",
    amount: formatYenInput(item.amount < 0n ? -item.amount : item.amount),
    frequency: item.frequency,
    monthOfYear: item.monthOfYear,
    dayOfMonth: item.dayOfMonth,
    startDate: item.startDate,
    endDate: item.endDate,
    walletId: item.walletId,
    walletName: item.walletName,
    accountId: item.accountId,
    accountLabel: `${item.accountCode} ${item.accountName}`,
    transferWalletId: item.transferWalletId,
    transferWalletName: item.transferWalletName,
    entries: (entriesById.get(item.id) ?? []).map((entry) => ({
      id: entry.id,
      no: entry.no,
      entryDate: entry.entryDate,
      amount: formatAmount(entry.amount),
      voided: entry.voided,
      replacedByNo: entry.replacedByNo,
    })),
    partnerId: item.partnerId,
    segmentId: item.segmentId,
    taxCategoryCode: item.taxCategoryCode,
    note: item.note,
    isActive: item.isActive,
    ended: item.endDate !== null && item.endDate < today,
  }));

  return (
    <>
      <PageHeader title="定期取引" back={{ href: "/settings", label: "設定" }} />
      <p className="mb-3 text-[13px] text-muted">
        毎月・毎年決まって起きる入出金です。資金繰りの予測に使い、予定日が来たら 1
        クリックで取引として登録できます（自動では登録しません）
      </p>
      {dueCount > 0 ? (
        <p className="mb-2 text-[13px]">
          <Link
            href="/settings/recurring/due"
            className="font-bold text-primary underline-offset-4 hover:underline"
          >
            予定日の登録 {dueCount} 件
          </Link>
        </p>
      ) : null}
      <p className="num mb-2 text-[12px] text-muted">
        毎月 入金 {formatAmount(deposits)} 円 · 出金 {formatAmount(withdrawals)} 円
      </p>
      <RecurringTable
        items={rows}
        wallets={wallets
          .filter((wallet) => wallet.isActive)
          .map((wallet) => ({ value: wallet.id, label: wallet.name }))}
        accounts={accounts}
        partners={partners.map((partner) => ({
          value: partner.id,
          label: partner.name,
          isActive: partner.isActive,
        }))}
        segments={segments.map((segment) => ({
          value: segment.id,
          label: segment.name,
          isActive: segment.isActive,
        }))}
        taxOptions={taxOptions}
      />
      <p className="mt-2 text-[12px] text-muted">
        カード払いの定期取引は線を動かしません。カードの引落しを銀行の定期取引（科目:
        未払金）として登録してください
      </p>
      <p className="mt-1 text-[12px] text-muted">
        給与の納付（源泉所得税・住民税・社会保険料）と法人税等（均等割を含む）は、額つきで線に入ります。定期取引に重ねて登録しないでください
      </p>
    </>
  );
}
