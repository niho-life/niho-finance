import type { GenericCsvConfig } from "@niho-finance/importers";

/*
 * The column mapping of 汎用 (`GenericCsvConfig`) as the editor holds it: each column as the text
 * of its select ("" = なし, otherwise the 0-based index). Client components use these helpers;
 * the repository's schema validates what they produce.
 */

export const MAPPING_COLUMNS = [
  "date",
  "description",
  "amount",
  "withdrawal",
  "deposit",
  "balance",
  "counterparty",
] as const;
export type MappingColumn = (typeof MAPPING_COLUMNS)[number];

export const MAPPING_COLUMN_LABELS: Readonly<Record<MappingColumn, string>> = {
  date: "日付",
  description: "摘要",
  amount: "金額（符号付き）",
  withdrawal: "出金",
  deposit: "入金",
  balance: "残高",
  counterparty: "相手",
};

export const REQUIRED_MAPPING_COLUMNS: ReadonlySet<MappingColumn> = new Set([
  "date",
  "description",
]);

export type MappingOrder = NonNullable<GenericCsvConfig["order"]>;

export const MAPPING_ORDER_LABELS: Readonly<Record<MappingOrder, string>> = {
  auto: "自動",
  asc: "古い順",
  desc: "新しい順",
};

export interface MappingDraft {
  headerRows: string;
  columns: Record<MappingColumn, string>;
  invertSign: boolean;
  order: MappingOrder;
}

export function emptyMappingDraft(): MappingDraft {
  return {
    headerRows: "1",
    columns: {
      date: "",
      description: "",
      amount: "",
      withdrawal: "",
      deposit: "",
      balance: "",
      counterparty: "",
    },
    invertSign: false,
    order: "auto",
  };
}

export function mappingDraftOf(config: GenericCsvConfig | null): MappingDraft {
  const draft = emptyMappingDraft();
  if (!config) return draft;
  for (const column of MAPPING_COLUMNS) {
    const index = config.columns[column];
    draft.columns[column] = index === undefined ? "" : String(index);
  }
  return {
    ...draft,
    headerRows: String(config.headerRows),
    invertSign: config.invertSign ?? false,
    order: config.order ?? "auto",
  };
}

/** What the Server Actions receive as the mapping (the schema converts the texts). */
export function mappingPayload(draft: MappingDraft) {
  return {
    headerRows: draft.headerRows,
    columns: { ...draft.columns },
    invertSign: draft.invertSign,
    order: draft.order,
  };
}

/** The highest 0-based column a saved mapping names, or -1. */
export function highestMappedColumn(config: GenericCsvConfig | null): number {
  if (!config) return -1;
  return Math.max(-1, ...Object.values(config.columns).filter((value) => value !== undefined));
}
