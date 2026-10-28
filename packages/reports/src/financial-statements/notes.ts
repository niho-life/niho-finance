/**
 * 個別注記表 (17-financial-statements §4.4): only what a non-public company without an accounting
 * auditor has to show (会社計算規則 98 条 2 項 1 号) — 重要な会計方針, 株主資本等変動計算書に関する
 * 注記 (the number of shares at the end of the year) and その他の注記. Empty items are left out.
 */
import { formatYen } from "@niho-finance/ledger";
import { codeRow, type EtaxEdition } from "./etax/editions";
import {
  ACCOUNTING_STANDARD_SENTENCE,
  type ResolvedStatementSettings,
  type StatementNote,
} from "./settings";

export interface NoteItem {
  /** The NT code of the item (NT1202 for the items of その他の注記). */
  code: string;
  title: string;
  body: string;
}

export interface NoteSection {
  /** NT0201 / NT0501 / NT1201 */
  code: string;
  title: string;
  /** The text under the title itself (`null` for その他の注記). */
  body: string | null;
  items: NoteItem[];
}

export interface StatementNotes {
  sections: NoteSection[];
  /** 発行済株式の総数 at the end of the year (`null`: not entered, the note is left out). */
  issuedShares: number | null;
  /** その他の注記 in order (誤謬の訂正 first). */
  otherNotes: readonly StatementNote[];
}

export const ERROR_CORRECTION_TITLE = "誤謬の訂正";

/** 「当事業年度の末日における発行済株式の数 普通株式 10,000株」 */
export function issuedSharesSentence(shares: number): string {
  return `当事業年度の末日における発行済株式の数\u3000普通株式\u3000${formatYen(BigInt(shares))}株`;
}

function present(text: string): boolean {
  return text.trim() !== "";
}

export function buildNotes(
  edition: EtaxEdition,
  settings: ResolvedStatementSettings,
): StatementNotes {
  const codes = edition.layout.notes;
  const label = (code: string) => codeRow(edition.tables.NT, code)?.label ?? code;
  const sections: NoteSection[] = [];

  const policyItems: NoteItem[] = [];
  const policy = (code: string, body: string) => {
    if (present(body)) policyItems.push({ code, title: label(code), body: body.trim() });
  };
  policy(codes.depreciation, settings.notes.depreciation);
  policy(codes.revenueRecognition, settings.notes.revenueRecognition);
  policy(codes.otherSignificant, settings.notes.otherSignificant);
  policy(codes.policyChanges, settings.notes.accountingPolicyChanges);
  policy(codes.presentationChanges, settings.notes.presentationChanges);
  sections.push({
    code: codes.accountingPolicies,
    title: label(codes.accountingPolicies),
    body: ACCOUNTING_STANDARD_SENTENCE,
    items: policyItems,
  });

  if (settings.issuedShares !== null) {
    sections.push({
      code: codes.equityNote,
      title: label(codes.equityNote),
      body: issuedSharesSentence(settings.issuedShares),
      items: [],
    });
  }

  const otherNotes: StatementNote[] = [];
  if (present(settings.notes.errorCorrections)) {
    otherNotes.push({
      title: ERROR_CORRECTION_TITLE,
      body: settings.notes.errorCorrections.trim(),
    });
  }
  for (const note of settings.notes.otherNotes) {
    if (present(note.title) || present(note.body)) {
      otherNotes.push({ title: note.title.trim(), body: note.body.trim() });
    }
  }
  if (otherNotes.length > 0) {
    sections.push({
      code: codes.otherNotes,
      title: label(codes.otherNotes),
      body: null,
      items: otherNotes.map((note) => ({
        code: codes.otherNoteTitle,
        title: note.title,
        body: note.body,
      })),
    });
  }
  return { sections, issuedShares: settings.issuedShares, otherNotes };
}

/** 重要な会計方針に係る事項に関する注記 (also in 決算公告, 会社計算規則 136 条). */
export function accountingPolicySection(
  notes: StatementNotes,
  edition: EtaxEdition,
): NoteSection | null {
  return (
    notes.sections.find((section) => section.code === edition.layout.notes.accountingPolicies) ??
    null
  );
}
