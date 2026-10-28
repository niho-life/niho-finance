import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

/** 「前へ / 次へ」 with the page and the count (仕訳帳, 14-reports §7). */
export function Pagination({
  page,
  pageCount,
  total,
  unit,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  total: number;
  /** 件 */
  unit: string;
  hrefFor: (page: number) => string;
}) {
  const link = (target: number, label: string, enabled: boolean) =>
    enabled ? (
      <Link href={hrefFor(target)} className={buttonClass({ variant: "secondary", size: "sm" })}>
        {label}
      </Link>
    ) : (
      <span
        aria-disabled="true"
        className={buttonClass({ variant: "secondary", size: "sm", className: "opacity-40" })}
      >
        {label}
      </span>
    );
  return (
    <nav aria-label="ページ" className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
      {link(page - 1, "前へ", page > 1)}
      {link(page + 1, "次へ", page < pageCount)}
      <span className="num">
        {page} / {pageCount} ページ · {total.toLocaleString("ja-JP")} {unit}
      </span>
    </nav>
  );
}
