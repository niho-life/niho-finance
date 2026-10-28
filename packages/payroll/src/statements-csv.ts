import { dateParts, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { SlipRelative, WithholdingSlip } from "./statements";

/**
 * The CSV files of 法定調書 (22-payroll §12.2): 地方税共同機構「給与支払報告書‐源泉徴収票の統一CSV
 * レイアウト仕様書」(docs/research/eltax-kyuho-csv.md, 147 items per recipient) and the text rules
 * they share (和暦, 全角 / 半角, no `,` or `@`). Pure: the マイナンバー come only from the options of
 * one export and are never kept.
 *
 * Encoding: the rows are plain text, joined with CRLF. The web layer writes them as UTF-8 (without a
 * BOM) or as Shift_JIS through the `iconv-lite` the reports already use — eLTAX PCdesk's import may
 * require Shift_JIS, so the screen offers both.
 */

// ---------------------------------------------------------------------------------------------
// 和暦
// ---------------------------------------------------------------------------------------------

/** 元号 codes of the CSV: 昭和 1・大正 2・明治 3・平成 4・令和 5. */
export const ERA_CODES = { showa: "1", taisho: "2", meiji: "3", heisei: "4", reiwa: "5" } as const;
export type Era = keyof typeof ERA_CODES;

export const ERA_LABELS: Readonly<Record<Era, string>> = {
  meiji: "明治",
  taisho: "大正",
  showa: "昭和",
  heisei: "平成",
  reiwa: "令和",
};

const ERAS: readonly { era: Era; from: CalendarDate; baseYear: number }[] = [
  { era: "reiwa", from: "2019-05-01", baseYear: 2019 },
  { era: "heisei", from: "1989-01-08", baseYear: 1989 },
  { era: "showa", from: "1926-12-25", baseYear: 1926 },
  { era: "taisho", from: "1912-07-30", baseYear: 1912 },
  { era: "meiji", from: "1868-01-25", baseYear: 1868 },
];

/** A date in 和暦: 元号 and its year (元年 = 1). */
export function japaneseEra(date: CalendarDate): { era: Era; year: number } {
  const found = ERAS.find((candidate) => date >= candidate.from);
  if (!found) throw new RangeError(`japaneseEra: ${date} is before 明治`);
  return { era: found.era, year: dateParts(date).year - found.baseYear + 1 };
}

/** 年分 in 和暦 (2 digits): 2026 → `08` (令和 8 年分). */
export function warekiYear2(year: number): string {
  return String(
    japaneseEra(`${String(year).padStart(4, "0")}-12-31` as CalendarDate).year,
  ).padStart(2, "0");
}

/** 「令和 8 年 11 月 30 日」 */
export function warekiDateLabel(date: CalendarDate): string {
  const { era, year } = japaneseEra(date);
  const { month, day } = dateParts(date);
  return `${ERA_LABELS[era]} ${year === 1 ? "元" : year} 年 ${month} 月 ${day} 日`;
}

const two = (value: number) => String(value).padStart(2, "0");

// ---------------------------------------------------------------------------------------------
// 全角・半角
// ---------------------------------------------------------------------------------------------

/** Characters e-Tax / eLTAX refuse in 全角 items. */
export const CSV_FORBIDDEN_CHARACTERS = ["℃", "Å", "⌒", "★", "☆", "♀", "♂", "♪", "♭", "♯"];

const HALF_KANA = "｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";
const FULL_KANA =
  "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜";
const VOICED_FULL = "ガギグゲゴザジズゼゾダヂヅデドバビブベボ";
const VOICED_BASE = "カキクケコサシスセソタチツテトハヒフヘホ";
const SEMI_FULL = "パピプペポ";
const SEMI_BASE = "ハヒフヘホ";

const fullToHalf = new Map<string, string>();
const halfToFull = new Map<string, string>();
for (let index = 0; index < HALF_KANA.length; index += 1) {
  fullToHalf.set(FULL_KANA[index]!, HALF_KANA[index]!);
  halfToFull.set(HALF_KANA[index]!, FULL_KANA[index]!);
}
for (let index = 0; index < VOICED_FULL.length; index += 1) {
  fullToHalf.set(VOICED_FULL[index]!, `${fullToHalf.get(VOICED_BASE[index]!)!}ﾞ`);
}
for (let index = 0; index < SEMI_FULL.length; index += 1) {
  fullToHalf.set(SEMI_FULL[index]!, `${fullToHalf.get(SEMI_BASE[index]!)!}ﾟ`);
}
fullToHalf.set("ヴ", "ｳﾞ");
fullToHalf.set("ヰ", "ｲ");
fullToHalf.set("ヱ", "ｴ");
fullToHalf.set("ヮ", "ﾜ");
fullToHalf.set("ヵ", "ｶ");
fullToHalf.set("ヶ", "ｹ");
fullToHalf.set("　", " ");

/** ひらがな → カタカナ. */
function hiraganaToKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

const voicedOf = new Map<string, string>();
const semiVoicedOf = new Map<string, string>();
for (let index = 0; index < VOICED_BASE.length; index += 1) {
  voicedOf.set(VOICED_BASE[index]!, VOICED_FULL[index]!);
}
for (let index = 0; index < SEMI_BASE.length; index += 1) {
  semiVoicedOf.set(SEMI_BASE[index]!, SEMI_FULL[index]!);
}
voicedOf.set("ウ", "ヴ");

/** 半角カナ → 全角カナ (a following ﾞ / ﾟ joins its letter). */
function halfKanaToFull(text: string): string {
  const chars = [...text];
  let out = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const full = halfToFull.get(char);
    if (full === undefined) {
      out += char;
      continue;
    }
    const next = chars[index + 1];
    const joined =
      next === "ﾞ" ? voicedOf.get(full) : next === "ﾟ" ? semiVoicedOf.get(full) : undefined;
    if (joined !== undefined) {
      out += joined;
      index += 1;
    } else {
      out += full;
    }
  }
  return out;
}

