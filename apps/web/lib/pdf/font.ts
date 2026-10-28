import fs from "node:fs";
import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Noto Sans JP for every PDF of the app (14-reports §12): registered once per process. Reports,
 * statements (#15), invoices (#16) and payslips (#20) call `registerFonts()` (through
 * `renderPdf`) and use `PDF_FONT_FAMILY`; nobody registers fonts again.
 */
export const PDF_FONT_FAMILY = "Noto Sans JP";

interface FontFiles {
  regular: string;
  bold: string;
}

/**
 * `next dev` / `next start` run with the working directory `apps/web`; scripts and tests may run
 * from the repository root. The paths are literal so that the build traces exactly these files
 * (a standalone build must still ship `lib/pdf/fonts/**`: S8, `outputFileTracingIncludes`).
 */
export function pdfFontFiles(): FontFiles {
  const inApp = path.join(process.cwd(), "lib/pdf/fonts/NotoSansJP-Regular.ttf");
  if (fs.existsSync(inApp)) {
    return {
      regular: inApp,
      bold: path.join(process.cwd(), "lib/pdf/fonts/NotoSansJP-Bold.ttf"),
    };
  }
  const fromRoot = path.join(process.cwd(), "apps/web/lib/pdf/fonts/NotoSansJP-Regular.ttf");
  if (fs.existsSync(fromRoot)) {
    return {
      regular: fromRoot,
      bold: path.join(process.cwd(), "apps/web/lib/pdf/fonts/NotoSansJP-Bold.ttf"),
    };
  }
  throw new Error(`PDF fonts are missing: looked for ${inApp} and ${fromRoot}`);
}

/** Closing punctuation that must not start a line (行頭禁則). */
const NO_LINE_START = new Set([
  ..."、。，．・：；？！ー―‐）〕］｝〉》」』】〙〗’”ゝゞヽヾ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ),.:;!?%",
]);
/** Opening brackets that must not end a line (行末禁則). */
const NO_LINE_END = new Set([..."（〔［｛〈《「『【〘〖‘“("]);

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x30ff) || // CJK punctuation, hiragana, katakana
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

/**
 * Line-break opportunities for Japanese, which has no spaces between words. react-pdf breaks a
 * "word" only at the parts the hyphenation callback returns, and draws a hyphen at such a break;
 * an empty part is zero-width glue, where it breaks without a hyphen. So CJK characters are
 * separated by `""`, Latin words and numbers stay whole (an amount never breaks), and simple
 * 禁則 keeps closing punctuation off the start of a line and opening brackets off its end.
 */
export function japaneseLineBreaks(word: string): string[] {
  const parts: string[] = [];
  let latin = "";
  let pendingOpen = "";
  const pushBreakable = (text: string) => {
    if (parts.length > 0 && parts[parts.length - 1] !== "") parts.push("");
    parts.push(text);
  };
  for (const char of word) {
    if (!isCjk(char)) {
      if (NO_LINE_START.has(char) && latin === "" && pendingOpen === "" && parts.length > 0) {
        parts[parts.length - 1] += char;
        continue;
      }
      latin += char;
      continue;
    }
    if (latin) {
      pushBreakable(pendingOpen + latin);
      pendingOpen = "";
      latin = "";
    }
    if (NO_LINE_END.has(char)) {
      pendingOpen += char;
      continue;
    }
    if (NO_LINE_START.has(char) && pendingOpen === "" && parts.length > 0) {
      parts[parts.length - 1] += char;
      continue;
    }
    pushBreakable(pendingOpen + char);
    pendingOpen = "";
  }
  if (latin || pendingOpen) pushBreakable(pendingOpen + latin);
  return parts.length > 0 ? parts : [word];
}

let registered = false;

/** Registers Noto Sans JP 400 / 700 and the Japanese line breaking. Idempotent. */
export function registerFonts(): void {
  if (registered) return;
  const files = pdfFontFiles();
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: files.regular, fontWeight: 400 },
      { src: files.bold, fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback(japaneseLineBreaks);
  registered = true;
}
