import type { DocumentHistoryEntry } from "@niho-finance/db";
import { DOCUMENT_AUDIT_ACTION_LABELS } from "@niho-finance/ledger";
import { JsonPair } from "@/components/ui/json-pair";
import { formatDateTime } from "@/lib/format";

const ACTION_LABELS: Readonly<Record<string, string>> = DOCUMENT_AUDIT_ACTION_LABELS;

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_150px_minmax(0,0.8fr)_minmax(0,1.2fr)]";

/**
 * 履歴 (13 §4): the audit log of the document (保存 / 変更 / 紐づけ / 紐づけを外す / 無効), oldest
 * first, in the look of 取引の履歴 (11 §5). A row opens to its before / after.
 */
export function DocumentHistory({ rows }: { rows: readonly DocumentHistoryEntry[] }) {
  return (
    <section aria-labelledby="document-history" className="mt-8">
      <h2 id="document-history" className="mb-2 text-[15px] font-extrabold">
        履歴
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">履歴がありません</p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-border">
          <li
            aria-hidden="true"
            className={`${GRID} hidden bg-surface-2 px-3.5 py-2 text-[11px] font-bold text-muted md:grid`}
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
                    {ACTION_LABELS[row.action] ?? row.action}
                  </span>
                  <span className="truncate text-[13px] text-muted">{row.actor}</span>
                  <span className="text-[13px] break-words md:col-auto">{row.reason ?? "—"}</span>
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
