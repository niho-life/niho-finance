/**
 * Owner-facing words of the reports (05-ui-ux §4: no enum values on screen, in CSV or in PDF).
 * Entry kinds and sources are labelled here so that the exports work without the screens.
 */
import type { EntryKind, EntryStatus, SourceKind } from "@niho-finance/ledger";
import type { ReportEntry, ReportSegment, SourceIndex } from "./source";

export const REPORT_ENTRY_KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  opening: "開始",
  normal: "通常",
  transfer: "振替",
  adjusting: "決算整理",
  closing: "決算振替",
  reversal: "反対仕訳",
};

export const REPORT_SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  manual: "手入力",
  system: "初期設定",
  wallet_txn: "明細",
  stripe: "Stripe",
  invoice: "請求書",
  fixed_asset: "固定資産",
  recurring: "定期取引",
  import: "取込",
  payroll: "給与",
};

export const REPORT_ENTRY_STATUS_LABELS: Readonly<Record<EntryStatus, string>> = {
  posted: "登録済み",
  voided: "取消済み",
};

/**
 * The state shown next to an entry in the journal (14-reports §7): 反対仕訳 (with the number it
 * cancels), 訂正済み (with the replacing number) or 取消済み; `null` for an ordinary posted entry.
 */
export function entryStateLabel(entry: ReportEntry, index: SourceIndex): string | null {
  if (entry.kind === "reversal") {
    const reversed = entry.reversalOfId ? index.entriesById.get(entry.reversalOfId) : undefined;
    return reversed ? `反対仕訳（No. ${reversed.no} の取消）` : "反対仕訳";
  }
  if (entry.status === "voided") {
    const replacement = entry.replacedById ? index.entriesById.get(entry.replacedById) : undefined;
    return replacement ? `訂正済み（→ No. ${replacement.no}）` : "取消済み";
  }
  return null;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** Standard segment of the company as a whole (shown without a number). */
export const CORPORATE_SEGMENT_CODE = "corporate";

/**
 * 「① プラットフォーム」: numbered in `sortOrder` order, except 共通 (00-overview §2). Numbers follow
 * the position among the numbered segments of `segments` (active ones, in order).
 */
export function segmentLabels(segments: readonly ReportSegment[]): Map<string, string> {
  const labels = new Map<string, string>();
  let n = 0;
  for (const segment of segments) {
    if (segment.code === CORPORATE_SEGMENT_CODE) {
      labels.set(segment.id, segment.name);
      continue;
    }
    const mark = CIRCLED[n] ?? `${n + 1}.`;
    n += 1;
    labels.set(segment.id, `${mark} ${segment.name}`);
  }
  return labels;
}

export const UNASSIGNED_SEGMENT_LABEL = "未設定";
export const TOTAL_LABEL = "合計";
