import { loadCashPosition, loadCurrentFiscalYear, todayInJapan } from "@niho-finance/db";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db, loadSetupProgress, loadShell, requireSetupReady } from "@/lib/data";
import { formatAmount, formatDate, formatMonth, formatPeriod } from "@/lib/format";

export const metadata: Metadata = { title: "ホーム" };

/** Home until S7: company, 第 n 期, 現預金 (derived) and the way to the settings (10 §1). */
export default async function HomePage() {
  await requireSetupReady();
  const prisma = await db();
  const shell = await loadShell();
  const progress = await loadSetupProgress();
  const today = todayInJapan();
  const fiscalYear = await loadCurrentFiscalYear(prisma, today);
  // Before the founding date there is nothing to show "today": show the first day of the books.
  const asOf = fiscalYear && today < fiscalYear.startDate ? fiscalYear.startDate : today;
  const cash = await loadCashPosition(prisma, asOf);

  return (
    <>
      <PageHeader title="ホーム" meta={formatMonth(asOf)} />
      <div className="grid gap-3.5 md:grid-cols-[1.2fr_2fr]">
        <section className="rounded-card border border-border bg-surface px-5 py-[18px]">
          <h2 className="mb-2.5 text-[13px] font-bold text-muted">現預金</h2>
          <p className="num text-[32px] leading-tight font-extrabold tracking-tight">
            {formatAmount(cash.total)}
            <span className="ml-1 text-[14px] font-semibold text-muted">円</span>
          </p>
          <p className="mt-1.5 text-[12px] text-muted">
            {formatDate(cash.asOf)} 時点 · 仕訳から導出
          </p>
        </section>
        <section className="rounded-card border border-border bg-surface px-5 py-[18px]">
          <h2 className="mb-2.5 text-[13px] font-bold text-muted">事業所</h2>
          <p className="text-[18px] font-extrabold">{shell.companyName}</p>
          <p className="mt-1 text-[13px] text-muted">
            {fiscalYear
              ? `第${fiscalYear.no}期 ${formatPeriod(fiscalYear.startDate, fiscalYear.endDate)}`
              : "会計期間がありません"}
          </p>
          {cash.wallets.length > 0 ? (
            <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {cash.wallets.map((wallet) => (
                <li
                  key={wallet.id}
                  className="flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-border px-3.5 py-3"
                >
                  <span className="truncate text-[12px] text-muted">
                    {wallet.name}
                    <span className="ml-1 text-muted-2">{WALLET_KIND_LABELS[wallet.kind]}</span>
                  </span>
                  <span className="num text-[18px] font-extrabold">
                    {formatAmount(wallet.balance)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      {progress.skipped.wallets || progress.skipped.opening ? (
        <section className="mt-3.5 rounded-card border border-border bg-surface px-5 py-[18px]">
          <h2 className="mb-1 text-[13px] font-bold text-muted">やること</h2>
          <ul className="flex flex-col">
            {progress.skipped.wallets ? (
              <li className="flex flex-wrap items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <span className="flex-1 text-[14px]">
                  口座がまだありません。銀行や役員立替を登録します
                </span>
                <ButtonLink href="/settings/wallets" size="sm">
                  口座を追加
                </ButtonLink>
              </li>
            ) : null}
            {progress.skipped.opening ? (
              <li className="flex flex-wrap items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <span className="flex-1 text-[14px]">
                  開始仕訳（資本金の払込・創立費）がまだありません
                </span>
                <ButtonLink href="/setup?step=opening" size="sm">
                  開始仕訳を登録
                </ButtonLink>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <p className="mt-6 text-[13px] text-muted">
        明細・取引・報告は準備中です。勘定科目や口座は{" "}
        <Link href="/settings" className="font-bold text-text underline underline-offset-4">
          設定
        </Link>{" "}
        から変えられます。
      </p>
    </>
  );
}
