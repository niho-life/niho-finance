import type {
  AnnualTotals,
  FeeReportsOverview,
  StatementRecipient,
  StatementsOverview,
} from "@niho-finance/db";
import { formatYen, type CalendarDate, type Money } from "@niho-finance/ledger";
import {
  ERA_LABELS,
  FEE_CATEGORIES,
  FEE_ITEM_LABELS,
  japaneseEra,
  warekiDateLabel,
  type FeePayee,
  type SlipRelative,
  type WithholdingSlip,
} from "@niho-finance/payroll";
import type { FormCell, FormSection, StatementForm } from "@/lib/pdf/statement-form";

/*
 * 法定調書 as text forms (22-payroll §12.2): one builder per form, shared by the printable pages and
 * the PDFs. Every item of the official form keeps its label; the values are what the records give
 * (an empty box when the form leaves it empty or the record has nothing). Never a マイナンバー: the
 * 個人番号 boxes of 給与支払報告書 stay empty (written by hand or completed in eLTAX). Amounts keep
 * `formatYen` (the ASCII `-`): the page and the PDF are the same document (05-ui-ux §3.1).
 */

const yen = (amount: Money | null | undefined) =>
  amount === null || amount === undefined ? "" : formatYen(amount);
const people = (count: number | null | undefined) =>
  count === null || count === undefined || count === 0 ? "" : `${count} 人`;
const mark = (value: boolean) => (value ? "○" : "");

/** 「令和 8 年分」 */
export function eraYearLabel(year: number): string {
  const { era, year: number } = japaneseEra(
    `${String(year).padStart(4, "0")}-12-31` as CalendarDate,
  );
  return `${ERA_LABELS[era]} ${number === 1 ? "元" : number} 年分`;
}

const cell = (
  label: string,
  value: string,
  options: Omit<FormCell, "label" | "value"> = {},
): FormCell => ({
  label,
  value,
  ...options,
});
const money = (label: string, amount: Money | null | undefined, flex = 1): FormCell =>
  cell(label, yen(amount), { align: "right", flex });

function relativeCells(
  person: SlipRelative | undefined,
  index: number | null,
  withNumber: boolean,
): FormCell[] {
  const head = index === null ? "" : `(${index}) `;
  return [
    cell(`${head}氏名（フリガナ）`, person?.name ?? "", {
      flex: 3,
      ...(person?.furigana ? { note: person.furigana } : {}),
    }),
    cell("区分", person ? `${person.label}${person.code !== "" ? `（${person.code}）` : ""}` : "", {
      flex: 2,
    }),
    ...(withNumber ? [cell("個人番号", "", { flex: 2 })] : []),
  ];
}

export type SlipVariant = "recipient" | "report";

/**
 * 給与所得の源泉徴収票（受給者交付用）or 給与支払報告書（個人別明細書）of one person (§12.2): every
 * item of the form. The 報告書 has the 個人番号 boxes (empty) and the 提出先.
 */
