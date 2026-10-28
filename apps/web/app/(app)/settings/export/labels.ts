/** Owner-facing names of the exports in 「最近の書き出し」 (no internal identifiers on screen). */
export const EXPORT_KIND_LABELS: Readonly<Record<string, string>> = {
  "trial-balance": "試算表",
  monthly: "月次推移",
  segments: "セグメント損益",
  cash: "現預金",
  journal: "仕訳帳",
  ledger: "総勘定元帳",
  freee: "freee 形式",
  yayoi: "弥生形式",
  beancount: "beancount",
  documents: "証憑一式",
  backup: "バックアップ",
};

export const EXPORT_FORMAT_LABELS: Readonly<Record<string, string>> = {
  csv: "CSV",
  pdf: "PDF",
  zip: "zip",
  beancount: "beancount",
};

/** `?error=` of the page after a download that could not be made. */
export const EXPORT_ERRORS: Readonly<Record<string, string>> = {
  period: "期間の開始日と終了日を入れてから書き出します。",
  kind: "書き出す種類が見つかりません。下の節から選んで書き出します。",
};
