import Link from "next/link";

/**
 * 「n 件中 a〜b 件」 and 前へ / 次へ of the list (50 per page, 13 §3.3). Both pages are read ahead
 * (`prefetch`, 05-ui-ux §3.1).
 */
export function Pager({
  page,
  pageSize,
  total,
  href,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** The URL of a page (the conditions kept). */
  href: (page: number) => string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
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
        {total.toLocaleString("ja-JP")} 件中 {first.toLocaleString("ja-JP")}〜
        {last.toLocaleString("ja-JP")} 件
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={link} rel="prev" prefetch>
            前へ
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>
            前へ
          </span>
        )}
        {page < pageCount ? (
          <Link href={href(page + 1)} className={link} rel="next" prefetch>
            次へ
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>
            次へ
          </span>
        )}
      </div>
    </nav>
  );
}
