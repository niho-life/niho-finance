import { countAuditLog, getSettingsSummary, todayInJapan } from "@niho-finance/db";
import { CONSUMPTION_TAX_METHOD_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { formatPeriod } from "@/lib/format";

export const metadata: Metadata = { title: "設定" };

interface Section {
  label: string;
  /** `null` while the section is not built (S5–S8). */
  href: string | null;
  summary: string;
}

/** The index of the settings: one row per section with its summary (10 §4). */
export default async function SettingsPage() {
  const prisma = await db();
  const summary = await getSettingsSummary(prisma, { today: todayInJapan() });
  const auditRows = await countAuditLog(prisma);
  const { counts, fiscalYear } = summary;
  const sections: Section[] = [
    { label: "事業所", href: "/settings/company", summary: summary.companyName ?? "未登録" },
    {
      label: "会計期間",
      href: "/settings/fiscal-years",
      summary: fiscalYear
        ? `第${fiscalYear.no}期 ${formatPeriod(fiscalYear.startDate, fiscalYear.endDate)} · ${CONSUMPTION_TAX_METHOD_LABELS[fiscalYear.consumptionTax]}`
        : "未登録",
    },
    { label: "勘定科目", href: "/settings/accounts", summary: String(counts.accounts) },
    { label: "税区分", href: "/settings/tax-categories", summary: String(counts.taxCategories) },
    { label: "口座", href: "/settings/wallets", summary: String(counts.wallets) },
    { label: "取引先", href: "/settings/partners", summary: String(counts.partners) },
    { label: "セグメント", href: "/settings/segments", summary: String(counts.segments) },
    { label: "タグ", href: "/settings/memo-tags", summary: String(counts.memoTags) },
    { label: "ルール", href: null, summary: "準備中" },
    { label: "定期取引", href: null, summary: "準備中" },
    { label: "証憑の規程", href: null, summary: "準備中" },
    {
      label: "監査ログ",
      href: "/settings/audit-log",
      summary: `${auditRows.toLocaleString("ja-JP")} 件`,
    },
    { label: "書き出しとバックアップ", href: null, summary: "準備中" },
  ];

  return (
    <>
      <PageHeader title="設定" />
      <ul className="grid gap-x-7 md:grid-cols-2">
        {sections.map((section) => {
          const content = (
            <>
              <span className="font-bold">{section.label}</span>
              <span className="num ml-auto min-w-0 truncate text-right text-[12px] text-muted">
                {section.summary}
              </span>
              <span aria-hidden="true" className="text-muted-2">
                ›
              </span>
            </>
          );
          const row = "flex min-h-12 items-center gap-3 border-b border-border px-1 py-3";
          return (
            <li key={section.label}>
              {section.href ? (
                <Link href={section.href} className={`${row} hover:bg-black/[0.02]`}>
                  {content}
                </Link>
              ) : (
                <span aria-disabled="true" className={`${row} opacity-45`}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
