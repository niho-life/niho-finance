/**
 * The characters of 財務諸表 CSV (17-financial-statements §5.4): e-Tax accepts JIS X 0208 level 1
 * and 2 only. Text is converted first — half-width letters, digits, symbols and kana to full width
 * (split voiced marks composed), the usual look-alikes to their JIS forms (`〜` → `～`, `−` → `－`),
 * and machine-dependent characters (①, Ⅰ, ㈱, ㎡) to plain full-width text (`（１）`, `（株）`).
 * What still falls outside rows 1–8 and 16–84 of JIS X 0208 (NEC special and IBM extended
 * characters, characters outside Shift_JIS) is reported with where it occurs.
 */
import iconv from "iconv-lite";

/** Look-alikes with a JIS X 0208 form (Shift_JIS / CP932 maps the right-hand side). */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "\u301c": "\uff5e", // 〜 WAVE DASH → ～
  "\u2212": "\uff0d", // − MINUS SIGN → －
  "\u2016": "\u2225", // ‖ → ∥
  "\u00a2": "\uffe0", // ¢ → ￠
  "\u00a3": "\uffe1", // £ → ￡
  "\u00ac": "\uffe2", // ¬ → ￢
  "\u2014": "\u2015", // — EM DASH → ―
  "\u00a5": "\uffe5", // ¥ → ￥
  "\u203e": "\uffe3", // ‾ → ￣
};

/** ASCII whose code point + 0xFEE0 is not in JIS X 0208 (＂ ＇ are IBM extensions). */
const ASCII_SPECIAL: Readonly<Record<string, string>> = {
  " ": "\u3000",
  '"': "\u201d",
  "'": "\u2019",
};

/** Characters that become a parenthesized number or letter (①, Ⅰ, ㊤ …). */
function isEnclosedForm(code: number): boolean {
  return (
    (code >= 0x2460 && code <= 0x2473) || // ①–⑳
    code === 0x24ea || // ⓪
    (code >= 0x24b6 && code <= 0x24e9) || // Ⓐ–ⓩ
    (code >= 0x3251 && code <= 0x325f) || // ㉑–㉟
    (code >= 0x32b1 && code <= 0x32bf) || // ㊱–㊿
    (code >= 0x3280 && code <= 0x32b0) || // ㊀–㊰
    (code >= 0x2160 && code <= 0x217f) // Ⅰ–ⅿ
  );
}

function widenChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const special = ASCII_SPECIAL[char];
  if (special) return special;
  if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + 0xfee0);
  if (code >= 0xff61 && code <= 0xff9f) return char.normalize("NFKC");
  return LOOK_ALIKES[char] ?? char;
}

function composeKana(text: string): string {
  return text
    .normalize("NFC")
    .replaceAll("\u3099", "\u309b") // a voiced mark left alone → ゛
    .replaceAll("\u309a", "\u309c"); // ゜
}

/** Half-width → full-width and the look-alikes (no validation). Newlines are kept. */
export function toEtaxFullWidth(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) out += char === "\n" ? char : widenChar(char);
  return composeKana(out);
}

const jisCache = new Map<string, boolean>();

/**
 * Whether one character is a JIS X 0208 character Shift_JIS can carry: two bytes that decode back
 * to it, in rows 1–8 (non-kanji) or 16–84 (level 1 and 2 kanji). Row 13 (NEC special) and rows
 * 89 and above (NEC-selected IBM and IBM extensions) are not.
 */
export function isJisX0208Char(char: string): boolean {
  const cached = jisCache.get(char);
  if (cached !== undefined) return cached;
  let ok = false;
  if ([...char].length === 1) {
    const bytes = iconv.encode(char, "Shift_JIS");
    if (bytes.length === 2 && iconv.decode(bytes, "Shift_JIS") === char) {
      let lead = bytes[0]!;
      const trail = bytes[1]!;
      if (lead >= 0xe0) lead -= 0x40;
      let row = (lead - 0x81) * 2 + 1;
      if (trail >= 0x9f) row += 1;
      ok = (row >= 1 && row <= 8) || (row >= 16 && row <= 84);
    }
  }
  jisCache.set(char, ok);
  return ok;
}

/** The machine-dependent character as plain full-width text, or `null` when there is none. */
function replacement(char: string): string | null {
  const decomposed = char.normalize("NFKC");
  if (decomposed === char) return null;
  const code = char.codePointAt(0) ?? 0;
  const wide = toEtaxFullWidth(decomposed);
  return isEnclosedForm(code) ? `（${wide}）` : wide;
}

export interface EtaxCharacterProblem {
  char: string;
  /** `U+20BB7` */
  codePoint: string;
  /** Where it occurs, e.g. 「科目「𠮷野商店」」. */
  where: string;
}

function problemsMessage(problems: readonly EtaxCharacterProblem[]): string {
  const parts = problems.map((problem) => `「${problem.char}」（${problem.where}）`);
  return `この文字は e-Tax で使えません: ${parts.join("、")}`;
}

/** Thrown when the CSV would carry a character e-Tax does not accept (17 §5.1). */
export class EtaxCharacterError extends Error {
  readonly problems: readonly EtaxCharacterProblem[];

  constructor(problems: readonly EtaxCharacterProblem[]) {
    super(problemsMessage(problems));
    this.name = "EtaxCharacterError";
    this.problems = problems;
  }
}

function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Converts the texts of one export and remembers the characters that cannot be carried, so that
 * every problem of the four files is reported at once.
 */
export class EtaxTextConverter {
  private readonly found: EtaxCharacterProblem[] = [];

  get problems(): readonly EtaxCharacterProblem[] {
    return this.found;
  }

  /**
   * Full-width JIS X 0208 text. `multiline` keeps line breaks as CRLF (文字の値); otherwise a line
   * break or a tab becomes a full-width space (科目名 cannot break).
   */
  convert(text: string, where: string, options: { multiline?: boolean } = {}): string {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const converted = options.multiline
      ? lines.map((line) => this.convertLine(line, where))
      : [this.convertLine(lines.join("\u3000"), where)];
    return converted.join("\r\n");
  }

  private convertLine(line: string, where: string): string {
    let out = "";
    for (const char of toEtaxFullWidth(line.replaceAll("\t", "\u3000"))) {
      if (isJisX0208Char(char)) {
        out += char;
        continue;
      }
      const replaced = replacement(char);
      if (replaced !== null && [...replaced].every(isJisX0208Char)) {
        out += replaced;
        continue;
      }
      if (!this.found.some((problem) => problem.char === char && problem.where === where)) {
        this.found.push({ char, codePoint: codePointLabel(char), where });
      }
      out += char;
    }
    return out;
  }

  /** Throws `EtaxCharacterError` when any text had a character e-Tax does not accept. */
  throwIfAny(): void {
    if (this.found.length > 0) throw new EtaxCharacterError(this.found);
  }
}

/** One text converted for e-Tax, or the error listing what cannot be carried. */
export function toEtaxText(text: string, where: string, options: { multiline?: boolean } = {}) {
  const converter = new EtaxTextConverter();
  const converted = converter.convert(text, where, options);
  converter.throwIfAny();
  return converted;
}
