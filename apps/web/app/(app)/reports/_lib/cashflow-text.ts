import type { CashflowForecast, CashflowNote, CashflowPoint } from "@niho-finance/reports";
import { formatAmount, formatDate, formatPeriod } from "@/lib/format";

/**
 * The sentences of 資金繰り (21-cashflow §3.1, §4, §5) shared by the home and the report. The
 * forecast returns data only; the words live here.
 */

export const RECURRING_SETTINGS_HREF = "/settings/recurring";
export const CASHFLOW_NOTES_HREF = "/reports/cashflow#cashflow-notes";

/** 「2026/10/28 – 2027/01/26（90 日）」 */
export function cashflowPeriodLabel(forecast: Pick<CashflowForecast, "start" | "end">): string {
  return `${formatPeriod(forecast.start, forecast.end)}（90 日）`;
}

/** 「2026/12/27 に残高が 0 円を割ります（-120,000 円）」 (§4). */
export function negativeWarning(point: CashflowPoint): string {
  return `${formatDate(point.date)} に残高が 0 円を割ります（${formatAmount(point.balance)} 円）`;
}

/** The accessible name of the line (§4). */
export function forecastSummary(forecast: CashflowForecast): string {
  return `資金繰りの予測。90 日後 ${formatAmount(forecast.final.balance)} 円、最低 ${formatAmount(forecast.lowest.balance)} 円（${formatDate(forecast.lowest.date)}）`;
}

export interface CashflowNoteText {
  key: string;
  text: string;
  /** The screen that fills the gap (設定 › 定期取引). */
  href?: string;
}

const count = (n: number) => `${n.toLocaleString("ja-JP")} 件`;

/** 「入っていないもの」 (§3.1) in the order the forecast gives them. */
export function cashflowNoteText(note: CashflowNote): CashflowNoteText {
  switch (note.kind) {
    case "noRecurring":
      return {
        key: note.kind,
        text: "定期取引がまだありません。家賃や役員報酬を登録すると線に入ります",
        href: RECURRING_SETTINGS_HREF,
      };
    case "deadlinesNotConnected":
      return { key: note.kind, text: "税金・社会保険の期限: まだありません" };
    case "deadlinesWithoutAmount":
      return {
        key: note.kind,
        text: `金額未定の納付 ${count(note.count)}は印だけです。金額は定期取引に登録すると線に入ります`,
        href: RECURRING_SETTINGS_HREF,
      };
    case "receivablesNotConnected":
      return { key: note.kind, text: "未入金の請求: まだ入力がありません" };
    case "receivablesOverdue":
      return {
        key: note.kind,
        text: `期日を過ぎた未入金 ${count(note.count)} ${formatAmount(note.amount)} 円は入れていません`,
      };
    case "receivablesWithoutDate":
      return {
        key: note.kind,
        text: `期日のない未入金 ${count(note.count)} ${formatAmount(note.amount)} 円は入れていません`,
      };
    case "payablesNotConnected":
      return { key: note.kind, text: "未払の請求: まだ入力がありません" };
    case "cardUnpaid":
      return {
        key: `${note.kind}:${note.walletId}`,
        text: `${note.walletName} の未払 ${formatAmount(note.amount)} 円は入っていません。引落しを定期取引（口座: 銀行、科目: 未払金）に登録すると線に入ります`,
        href: RECURRING_SETTINGS_HREF,
      };
    case "recurringWithoutCashEffect":
      return {
        key: note.kind,
        text: `現預金を動かさない定期取引 ${count(note.count)}（カード払いなど）は線に入れていません`,
      };
    case "recurringAlreadyBooked":
      return {
        key: note.kind,
        text: `登録済みの取引と同じ日・同じ科目の定期取引 ${count(note.count)}は、二重に数えていません`,
      };
    case "recurringWithoutWallet":
      return {
        key: note.kind,
        text: `口座のない定期取引 ${count(note.count)}は線に入れていません`,
        href: RECURRING_SETTINGS_HREF,
      };
  }
}

/** The muted line under 「入っていないもの」 (§1, §6). */
export const CASHFLOW_BASIS_NOTE =
  "起点は登録済みの仕訳の残高です。取り込んでいない明細の分はずれます。土日祝の日付はずらしていません";

/** The guidance when nothing recurring is registered (§5). */
export const NO_RECURRING_GUIDANCE = "定期取引を登録すると、家賃や役員報酬の出金が線に入ります";
