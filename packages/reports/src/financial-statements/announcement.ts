/**
 * 決算公告 (17-financial-statements §9, 電子公告 09 D10): one self-contained HTML file to put on the
 * company's site — no external CSS, script, image or font, `<meta charset="utf-8">`, black on white,
 * printable. It carries the full balance sheet (電子公告 is never a summary) as a 勘定式 that stacks
 * on a narrow screen, the notes on significant accounting policies and 当期純損益金額
 * (会社計算規則 136 条 1 項). Every text is escaped; the announcement URL is not written.
 */
import { compactDate } from "../format";
import { asOfLabel, formatStatementAmount, japaneseDate } from "./format";
import { accountingPolicySection } from "./notes";
import type { FinancialStatementsReport } from "./report";
import { balanceSheetSides, type StatementLine } from "./statements";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
}

const STYLE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:#000;font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif;font-size:15px;line-height:1.6}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:22px;margin:0 0 8px;text-align:center}
h2{font-size:17px;margin:32px 0 4px;text-align:center}
h3{font-size:15px;margin:20px 0 4px}
p{margin:4px 0}
.date{text-align:right}
.company{text-align:right;margin-top:16px}
.unit{text-align:right;font-size:13px}
.bs{display:grid;grid-template-columns:1fr 1fr;grid-template-areas:"a l" "at lt";column-gap:24px;align-items:start}
.bs-assets{grid-area:a}.bs-right{grid-area:l}.bs-assets-total{grid-area:at}.bs-right-total{grid-area:lt}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid #000;padding:4px 6px;vertical-align:top}
thead th{border-top:1px solid #000;font-weight:bold;text-align:center}
td.amount{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;width:9em}
tr.heading td{font-weight:bold}
tr.total td{font-weight:bold}
.bs-assets-total td,.bs-right-total td{border-top:2px solid #000;font-weight:bold}
.i1{padding-left:1.4em}.i2{padding-left:2.4em}.i3{padding-left:3.4em}.i4{padding-left:4.4em}.i5{padding-left:5.4em}
.notes p{text-indent:1em}
@media (max-width:640px){.bs{grid-template-columns:1fr;grid-template-areas:"a" "at" "l" "lt"}.bs-right{margin-top:16px}td.amount{width:auto}}
@media print{main{padding:0}.bs{grid-template-columns:1fr 1fr;grid-template-areas:"a l" "at lt"}}
`.trim();

function lineRow(line: StatementLine): string {
  const indent = Math.min(line.indent, 5);
  const label = `<td class="i${indent}">${escapeHtml(line.label)}</td>`;
  const amount = line.amount === null ? "" : formatStatementAmount(line.amount);
  const kind = line.kind === "title" ? "heading" : line.kind === "total" ? "total" : "item";
  return `<tr class="${kind}">${label}<td class="amount">${escapeHtml(amount)}</td></tr>`;
}

function sideTable(className: string, lines: readonly StatementLine[]): string {
  const rows = lines.map(lineRow).join("\n");
  return `<table class="${className}">
<thead><tr><th>科目</th><th>金額</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function totalTable(className: string, line: StatementLine | null, fallback: string): string {
  const label = escapeHtml(line?.label ?? fallback);
  const amount = escapeHtml(formatStatementAmount(line?.amount ?? 0n));
  return `<table class="${className}"><tbody><tr class="total"><td>${label}</td><td class="amount">${amount}</td></tr></tbody></table>`;
}

/** `kessan-koukoku_20270331.html` */
export function announcementFileName(report: FinancialStatementsReport): string {
  return `kessan-koukoku_${compactDate(report.fiscalYear.endDate)}.html`;
}

export function buildAnnouncementHtml(report: FinancialStatementsReport): {
  fileName: string;
  html: string;
} {
  const { company, fiscalYear, settings, edition } = report;
  const title = `第${fiscalYear.no}期決算公告`;
  const published = settings.announcementPublishedOn
    ? `掲載日: ${japaneseDate(settings.announcementPublishedOn)}`
    : "掲載日: \u3000\u3000年\u3000\u3000月\u3000\u3000日";
  const companyLines = [
    company.address,
    company.name,
    company.representative ? `代表取締役\u3000${company.representative}` : null,
  ]
    .filter((text): text is string => text !== null && text.trim() !== "")
    .map(escapeHtml)
    .join("<br>\n");

  const sides = balanceSheetSides(report.balanceSheet, edition);
  const policy = accountingPolicySection(report.notes, edition);
  const notes: string[] = [];
  if (policy) {
    notes.push(`<h3>${escapeHtml(policy.title)}</h3>`);
    if (policy.body) notes.push(paragraphs(policy.body));
    policy.items.forEach((item, i) => {
      notes.push(`<p>${i + 1}. ${escapeHtml(item.title)}</p>`);
      notes.push(paragraphs(item.body));
    });
  }
  const netIncome = report.incomeStatement.netIncome;
  const netIncomeText =
    netIncome < 0n
      ? `当期純損失\u3000${formatStatementAmount(-netIncome)}円`
      : `当期純利益\u3000${formatStatementAmount(netIncome)}円`;
  notes.push("<h3>当期純損益金額</h3>");
  notes.push(`<p>${escapeHtml(netIncomeText)}</p>`);

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p class="date">${escapeHtml(published)}</p>
<p class="company">${companyLines}</p>
<h2>貸借対照表（${escapeHtml(asOfLabel(report.balanceSheet.asOf))}）</h2>
<p class="unit">（単位：円）</p>
<div class="bs">
${sideTable("bs-assets", sides.assets)}
${sideTable("bs-right", sides.liabilitiesAndNetAssets)}
${totalTable("bs-assets-total", sides.assetsTotal, "資産合計")}
${totalTable("bs-right-total", sides.liabilitiesAndNetAssetsTotal, "負債純資産合計")}
</div>
<section class="notes">
<h2>注記</h2>
${notes.join("\n")}
</section>
</main>
</body>
</html>
`;
  return { fileName: announcementFileName(report), html };
}
