import type { PayableHistoryRow } from "@niho-finance/db";
import { payableHistoryLabel } from "@niho-finance/ledger";
import { JsonPair } from "@/components/ui/json-pair";
import { formatDateTime } from "@/lib/format";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1.1fr)]";

/**
 * 履歴 (25 §7.2): the payable's audit log, oldest first, with the voids of its entries made on the
 * statement screen or the transaction screen (「支払の取消（明細を未処理に戻す）」 …). A row opens to
 * its before / after.
 */
export function PayableHistory({ rows }: { rows: readonly PayableHistoryRow[] }) {
  return (
    <section aria-labelledby="payable-history" className="mt-8">
      <h2 id="payable-history" className="mb-2 text-[15px] font-extrabold">
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
                  <span className="text-right font-bold break-words md:text-left">
                    {payableHistoryLabel(row)}
                  </span>
                  <span className="truncate text-[13px] text-muted">{row.actor}</span>
                  <span className="text-[13px] break-words">{row.reason ?? "—"}</span>
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
