import type { EntryHistoryRow } from "@niho-finance/db";
import { JsonPair } from "@/components/ui/json-pair";
import { entryNo, formatDateTime } from "@/lib/format";

const OPERATIONS: Readonly<Record<string, string>> = {
  "journal_entry.post": "登録",
  "journal_entry.void": "取消",
  "journal_entry.correct": "訂正",
};

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_150px_minmax(0,0.8fr)_minmax(0,1.2fr)]";

/**
 * 履歴 (11 §5): the audit log of the entry and of the entries chained to it, oldest first. A row
 * opens to its before / after.
 */
export function EntryHistory({ rows }: { rows: readonly EntryHistoryRow[] }) {
  return (
    <section aria-labelledby="entry-history" className="mt-8">
      <h2 id="entry-history" className="mb-2 text-[15px] font-extrabold">
        履歴
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">履歴がありません</p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-border">
          <li
            aria-hidden="true"
            className={`${GRID} hidden bg-surface-2 px-3.5 py-2 text-[11px] font-bold text-muted-2 md:grid`}
          >
            <span>日時</span>
            <span>操作</span>
            <span>実行者</span>
            <span>理由</span>
          </li>
          {rows.map((row) => (
            <li key={row.id} className="border-b border-border last:border-b-0">
              <details>
                <summary
                  className={`${GRID} cursor-pointer list-none px-3.5 py-2.5 text-[14px] hover:bg-black/[0.02] [&::-webkit-details-marker]:hidden`}
                >
                  <span className="num text-[13px] text-muted">{formatDateTime(row.at)}</span>
                  <span className="text-right font-bold md:text-left">
                    {OPERATIONS[row.action] ?? row.action}
                    {row.entryNo !== null ? (
                      <span className="ml-1.5 font-normal text-muted">{entryNo(row.entryNo)}</span>
                    ) : null}
                  </span>
                  <span className="truncate text-[13px] text-muted">{row.actor}</span>
                  <span className="text-[13px] md:col-auto">{row.reason ?? "—"}</span>
                </summary>
                <div className="px-3.5 pb-3">
                  <JsonPair before={row.before} after={row.after} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