export function withholdingSlipForm(
  recipient: Pick<StatementRecipient, "slip" | "state" | "reason">,
  variant: SlipVariant,
): StatementForm {
  const slip: WithholdingSlip = recipient.slip;
  const report = variant === "report";
  const dependents = slip.dependents;
  const disabled = slip.disabled;
  const life = slip.lifeInsuranceBreakdown;
  const spouse = slip.spouse;
  const change = slip.employmentChange;
  const sections: FormSection[] = [
    {
      title: "支払を受ける者",
      rows: [
        [
          cell("住所又は居所", slip.recipient.address, { flex: 4 }),
          cell("（受給者番号）", slip.recipient.recipientNo, { flex: 2 }),
        ],
        [
          ...(report ? [cell("（個人番号）", "", { flex: 2 })] : []),
          cell("（役職名）", slip.recipient.title, { flex: 1 }),
          cell("氏名", slip.recipient.name, {
            flex: 3,
            ...(slip.recipient.furigana ? { note: `（フリガナ）${slip.recipient.furigana}` } : {}),
          }),
        ],
      ],
    },
    {
      rows: [
        [
          cell("種別", slip.kindLabel),
          cell("支払金額", yen(slip.paid), {
            align: "right",
            note: `内 未払 ${yen(slip.unpaid)} 円`,
          }),
          money("給与所得控除後の金額（調整控除後）", slip.salaryIncomeAfterAdjustment),
          money("所得控除の額の合計額", slip.totalDeductions),
          cell("源泉徴収税額", yen(slip.withheld), {
            align: "right",
            note: `内 未徴収 ${yen(slip.notWithheld)} 円`,
          }),
        ],
        [
          cell(
            "（源泉）控除対象配偶者の有無等",
            spouse === null ? "" : `${spouse.has ? "有" : "無"}${spouse.elderly ? "・老人" : ""}`,
          ),
          money("配偶者（特別）控除の額", slip.spouseDeduction),
          cell("控除対象扶養親族の数 特定", people(dependents?.specific), {
            align: "right",
            note: `従 ${people(dependents?.secondary.specific) || "—"}`,
          }),
          cell("老人", people(dependents?.elderly), {
            align: "right",
            note: `内 ${people(dependents?.elderlyCohabiting) || "—"}・従 ${people(dependents?.secondary.elderly) || "—"}`,
          }),
          cell("その他", people(dependents?.other), {
            align: "right",
            note: `従 ${people(dependents?.secondary.other) || "—"}`,
          }),
          cell("特定親族", people(dependents?.specificRelative), {
            align: "right",
            note: `従 ${people(dependents?.secondary.specificRelative) || "—"}`,
          }),
        ],
        [
          cell("16 歳未満扶養親族の数", people(slip.minors), { align: "right" }),
          cell("障害者の数（本人を除く） 特別", people(disabled?.special), {
            align: "right",
            note: `内 同居 ${people(disabled?.specialCohabiting) || "—"}`,
          }),
          cell("その他", people(disabled?.other), { align: "right" }),
          cell("非居住者である親族の数", people(slip.nonResidentRelatives), { align: "right" }),
        ],
        [
          cell("社会保険料等の金額", yen(slip.socialInsurance), {
            align: "right",
            note: `内 小規模企業共済等掛金 ${yen(slip.smallBusinessMutualAid)} 円`,
          }),
          money("生命保険料の控除額", slip.lifeInsurance),
          money("地震保険料の控除額", slip.earthquake),
          money("住宅借入金等特別控除の額", slip.housingLoan),
        ],
      ],
    },
    { rows: [[cell("（摘要）", slip.remarks.join("\n"))]] },
    {
      title: "生命保険料の金額の内訳",
      rows: [
        [
          money("新生命保険料の金額", life?.newLife),
          money("旧生命保険料の金額", life?.oldLife),
          money("介護医療保険料の金額", life?.medical),
          money("新個人年金保険料の金額", life?.newPension),
          money("旧個人年金保険料の金額", life?.oldPension),
        ],
      ],
    },
    {
      title: "住宅借入金等特別控除の額の内訳",
      rows: [
        [
          cell("住宅借入金等特別控除適用数", ""),
          cell("居住開始年月日（1 回目）", ""),
          cell("住宅借入金等特別控除区分（1 回目）", ""),
          cell("住宅借入金等年末残高（1 回目）", ""),
        ],
        [
          money("住宅借入金等特別控除可能額", slip.housingLoanBreakdown?.possible),
          cell("居住開始年月日（2 回目）", ""),
          cell("住宅借入金等特別控除区分（2 回目）", ""),
          cell("住宅借入金等年末残高（2 回目）", ""),
        ],
      ],
    },
    {
      title: "（源泉・特別）控除対象配偶者",
      rows: [
        [
          ...relativeCells(slip.spousePerson ?? undefined, null, report),
          money("配偶者の合計所得", slip.spouseTotalIncome, 2),
        ],
        [
          money("国民年金保険料等の金額", slip.nationalPension),
          money("旧長期損害保険料の金額", slip.oldLongTerm),
          money("基礎控除の額", slip.basicDeduction),
          money("所得金額調整控除額", slip.incomeAdjustment),
          money("特定親族特別控除の額", slip.specificRelativeDeduction),
        ],
      ],
    },
    {
      title: "控除対象扶養親族",
      rows: [0, 1, 2, 3].map((index) =>
        relativeCells(slip.dependentPersons[index], index + 1, report),
      ),
    },
    {
      title: "16 歳未満の扶養親族",
      rows: [0, 1, 2, 3].map((index) => relativeCells(slip.minorPersons[index], index + 1, report)),
    },
    {
      title: "本人の区分等",
      rows: [
        [
          cell("未成年者", mark(slip.flags.minor), { align: "center" }),
          cell("外国人", mark(slip.flags.foreigner), { align: "center" }),
          cell("死亡退職", mark(slip.flags.deceasedRetirement), { align: "center" }),
          cell("災害者", mark(slip.flags.disaster), { align: "center" }),
          cell("乙欄", mark(slip.flags.otsu), { align: "center" }),
          cell("本人が障害者 特別", mark(slip.flags.specialDisabled), { align: "center" }),
          cell("その他", mark(slip.flags.otherDisabled), { align: "center" }),
          cell("寡婦", mark(slip.flags.widow), { align: "center" }),
          cell("ひとり親", mark(slip.flags.singleParent), { align: "center" }),
          cell("勤労学生", mark(slip.flags.workingStudent), { align: "center" }),
        ],
        [
          cell("中途就職", mark(change?.kind === "joined"), { align: "center" }),
          cell("中途退職", mark(change?.kind === "left"), { align: "center" }),
          cell("中途就・退職の年月日", change ? warekiDateLabel(change.date) : "", { flex: 3 }),
          cell("受給者生年月日", warekiDateLabel(slip.birthDate), { flex: 3 }),
        ],
      ],
    },
    {
      title: "支払者",
      rows: [
        [
          ...(report
            ? [cell("個人番号又は法人番号", slip.payer.corporateNumber ?? "", { flex: 2 })]
            : []),
          cell("住所（居所）又は所在地", slip.payer.address, { flex: 4 }),
        ],
        [
          cell("氏名又は名称", slip.payer.name, { flex: 3 }),
          cell("（電話）", slip.payer.phone ?? "", { flex: 2 }),
        ],
      ],
    },
  ];
  if (report) {
    sections.push({
      title: "提出先",
      rows: [
        [
          cell("提出先市町村コード", slip.recipient.municipalityCode),
          cell("指定番号", ""),
          cell("普通徴収", mark(change?.kind === "left"), { align: "center" }),
        ],
      ],
    });
  }
  const footnotes: string[] = [];
  if (!slip.adjusted) {
    footnotes.push(
      `年末調整をしていません${recipient.reason ? `（${recipient.reason}）` : ""}。支払金額・源泉徴収税額・社会保険料等の金額と、扶養控除等申告書の数だけを記載しています。`,
    );
  }
  if (report) {
    footnotes.push(
      "個人番号の欄は空欄です。提出のときに書面に記入するか、eLTAX で補います（このシステムは個人番号を保存しません）。",
    );
  } else {
    footnotes.push("受給者交付用には個人番号・法人番号を記載しません。");
  }
  if (slip.flags.foreigner || slip.flags.deceasedRetirement || slip.flags.disaster) {
    footnotes.push("外国人・死亡退職・災害者は記録していません。該当するときは手で直します。");
  }
  return {
    key: `${variant}-${slip.recipient.employeeId}`,
    title: `${eraYearLabel(slip.year)} ${report ? "給与支払報告書（個人別明細書）" : "給与所得の源泉徴収票"}`,
    ...(report ? {} : { subtitle: "受給者交付用" }),
    sections,
    footnotes,
  };
}

