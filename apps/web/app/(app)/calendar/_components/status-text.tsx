import type { CalendarItemStatus } from "@niho-finance/db";
import { formatDate } from "@/lib/format";

/**
 * The state of a deadline on today (24 §1): 期限切れ in the warn colour (never red), 今日まで and
 * あと n 日 in the text colour, 未完了 and 完了 muted.
 */
export function StatusText({ status }: { status: CalendarItemStatus }) {
  switch (status.kind) {
    case "overdue":
      return <span className="font-bold text-warn">期限切れ</span>;
    case "today":
      return <span className="font-bold">今日まで</span>;
    case "soon":
      return <span className="num font-bold">あと {status.days} 日</span>;
    case "open":
      return <span className="text-muted">未完了</span>;
    case "completed":
      return <span className="num text-muted">完了 {formatDate(status.on)}</span>;
  }
}
