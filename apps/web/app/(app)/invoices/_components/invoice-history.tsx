import type { InvoiceHistoryRow } from "@niho-finance/db";
import { JsonPair } from "@/components/ui/json-pair";
import { formatDateTime } from "@/lib/format";

/** The operations of the document's history (18 §9.5). */
const OPERATIONS: Readonly<Record<string, string>> = {
  "invoice.create": "作成",
  "invoice.update": "変更",
  "invoice.issue": "発行",
  "invoice.send": "送付",
  "invoice.pay": "入金",
  "invoice.cancel_payment": "入金の取消",
  "invoice.void": "無効",
  "invoice.discard": "破棄",
  "invoice.attach_pdf": "PDF の保存",
};

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[136px_120px_minmax(0,0.8fr)_minmax(0,1.2fr)]";

/** 履歴 (18 §9.5): the audit log of the document, oldest first. A row opens to its before / after. */
export function InvoiceHistory({ rows }: { rows: readonly InvoiceHistoryRow[] }) {
  return (
    <section aria-labelledby="invoice-history" className="mt-8">
      <h2 id="invoice-history" className="mb-2 text-[15px] font-extrabold">
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
                    {OPERATIONS[row.action] ?? "その他"}
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
