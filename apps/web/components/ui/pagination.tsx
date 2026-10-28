import Link from "next/link";

/** 「前へ / 次へ」 and the count of a paged list (50 rows per page, 11 §3, §8). */
export function Pagination({
  page,
  pageCount,
  total,
  href,
}: {
  page: number;
  pageCount: number;
  total: number;
  /** The URL of a page (the filters kept). */
  href: (page: number) => string;
}) {
  const link =
    "inline-flex min-h-9 items-center rounded-lg border border-border-2 px-3 text-[13px] font-bold hover:bg-surface-2";
  const disabled =
    "inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-[13px] font-bold text-muted-2";
  return (
    <nav
      aria-label="ページ"
      className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <p className="num text-[13px] text-muted">
        {total.toLocaleString("ja-JP")} 件{pageCount > 1 ? `（${page} / ${pageCount} ページ）` : ""}
      </p>
      {pageCount > 1 ? (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} className={link} rel="prev">
              前へ
            </Link>
          ) : (
            <span aria-disabled="true" className={disabled}>
              前へ
            </span>
          )}
          {page < pageCount ? (
            <Link href={href(page + 1)} className={link} rel="next">
              次へ
            </Link>
          ) : (
            <span aria-disabled="true" className={disabled}>
              次へ
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
