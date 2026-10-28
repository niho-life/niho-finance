/** Owner-facing names of the exports in 「最近の書き出し」 (no internal identifiers on screen). */
export const EXPORT_KIND_LABELS: Readonly<Record<string, string>> = {
  "trial-balance": "試算表",
  monthly: "月次推移",
  segments: "セグメント損益",
  cash: "現預金",
  cashflow: "資金繰り",
  journal: "仕訳帳",
  ledger: "総勘定元帳",
  freee: "freee 形式",
  yayoi: "弥生形式",
  beancount: "beancount",
  documents: "証憑一式",
  backup: "バックアップ",
  payslip: "給与明細",
  // 決算書と申告用データ (17-financial-statements §1)
  "financial-statements": "計算書類",
  "opening-balance-sheet": "開始貸借対照表",
  "business-report": "事業報告",
  "supplementary-schedules": "附属明細書",
  "etax-csv": "財務諸表 CSV（e-Tax）",
  "account-details": "勘定科目内訳の元データ",
  "consumption-tax": "消費税の集計",
  announcement: "決算公告",
  // 受け渡しパッケージ (14-reports §15.5)
  package: "受け渡しパッケージ",
};

export const EXPORT_FORMAT_LABELS: Readonly<Record<string, string>> = {
  csv: "CSV",
  pdf: "PDF",
  zip: "zip",
  beancount: "beancount",
  html: "HTML",
};

/** `?error=` of the page after a download that could not be made. */
export const EXPORT_ERRORS: Readonly<Record<string, string>> = {
  period: "期間の開始日と終了日を入れてから書き出します。",
  kind: "書き出す種類が見つかりません。下の節から選んで書き出します。",
};
