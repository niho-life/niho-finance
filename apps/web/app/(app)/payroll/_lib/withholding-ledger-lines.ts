import type { WithholdingLedger } from "@niho-finance/db";
import { displayDate, formatYen, type Money } from "@niho-finance/ledger";
import { yearMonthParts } from "@niho-finance/payroll";
import type { WithholdingLedgerColumn, WithholdingLedgerData } from "@/lib/pdf/withholding-ledger";
import { WORKER_KIND_LABELS } from "./labels";
import { settlementText, yearEndSteps } from "./year-end-views";

const yen = (amount: Money) => formatYen(amount);
const signed = (amount: Money) =>
  amount === 0n ? "" : amount > 0n ? `+${formatYen(amount)}` : formatYen(amount);

const MONTH_COLUMNS: WithholdingLedgerColumn[] = [
  { key: "month", label: "支給月", align: "left" },
  { key: "paymentDate", label: "支払日", align: "left", width: 62 },
  { key: "taxablePay", label: "総支給金額（課税）", align: "right", width: 76 },
  { key: "socialInsurance", label: "社会保険料", align: "right", width: 64 },
  { key: "employmentInsurance", label: "雇用保険料", align: "right", width: 58 },
  { key: "withholdingBase", label: "社会保険料等控除後", align: "right", width: 78 },
  { key: "dependents", label: "扶養親族等の数", align: "right", width: 60 },
  { key: "tableTax", label: "算出税額", align: "right", width: 58 },
  { key: "adjustment", label: "調整", align: "right", width: 50 },
  { key: "withheld", label: "差引徴収税額", align: "right", width: 64 },
];

const BONUS_COLUMNS: WithholdingLedgerColumn[] = [
  { key: "title", label: "賞与", align: "left" },
  { key: "paymentDate", label: "支払日", align: "left", width: 62 },
  { key: "bonus", label: "賞与の額", align: "right", width: 76 },
  { key: "socialInsurance", label: "社会保険料", align: "right", width: 64 },
  { key: "employmentInsurance", label: "雇用保険料", align: "right", width: 58 },
  { key: "withholdingBase", label: "社会保険料等控除後", align: "right", width: 78 },
  { key: "rate", label: "税率・求め方", align: "right", width: 118 },
  { key: "withheld", label: "徴収税額", align: "right", width: 64 },
];

/** 源泉徴収簿 (22-payroll §11.4) as text: the same tables on the printable page and in the PDF. */
export function withholdingLedgerData(ledger: WithholdingLedger): WithholdingLedgerData {
  const { totals } = ledger;
  const yearEnd = ledger.yearEnd;
  return {
    companyName: ledger.companyName,
    yearLabel: `${ledger.year} 年分`,
    employeeName: ledger.employee.name,
    kindLabel: WORKER_KIND_LABELS[ledger.employee.kind],
    months: {
      title: "給与",
      columns: MONTH_COLUMNS,
      rows: ledger.months.map((month) => ({
        key: month.runId,
        cells: {
          month: `${yearMonthParts(month.payMonth).month} 月`,
          paymentDate: displayDate(month.paymentDate),
          taxablePay: yen(month.taxablePay),
          socialInsurance: yen(month.socialInsurance),
          employmentInsurance: yen(month.employmentInsurance),
          withholdingBase: yen(month.withholdingBase),
          dependents: month.dependents === null ? "乙欄" : `${month.dependents} 人`,
          tableTax: yen(month.tableTax),
          adjustment: signed(month.adjustment),
          withheld: yen(month.withheld),
        },
      })),
      total:
        ledger.months.length === 0
          ? null
          : {
              month: "計",
              taxablePay: yen(totals.taxablePay),
              socialInsurance: yen(totals.socialInsurance),
              employmentInsurance: yen(totals.employmentInsurance),
              withheld: yen(totals.withheld),
            },
      empty: `${ledger.year} 年に支払った確定済みの給与はありません`,
    },
    bonuses: {
      title: "賞与",
      columns: BONUS_COLUMNS,
      rows: ledger.bonuses.map((bonus) => ({
        key: bonus.runId,
        cells: {
          title: bonus.title,
          paymentDate: displayDate(bonus.paymentDate),
          bonus: yen(bonus.bonus),
          socialInsurance: yen(bonus.socialInsurance),
          employmentInsurance: yen(bonus.employmentInsurance),
          withholdingBase: yen(bonus.withholdingBase),
          rate: bonus.rate,
          withheld: yen(bonus.withheld),
        },
      })),
      total:
        ledger.bonuses.length === 0
          ? null
          : {
              title: "計",
              bonus: yen(totals.bonus),
              socialInsurance: yen(totals.bonusSocialInsurance),
              employmentInsurance: yen(totals.bonusEmploymentInsurance),
              withheld: yen(totals.bonusWithheld),
            },
      empty: `${ledger.year} 年に支払った確定済みの賞与はありません`,
    },
    yearEnd:
      yearEnd.state === "unavailable"
        ? null
        : {
            title:
              yearEnd.state === "confirmed" ? "年末調整（確定済み）" : "年末調整（概算・未確定）",
            rows: yearEndSteps(yearEnd.result).map((row) => ({
              key: row.key,
              label: row.indent ? `\u3000${row.label}` : row.label,
              amount: row.amount,
              note: row.note,
              strong: row.strong,
            })),
            settlement: `${settlementText(yearEnd.result)}${
              yearEnd.settlementEntry ? `（仕訳 No.${yearEnd.settlementEntry.no}）` : ""
            }`,
          },
    yearEndMessage: yearEnd.state === "unavailable" ? yearEnd.message : null,
  };
}

function fileSafe(text: string): string {
  const safe = [...text]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("")
    .trim();
  return safe === "" ? "employee" : safe;
}

/** `withholding-ledger_2026_9k3f2a7q.pdf` and 「源泉徴収簿_2026年分_<氏名>.pdf」. */
export function withholdingLedgerFileNames(ledger: WithholdingLedger): {
  ascii: string;
  utf8: string;
} {
  return {
    ascii: `withholding-ledger_${ledger.year}_${ledger.employee.id.slice(-8).toLowerCase()}.pdf`,
    utf8: `源泉徴収簿_${ledger.year}年分_${fileSafe(ledger.employee.name)}.pdf`,
  };
}