/** 給与支払報告書（総括表）: one per 提出先の市区町村 (コード未入力の人は 1 枚にまとめる). */
export function salaryReportSummaryForms(
  overview: StatementsOverview,
  options: { payDayLabel: string; nameKana: string; representative: string },
): StatementForm[] {
  const groups = new Map<string, StatementRecipient[]>();
  for (const recipient of overview.recipients) {
    const code = recipient.slip.recipient.municipalityCode;
    groups.set(code, [...(groups.get(code) ?? []), recipient]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a < b ? -1 : 1))
    .map(([code, recipients]) => {
      const reported = recipients.filter((recipient) => recipient.inSalaryReport);
      const left = reported.filter((recipient) => recipient.slip.employmentChange?.kind === "left");
      const special = reported.length - left.length;
      return {
        key: `summary-${code || "none"}`,
        title: `${eraYearLabel(overview.year)} 給与支払報告書（総括表）`,
        subtitle: code === "" ? "提出先市町村コード未入力の受給者" : `提出先市町村コード ${code}`,
        sections: [
          {
            title: "提出先",
            rows: [
              [
                cell("市区町村コード", code, { flex: 2 }),
                cell("宛先（市区町村長）", "", { flex: 3 }),
                cell("指定番号", "", { flex: 2 }),
                cell("提出区分", "新規"),
              ],
            ],
          },
          {
            title: "給与支払者",
            rows: [
              [
                cell("給与支払者の個人番号又は法人番号", overview.payer.corporateNumber ?? "", {
                  flex: 2,
                }),
                cell("所在地", overview.payer.address, { flex: 4 }),
              ],
              [
                cell("（フリガナ）", options.nameKana, { flex: 2 }),
                cell("氏名又は名称", overview.payer.name, { flex: 4 }),
              ],
              [
                cell("代表者の職氏名印", options.representative, { flex: 3 }),
                cell("連絡者の氏名・所属課・電話番号", "", { flex: 3 }),
              ],
              [
                cell("会計事務所等の名称", "", { flex: 3 }),
                cell("事業種目", "", { flex: 2 }),
                cell("所轄税務署", "", { flex: 2 }),
              ],
              [
                cell("給与の支払期間", `${eraYearLabel(overview.year)}（1 月〜12 月）`, {
                  flex: 3,
                }),
                cell("給与支払の方法及びその期日", options.payDayLabel, { flex: 3 }),
              ],
            ],
          },
          {
            title: "人員",
            rows: [
              [
                cell("受給者総人員", people(recipients.length) || "0 人", { align: "right" }),
                cell("報告人員 特別徴収対象者", people(special) || "0 人", { align: "right" }),
                cell("普通徴収対象者（退職者）", people(left.length) || "0 人", { align: "right" }),
                cell("普通徴収対象者（退職者を除く）", "0 人", { align: "right" }),
                cell("報告人員の合計", people(reported.length) || "0 人", { align: "right" }),
              ],
            ],
          },
          {
            title: "報告する受給者",
            rows:
              reported.length === 0
                ? [[cell("受給者", "なし")]]
                : reported.map((recipient) => [
                    cell("氏名", recipient.slip.recipient.name, { flex: 2 }),
                    cell("受給者番号", recipient.slip.recipient.recipientNo, { flex: 2 }),
                    money("支払金額", recipient.slip.paid),
                    cell(
                      "徴収",
                      recipient.slip.employmentChange?.kind === "left" ? "普通徴収" : "特別徴収",
                    ),
                  ]),
          },
        ],
        footnotes: [
          "普通徴収（退職者を除く）は記録していません。該当する人がいれば手で直します。",
          "宛先・指定番号・連絡者・事業種目・所轄税務署は手で記入します。",
        ],
      };
    });
}

