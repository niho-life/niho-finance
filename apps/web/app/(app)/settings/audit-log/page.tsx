import { auditLogFilterSchema, listAuditLog, type AuditLogFilter } from "@niho-finance/db";
import { AUDIT_ENTITIES, AUDIT_ENTITY_LABELS, auditActionLabel } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { JsonPair } from "@/components/ui/json-pair";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "監査ログ" };

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_150px_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.2fr)]";

function query(filters: Omit<AuditLogFilter, "page">, page: number): string {
  const params = new URLSearchParams();
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `/settings/audit-log?${search}` : "/settings/audit-log";
}

/**
 * 設定 › 監査ログ (11 §8): every write, newest first, by target and period. Reading adds nothing to
 * the log. A row opens to its before / after.
 */
export default async function AuditLogPage({ searchParams }: PageProps<"/settings/audit-log">) {
  const filters = auditLogFilterSchema.parse(await searchParams);
  const result = await listAuditLog(await db(), filters, filters.page);
  const narrowed = Boolean(filters.entity || filters.from || filters.to);

  return (
    <>
      <PageHeader title="監査ログ" back={{ href: "/settings", label: "設定" }} />
      <Form
        action="/settings/audit-log"
        role="search"
        aria-label="監査ログの絞り込み"
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <label className="flex w-full min-w-0 flex-col gap-1 sm:w-48">
          <span className="text-[12px] font-bold text-muted">対象</span>
          <AutoSubmitSelect name="entity" defaultValue={filters.entity ?? ""}>
            <option value="">すべて</option>
            {AUDIT_ENTITIES.map((entity) => (
              <option key={entity} value={entity}>
                {AUDIT_ENTITY_LABELS[entity]}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
          <span className="text-[12px] font-bold text-muted">開始</span>
          <input name="from" type="date" defaultValue={filters.from ?? ""} className="control" />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
          <span className="text-[12px] font-bold text-muted">終了</span>
          <input name="to" type="date" defaultValue={filters.to ?? ""} className="control" />
        </label>
        <Button type="submit" size="sm">
          絞り込む
        </Button>
        {narrowed ? (
          <Link
            href="/settings/audit-log"
            className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
          >
            絞り込みを外す
          </Link>
        ) : null}
      </Form>

      {result.rows.length === 0 ? (
        <EmptyState
          title="監査ログがありません"
          description={narrowed ? "対象か期間を変えてください" : "書き込みがあると、ここに残ります"}
          action={
            narrowed ? (
              <ButtonLink href="/settings/audit-log" size="sm">
                絞り込みを外す
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="overflow-hidden rounded-card border border-border">
            <li
              aria-hidden="true"
              className={`${GRID} hidden bg-surface-2 px-3.5 py-2 text-[11px] font-bold text-muted md:grid`}
            >
              <span>日時</span>
              <span>操作</span>
              <span>対象</span>
              <span>実行者</span>
              <span>理由</span>
            </li>
            {result.rows.map((row) => {
              const label = auditActionLabel(row.action);
              return (
                <li key={row.id} className="border-b border-border last:border-b-0">
                  <details>
                    <summary
                      className={`${GRID} cursor-pointer list-none px-3.5 py-2.5 text-[14px] hover:bg-black/[0.02] [&::-webkit-details-marker]:hidden`}
                    >
                      <span className="num text-[13px] text-muted">{formatDateTime(row.at)}</span>
                      <span
                        className={
                          label
                            ? "text-right font-bold md:text-left"
                            : "text-right text-[12px] text-muted md:text-left"
                        }
                      >
                        {label ?? row.action}
                      </span>
                      <span className="col-span-2 truncate md:col-span-1">
                        {row.target ?? <span className="text-muted">{row.entity}</span>}
                      </span>
                      <span className="col-span-2 truncate text-[13px] text-muted md:col-span-1">
                        {row.actor}
                      </span>
                      <span className="col-span-2 text-[13px] md:col-span-1">
                        {row.reason ?? "—"}
                      </span>
                    </summary>
                    <div className="flex flex-col gap-2 px-3.5 pb-3">
                      {row.journalEntryId ? (
                        <Link
                          href={`/entries/${row.journalEntryId}`}
                          className="w-fit text-[13px] font-bold underline underline-offset-4"
                        >
                          仕訳を開く
                        </Link>
                      ) : null}
                      <JsonPair before={row.before} after={row.after} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            href={(page) => query(filters, page)}
          />
        </>
      )}
    </>
  );
}