/**
 * Text for a 半角 item: 全角英数 → 半角, ひらがな・カタカナ → 半角カナ (濁点は別の文字), no `,`, `@`,
 * `"` or line breaks.
 */
export function toHalfWidth(text: string): string {
  // NFKC folds 全角英数 into 半角 and 半角カナ into 全角; every カナ then goes to 半角.
  const katakana = hiraganaToKatakana(text.normalize("NFKC"));
  let out = "";
  for (const char of katakana) out += fullToHalf.get(char) ?? char;
  return out.replace(/[,@"\r\n\t]/g, "").trim();
}

/**
 * Text for a 全角 item: 半角英数・記号 → 全角 (`,` → `，`, `@` → `＠`), 半角カナ → 全角, spaces and
 * line breaks → 全角スペース. Kanji are left as typed (no compatibility folding of names).
 */
export function toFullWidth(text: string): string {
  const kana = halfKanaToFull(text.replace(/[\r\n\t]+/g, " ").trim());
  let out = "";
  for (const char of kana) {
    const code = char.charCodeAt(0);
    if (code === 0x20) out += "\u3000";
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + 0xfee0);
    else out += char;
  }
  return out;
}

/** Digits only (数字 items): anything else is dropped. */
export function digitsOnly(text: string): string {
  return text.normalize("NFKC").replace(/\D/g, "");
}

/** The forbidden characters a 全角 value contains. */
export function forbiddenCharacters(text: string): string[] {
  return CSV_FORBIDDEN_CHARACTERS.filter((char) => text.includes(char));
}

/** Rows → the file's text: fields joined with `,`, CRLF line ends (a trailing CRLF included). */
export function statementCsvText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------
// 給与支払報告書‐源泉徴収票の統一 CSV (147 items)
// ---------------------------------------------------------------------------------------------

/** The number of items of one recipient's row. */
export const UNIFIED_CSV_FIELD_COUNT = 147;

/** The マイナンバー typed on the export form for one recipient (used for that response only). */
export interface UnifiedCsvMyNumbers {
  recipient?: string;
  spouse?: string;
  /** 控除対象扶養親族等 (1)〜(4), in the slip's order. */
  dependents?: readonly string[];
  /** 16 歳未満の扶養親族 (1)〜(4). */
  minors?: readonly string[];
}

export interface UnifiedCsvOptions {
  /** 提出区分: 0 新規 (default)・1 追加・2 訂正・3 取消. */
  submissionKind?: 0 | 1 | 2 | 3;
  /** 作成区分: 0 国税のみ・1 地方税のみ・2 双方 (default; みなし提出). */
  creationKind?: 0 | 1 | 2;
  /** 市町村が指定した番号 (指定番号), when known. */
  designatedNumber?: string;
  myNumbers?: UnifiedCsvMyNumbers;
}

const money = (amount: Money | null | undefined): string =>
  amount === null || amount === undefined ? "" : amount.toString();
/** An amount shown only when it is not 0. */
const nonZero = (amount: Money | null | undefined): string =>
  amount === null || amount === undefined || amount === 0n ? "" : amount.toString();
const count = (value: number | null | undefined): string =>
  value === null || value === undefined || value === 0 ? "" : String(value);
const flag = (value: boolean): string => (value ? "1" : "0");
const myNumber = (value: string | undefined, length: number): string => {
  const digits = digitsOnly(value ?? "");
  return digits.length === length ? digits : "";
};

/**
 * フリガナ・氏名・区分・個人番号 of one relative (4 items). Relatives' フリガナ are 全角 30 in the
 * layout (only the recipient's own フリガナ, No. 137, is 半角), so they go out as 全角カタカナ.
 */
function relativeItems(person: SlipRelative | undefined, number: string | undefined): string[] {
  if (!person) return ["", "", "", ""];
  return [
    toFullWidth(hiraganaToKatakana(person.furigana.normalize("NFKC"))),
    toFullWidth(person.name),
    person.code,
    myNumber(number, 12),
  ];
}

/**
 * One recipient's row of the unified CSV: the 147 items in order (docs/research/eltax-kyuho-csv.md).
 * 年分・生年月日・中途就退職の年月日 in 和暦 2 digits, 元号 codes 1〜5, flags 1 / 0, amounts as integers
 * (年末調整をしていない人の控除の欄は空), the relatives (1)〜(4) of the slip, マイナンバー only from
 * `options.myNumbers`. 住宅借入金等特別控除の内訳 (74〜85) stay empty: the declaration does not record
 * them (the slip's 摘要 carries the 可能額).
 */
export function unifiedCsvRow(slip: WithholdingSlip, options: UnifiedCsvOptions = {}): string[] {
  const numbers = options.myNumbers ?? {};
  const birth = japaneseEra(slip.birthDate);
  const birthParts = dateParts(slip.birthDate);
  const change = slip.employmentChange;
  const changeParts = change ? dateParts(change.date) : null;
  const previous = slip.previousEmployer;
  const previousLeft = previous?.leftOn ? dateParts(previous.leftOn) : null;
  const dependents = slip.dependents;
  const disabled = slip.disabled;
  const life = slip.lifeInsuranceBreakdown;
  const otsu = slip.flags.otsu;
  const spouseFlag =
    slip.spouse === null || otsu
      ? ""
      : slip.spouse.secondary
        ? slip.spouse.has
          ? "3"
          : "4"
        : slip.spouse.has
          ? "1"
          : "2";

  const fields: string[] = [
    /* 1 法定資料の種類 */ "315",
    /* 2 整理番号１ */ "",
    /* 3 本支店等区分番号 */ "",
    /* 4 提出義務者の住所又は所在地 */ toFullWidth(slip.payer.address),
    /* 5 提出義務者の氏名又は名称 */ toFullWidth(slip.payer.name),
    /* 6 提出義務者の電話番号 */ toHalfWidth(slip.payer.phone ?? ""),
    /* 7 整理番号２ */ "",
    /* 8 提出者の住所 */ "",
    /* 9 提出者の氏名 */ "",
    /* 10 提出区分 */ String(options.submissionKind ?? 0),
    /* 11 年分 */ warekiYear2(slip.year),
    /* 12 支払を受ける者－住所又は居所 */ toFullWidth(slip.recipient.address),
    /* 13 国外住所表示 */ "0",
    /* 14 支払を受ける者－氏名 */ toFullWidth(slip.recipient.name),
    /* 15 役職名 */ toFullWidth(slip.recipient.title),
    /* 16 種別 */ toFullWidth(slip.kindLabel),
    /* 17 支払金額 */ money(slip.paid),
    /* 18 未払金額 */ nonZero(slip.unpaid),
    /* 19 給与所得控除後の給与等の金額（調整控除後） */ money(slip.salaryIncomeAfterAdjustment),
    /* 20 所得控除の額の合計額 */ money(slip.totalDeductions),
    /* 21 源泉徴収税額 */ money(slip.withheld),
    /* 22 未徴収税額 */ nonZero(slip.notWithheld),
    /* 23 （源泉）控除対象配偶者の有無 */ spouseFlag,
    /* 24 老人控除対象配偶者 */ slip.spouse === null || otsu ? "" : flag(slip.spouse.elderly),
    /* 25 配偶者（特別）控除の額 */ nonZero(slip.spouseDeduction),
    /* 26 控除対象扶養親族の数 特定 主 */ count(dependents?.specific),
    /* 27 特定 従 */ count(dependents?.secondary.specific),
    /* 28 老人 主 */ count(dependents?.elderly),
    /* 29 老人 上の内訳（同居老親等） */ count(dependents?.elderlyCohabiting),
    /* 30 老人 従 */ count(dependents?.secondary.elderly),
    /* 31 その他 主 */ count(dependents?.other),
    /* 32 その他 従 */ count(dependents?.secondary.other),
    /* 33 障害者の数 特別障害者 */ count(disabled?.special),
    /* 34 上の内訳（同居） */ count(disabled?.specialCohabiting),
    /* 35 その他 */ count(disabled?.other),
    /* 36 社会保険料等の金額 */ nonZero(slip.socialInsurance),
    /* 37 上の内訳（小規模企業共済等掛金） */ nonZero(slip.smallBusinessMutualAid),
    /* 38 生命保険料の控除額 */ nonZero(slip.lifeInsurance),
    /* 39 地震保険料の控除額 */ nonZero(slip.earthquake),
    /* 40 住宅借入金等特別控除等の額 */ nonZero(slip.housingLoan),
    /* 41 旧個人年金保険料の金額 */ nonZero(life?.oldPension),
    /* 42 配偶者の合計所得 */ money(slip.spouseTotalIncome),
    /* 43 旧長期損害保険料の金額 */ nonZero(slip.oldLongTerm),
    /* 44 受給者の生年月日 元号 */ ERA_CODES[birth.era],
    /* 45 年 */ two(birth.year),
    /* 46 月 */ two(birthParts.month),
    /* 47 日 */ two(birthParts.day),
    /* 48 夫あり */ "",
    /* 49 未成年者 */ flag(slip.flags.minor),
    /* 50 乙欄適用 */ flag(slip.flags.otsu),
    /* 51 本人が特別障害者 */ flag(slip.flags.specialDisabled),
    /* 52 本人がその他の障害者 */ flag(slip.flags.otherDisabled),
    /* 53 老年者 */ "",
    /* 54 寡婦 */ flag(slip.flags.widow),
    /* 55 寡夫 */ "",
    /* 56 勤労学生 */ flag(slip.flags.workingStudent),
    /* 57 死亡退職 */ flag(slip.flags.deceasedRetirement),
    /* 58 災害者 */ flag(slip.flags.disaster),
    /* 59 外国人 */ flag(slip.flags.foreigner),
    /* 60 中途就・退職の区分 */ change ? (change.kind === "joined" ? "1" : "2") : "0",
    /* 61 年 */ change ? two(japaneseEra(change.date).year) : "",
    /* 62 月 */ changeParts ? two(changeParts.month) : "",
    /* 63 日 */ changeParts ? two(changeParts.day) : "",
    /* 64 他の支払者－住所 */ previous ? toFullWidth(previous.address) : "",
    /* 65 他の支払者－国外住所表示 */ previous ? "0" : "",
    /* 66 他の支払者－氏名又は名称 */ previous ? toFullWidth(previous.name) : "",
    /* 67 他の支払者－給与等の金額 */ previous ? money(previous.paid) : "",
    /* 68 他の支払者－徴収した金額 */ previous ? money(previous.withheld) : "",
    /* 69 他の支払者－社会保険料の金額 */ previous ? money(previous.socialInsurance) : "",
    /* 70 災害者に係る徴収猶予税額 */ "",
    /* 71 他の支払者を退職した年 */ previous?.leftOn ? two(japaneseEra(previous.leftOn).year) : "",
    /* 72 月 */ previousLeft ? two(previousLeft.month) : "",
    /* 73 日 */ previousLeft ? two(previousLeft.day) : "",
    /* 74〜85 住宅借入金等特別控除の内訳 */ ...Array.from({ length: 12 }, () => ""),
    /* 86 摘要 */ toFullWidth(slip.remarks.join(" ")),
    /* 87 新生命保険料の金額 */ nonZero(life?.newLife),
    /* 88 旧生命保険料の金額 */ nonZero(life?.oldLife),
    /* 89 介護医療保険料の金額 */ nonZero(life?.medical),
    /* 90 新個人年金保険料の金額 */ nonZero(life?.newPension),
    /* 91 16 歳未満扶養親族の数 */ count(slip.minors),
    /* 92 国民年金保険料等の金額 */ nonZero(slip.nationalPension),
    /* 93 非居住者である親族の数 */ count(slip.nonResidentRelatives),
    /* 94 提出義務者の個人番号又は法人番号 */ myNumber(slip.payer.corporateNumber ?? "", 13),
    /* 95 支払を受ける者の個人番号 */ myNumber(numbers.recipient, 12),
    /* 96〜99 （源泉・特別）控除対象配偶者 */ ...relativeItems(
      slip.spousePerson ?? undefined,
      numbers.spouse,
    ),
    /* 100〜115 控除対象扶養親族等 (1)〜(4) */ ...[0, 1, 2, 3].flatMap((index) =>
      relativeItems(slip.dependentPersons[index], numbers.dependents?.[index]),
    ),
    /* 116〜131 16 歳未満の扶養親族 (1)〜(4) */ ...[0, 1, 2, 3].flatMap((index) =>
      relativeItems(slip.minorPersons[index], numbers.minors?.[index]),
    ),
    /* 132 5 人目以降の控除対象扶養親族等の個人番号 */ "",
    /* 133 5 人目以降の 16 歳未満の扶養親族の個人番号 */ "",
    /* 134 普通徴収 */ flag(change?.kind === "left"),
    /* 135 青色専従者 */ "0",
    /* 136 条約免除 */ "0",
    /* 137 支払を受ける者の氏名のフリガナ */ toHalfWidth(slip.recipient.furigana),
    /* 138 受給者番号 */ toHalfWidth(slip.recipient.recipientNo).slice(0, 25),
    /* 139 提出先市町村 */ digitsOnly(slip.recipient.municipalityCode),
    /* 140 指定番号 */ toHalfWidth(options.designatedNumber ?? ""),
    /* 141 基礎控除の額 */ money(slip.basicDeduction),
    /* 142 所得金額調整控除額 */ nonZero(slip.incomeAdjustment),
    /* 143 ひとり親 */ flag(slip.flags.singleParent),
    /* 144 控除対象扶養親族等の数－特親－主 */ count(dependents?.specificRelative),
    /* 145 特親－従 */ count(dependents?.secondary.specificRelative),
    /* 146 特定親族特別控除の額 */ nonZero(slip.specificRelativeDeduction),
    /* 147 作成区分 */ String(options.creationKind ?? 2),
  ];
  if (fields.length !== UNIFIED_CSV_FIELD_COUNT) {
    throw new Error(`unifiedCsvRow: ${fields.length} items instead of ${UNIFIED_CSV_FIELD_COUNT}`);
  }
  return fields;
}

/** What the unified CSV still lacks for a recipient (the screen lists it before the download). */
export function unifiedCsvIssues(slip: WithholdingSlip): string[] {
  const issues: string[] = [];
  if (slip.recipient.address.trim() === "") issues.push("住所（翌年 1 月 1 日現在）");
  if (slip.recipient.furigana.trim() === "") issues.push("フリガナ");
  if (!/^\d{6}$/.test(digitsOnly(slip.recipient.municipalityCode))) {
    issues.push("提出先市町村コード（6 桁）");
  }
  if (slip.payer.address.trim() === "") issues.push("会社の所在地（設定 › 事業所）");
  const relatives = [slip.spousePerson, ...slip.dependentPersons, ...slip.minorPersons];
  if (relatives.some((person) => person !== null && person.name.trim() === "")) {
    issues.push("配偶者・扶養親族の氏名");
  }
  const texts = [slip.recipient.address, slip.recipient.name, ...slip.remarks];
  const forbidden = [...new Set(texts.flatMap(forbiddenCharacters))];
  if (forbidden.length > 0) issues.push(`使えない文字（${forbidden.join(" ")}）`);
  return issues;
}
