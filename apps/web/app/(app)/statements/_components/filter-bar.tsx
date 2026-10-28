import type { StatementPage, StatementsFilter, StatementStatusFilter } from "@niho-finance/db";
import Form from "next/form";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { statementsHref } from "./list-query";

/** The id of the search box (`/` focuses it, 15 §6). */
export const SEARCH_INPUT_ID = "statements-search";

const STATUS_TABS: readonly { value: StatementStatusFilter; label: string }[] = [
  { value: "pending", label: "未処理" },
  { value: "registered", label: "登録済み" },
  { value: "transfer", label: "振替" },
  { value: "ignored", label: "無視" },
];

/**
 * 口座チップ・状態タブ・検索 (15 §3). Everything is a link or a GET form: the URL is the state, so a
 * reload or a shared link shows the same list.
 */
export function FilterBar({
  filters,
  page,
  narrowed,
}: {
  filters: StatementsFilter;
  page: Pick<StatementPage, "pendingTotal" | "wallets">;
  narrowed: boolean;
}) {
  const settledTab = filters.status !== "pending";
  const chip = (active: boolean) =>
    [
      "inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-bold",
      active ? "border-text text-text" : "border-border text-muted hover:text-text",
    ].join(" ");
  const count = (value: number) => (
    <span className="num text-[12px] font-normal text-muted-2">
      {value.toLocaleString("ja-JP")}
    </span>
  );

  return (
    <div className="mb-4 flex flex-col gap-3">
      <nav aria-label="口座" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex w-max gap-1.5 md:w-auto md:flex-wrap">
          <li>
            <Link
              href={statementsHref({ ...filters, wallet: null, page: 1 })}
              aria-current={filters.wallet === null ? "page" : undefined}
              className={chip(filters.wallet === null)}
            >
              すべて {count(page.pendingTotal)}
            </Link>
          </li>
          {page.wallets.map((wallet) => (
            <li key={wallet.id}>
              <Link
                href={statementsHref({ ...filters, wallet: wallet.id, page: 1 })}
                aria-current={filters.wallet === wallet.id ? "page" : undefined}
                className={chip(filters.wallet === wallet.id)}
              >
                {wallet.isActive ? wallet.name : `${wallet.name}（無効）`} {count(wallet.pending)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border">
        <nav aria-label="状態" className="-mx-4 min-w-0 overflow-x-auto px-4 md:mx-0 md:px-0">
          <ul className="flex w-max gap-0.5">
            {STATUS_TABS.map((tab) => {
              const active = tab.value === filters.status;
              return (
                <li key={tab.value}>
                  <Link
                    href={statementsHref({ ...filters, status: tab.value, page: 1 })}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "-mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-[14px] font-bold whitespace-nowrap",
                      active
                        ? "border-text text-text"
                        : "border-transparent text-muted hover:text-text",
                    ].join(" ")}
                  >
                    {tab.label}
                    {tab.value === "pending" ? count(page.pendingTotal) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <Form
          action="/statements"
          role="search"
          aria-label="明細の検索"
          className="mb-2 flex w-full min-w-0 items-center gap-2 md:ml-auto md:w-auto"
        >
          {filters.wallet ? <input type="hidden" name="wallet" value={filters.wallet} /> : null}
          {settledTab ? <input type="hidden" name="status" value={filters.status} /> : null}
          {settledTab && filters.by ? <input type="hidden" name="by" value="rule" /> : null}
          <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
            検索
          </label>
          <input
            id={SEARCH_INPUT_ID}
            name="q"
            type="search"
            defaultValue={filters.q ?? ""}
            placeholder="摘要・振込人・金額"
            enterKeyHint="search"
            maxLength={100}
            className="control min-h-9! min-w-0 flex-1 py-1! text-[14px]! md:w-60"
          />
          <Button type="submit" size="sm" variant="secondary">
            検索
          </Button>
        </Form>
      </div>

      {settledTab || narrowed ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {settledTab ? (
            <Link
              href={statementsHref({ ...filters, by: filters.by ? null : "rule", page: 1 })}
              role="checkbox"
              aria-checked={filters.by === "rule"}
              className="inline-flex min-h-8 items-center gap-2 text-[13px] text-text"
            >
              <span
                aria-hidden="true"
                className={`inline-flex size-4 items-center justify-center rounded border text-[11px] leading-none ${
                  filters.by === "rule"
                    ? "border-primary bg-primary text-white"
                    : "border-border-2 bg-surface"
                }`}
              >
                {filters.by === "rule" ? "✓" : ""}
              </span>
              ルールで自動登録
            </Link>
          ) : null}
          {narrowed ? (
            <Link
              href={statementsHref({ status: filters.status })}
              className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
            >
              絞り込みを外す
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
