import type { CalendarDate } from "@niho-finance/ledger";
import type { CsvFormat, CsvFormatKey, GenericCsvConfig, ParsedStatement } from "../types";
import { checkBalanceContinuity } from "./balance";
import { assignExternalIds } from "./external-id";
import { docomoSmtb } from "./formats/docomo-smtb";
import { generic } from "./formats/generic";
import { gmoAozoraZengin } from "./formats/gmo-aozora-zengin";
import { rakutenCard } from "./formats/rakuten-card";
import { orderChronologically, type StatementOrder } from "./order";

const FORMATS_BY_KEY: Readonly<Record<CsvFormatKey, CsvFormat>> = {
  gmo_aozora_zengin: gmoAozoraZengin,
  docomo_smtb: docomoSmtb,
  rakuten_card: rakutenCard,
  generic,
};

/** The formats in the order of the screen's select and of detection (12-imports §3.1). */
export const CSV_FORMATS: readonly CsvFormat[] = [
  FORMATS_BY_KEY.gmo_aozora_zengin,
  FORMATS_BY_KEY.docomo_smtb,
  FORMATS_BY_KEY.rakuten_card,
  FORMATS_BY_KEY.generic,
];

export const CSV_FORMAT_LABELS: Readonly<Record<CsvFormatKey, string>> = {
  gmo_aozora_zengin: gmoAozoraZengin.label,
  docomo_smtb: docomoSmtb.label,
  rakuten_card: rakutenCard.label,
  generic: generic.label,
};

/** The first format that recognizes the table, or `null` (choose 汎用 and map the columns). */
export function detectCsvFormat(table: string[][]): CsvFormatKey | null {
  return CSV_FORMATS.find((format) => format.detect(table))?.key ?? null;
}

/** 全銀 records are in date order by construction; the other formats may list newest first. */
function orderOf(format: CsvFormatKey, config: GenericCsvConfig | null): StatementOrder {
  switch (format) {
    case "gmo_aozora_zengin":
      return "asc";
    case "docomo_smtb":
    case "rakuten_card":
      return "auto";
    case "generic":
      return config?.order ?? "auto";
  }
}

function periodOf(rows: ParsedStatement["rows"]): ParsedStatement["period"] {
  let from: CalendarDate | null = null;
  let to: CalendarDate | null = null;
  for (const { txnDate } of rows) {
    if (from === null || txnDate < from) from = txnDate;
    if (to === null || txnDate > to) to = txnDate;
  }
  return from === null || to === null ? null : { from, to };
}

/**
 * Reads a CSV table in the given format: the rows oldest first with their external IDs, the
 * failures, and warnings (the format's own and the balance continuity of §3.4). The period is the
 * format's (the 全銀 header) or else the first and last dates of the rows.
 */
export function parseStatement(input: {
  table: string[][];
  format: CsvFormatKey;
  config?: GenericCsvConfig | null;
}): ParsedStatement {
  if (!Object.hasOwn(FORMATS_BY_KEY, input.format)) {
    throw new RangeError(`取込形式が正しくありません（${String(input.format)}）`);
  }
  const config = input.config ?? null;
  const parsed = FORMATS_BY_KEY[input.format].parse(input.table, config);
  const rows = assignExternalIds(orderChronologically(parsed.rows, orderOf(input.format, config)));
  return {
    ...parsed,
    rows,
    warnings: [...parsed.warnings, ...checkBalanceContinuity(rows, parsed.openingBalance)],
    period: parsed.period ?? periodOf(rows),
  };
}