/** 法定調書合計表の元データ (§12.2): 給与 (375) と 報酬 (309). */
export function annualTotalsForm(totals: AnnualTotals): StatementForm {
  const { salary, fees } = totals;
  const row = (label: string, data: { people: number; paid: Money; withheld: Money }) => [
    cell("区分", label, { flex: 3 }),
    cell("人員", `${data.people} 人`, { align: "right" }),
    money("支払金額", data.paid, 2),
    money("源泉徴収税額", data.withheld, 2),
  ];
  const feeRow = (
    label: string,
    data: {
      people: number;
      paid: Money;
      withheld: Money;
      reported: { people: number; paid: Money };
    },
  ) => [
    cell("区分", label, { flex: 3 }),
    cell("人員", `${data.people} 人`, { align: "right" }),
    money("支払金額", data.paid, 2),
    money("源泉徴収税額", data.withheld, 2),
    cell("うち提出するもの 人員", `${data.reported.people} 人`, { align: "right" }),
    money("うち提出するもの 支払金額", data.reported.paid, 2),
  ];
  const footnotes = [
    "2027 年 1 月 1 日以後は、給与支払報告書を市区町村に出すと源泉徴収票は税務署に出したものとみなされます（みなし提出）。合計表は税務署に出します。",
    "報酬は個人の取引先（個人と決めたもの）だけを数えています。",
  ];
  if (totals.pending > 0) {
    footnotes.unshift(
      `年末調整をまだ確定していない人が ${totals.pending} 人います。確定すると給与の数字が変わります（今は年末調整をしないものとして数えています）。`,
    );
  }
  if (totals.undecidedFees > 0) {
    footnotes.unshift(
      `個人か法人かを決めていない取引先が ${totals.undecidedFees} 件あります。法定調書の画面で決めてから出します。`,
    );
  }
  return {
    key: "annual-totals",
    title: `${eraYearLabel(totals.year)} 給与所得の源泉徴収票等の法定調書合計表（元データ）`,
    subtitle: totals.payer.name,
    sections: [
      {
        title: "1 給与所得の源泉徴収票合計表（375）",
        rows: [
          [
            ...row("俸給、給与、賞与等の総額", salary.all),
            cell("内 源泉徴収税額のない者", `${salary.all.peopleWithoutTax} 人`, {
              align: "right",
            }),
          ],
          row("うち 年末調整をしたもの", salary.adjusted),
          row("うち 年末調整をしないもの", salary.notAdjusted),
          row("うち 役員", salary.officers),
          row("源泉徴収票を提出するもの（税務署の提出範囲）", salary.taxOffice),
          row("給与支払報告書を提出するもの（市区町村）", salary.salaryReport),
        ],
      },
      {
        title: "3 報酬、料金、契約金及び賞金の支払調書合計表（309）",
        rows: [
          ...fees.byItem.map((item) => feeRow(FEE_ITEM_LABELS[item.item], item.row)),
          ...fees.byCategory.map((item) =>
            feeRow(`内 ${FEE_CATEGORIES[item.category].label}`, item.row),
          ),
          feeRow("計", fees.total),
        ],
      },
    ],
    footnotes,
  };
}

