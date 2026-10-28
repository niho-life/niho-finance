import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "その他" };

/** The sections the phone's bottom tabs leave out (11 §2). More rows join as they are built. */
const SECTIONS = [
  { label: "取引", href: "/entries", summary: "仕訳の一覧・登録・訂正" },
  { label: "明細の取込", href: "/imports", summary: "銀行・カードの CSV と Stripe の同期" },
  { label: "設定", href: "/settings", summary: "事業所・会計期間・勘定科目・口座 …" },
] as const;

/** その他 (11 §2): the way to 取引 and 設定 on phones. */
export default function MorePage() {
  return (
    <>
      <PageHeader title="その他" />
      <ul>
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="flex min-h-12 items-center gap-3 border-b border-border px-1 py-3 hover:bg-black/[0.02]"
            >
              <span className="font-bold">{section.label}</span>
              <span className="ml-auto min-w-0 truncate text-right text-[12px] text-muted">
                {section.summary}
              </span>
              <span aria-hidden="true" className="text-muted-2">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