/** 報酬、料金、契約金及び賞金の支払調書: one per payee with a 支払調書 (個人・年 5 万円超). */
export function feeReportForms(overview: FeeReportsOverview): StatementForm[] {
  const reportable = overview.aggregation.payees.filter((payee) => payee.reportable);
  return reportable.map((payee: FeePayee) => ({
    key: `fee-${payee.partner.id}`,
    title: `${eraYearLabel(overview.year)} 報酬、料金、契約金及び賞金の支払調書`,
    sections: [
      {
        title: "支払を受ける者",
        rows: [
          [cell("住所（居所）又は所在地", payee.partner.address ?? "", { flex: 4 })],
          [
            cell("氏名又は名称", payee.partner.name, { flex: 3 }),
            cell("個人番号又は法人番号", "", { flex: 2 }),
          ],
        ],
      },
      {
        title: "支払の内容",
        rows: payee.items.map((item) => [
          cell("区分", FEE_CATEGORIES[item.category].label, { flex: 2 }),
          cell("細目", "", { flex: 2 }),
          cell("支払金額", yen(item.paid), { align: "right", flex: 2, note: "内 未払 0 円" }),
          cell("源泉徴収税額", yen(item.withheld), {
            align: "right",
            flex: 2,
            note: "内 未徴収 0 円",
          }),
        ]),
      },
      { rows: [[cell("（摘要）", "")]] },
      {
        title: "支払者",
        rows: [
          [
            cell("住所（居所）又は所在地", overview.payer.address, { flex: 4 }),
            cell("個人番号又は法人番号", overview.payer.corporateNumber ?? "", { flex: 2 }),
          ],
          [
            cell("氏名又は名称", overview.payer.name, { flex: 4 }),
            cell("（電話）", overview.payer.phone ?? "", { flex: 2 }),
          ],
        ],
      },
      { rows: [[cell("整理欄 ①", ""), cell("整理欄 ②", "")]] },
    ],
    footnotes: [
      `支払金額は消費税等を含む額です（${payee.entries.length} 件の仕訳から）。`,
      "支払を受ける者の個人番号又は法人番号は空欄です。提出のときに記入します（このシステムは保存しません）。",
    ],
  }));
}

/** 「毎月 25 日」: the day of the year's monthly runs (the latest one's), for 総括表. */
export function payDayLabel(days: readonly number[]): string {
  const last = days.at(-1);
  return last === undefined ? "" : `毎月 ${last} 日`;
}

/** A name safe in a file name (`_` for the characters a file system refuses). */
export function fileSafe(text: string): string {
  const safe = [...text]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("")
    .trim();
  return safe === "" ? "employee" : safe;
}
