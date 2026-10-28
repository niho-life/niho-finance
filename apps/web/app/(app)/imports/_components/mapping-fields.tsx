"use client";

import { Checkbox, describedBy, FormField, Input, Select } from "@/components/ui/form";
import {
  MAPPING_COLUMN_LABELS,
  MAPPING_COLUMNS,
  MAPPING_ORDER_LABELS,
  REQUIRED_MAPPING_COLUMNS,
  type MappingDraft,
  type MappingOrder,
} from "../_lib/mapping";

export interface ColumnOption {
  /** The 0-based column index as text. */
  value: string;
  label: string;
}

/** `1 列目` … for a mapping without a file (取込の設定). */
export function numberedColumns(count: number): ColumnOption[] {
  return Array.from({ length: count }, (_, index) => ({
    value: String(index),
    label: `${index + 1} 列目`,
  }));
}

const HEADER_LABEL_LENGTH = 14;

/** `1 列目: 日付` from the first non-empty cell of each column (the CSV screen). */
export function columnsOfTable(table: readonly string[][], columnCount: number): ColumnOption[] {
  return Array.from({ length: columnCount }, (_, index) => {
    const cell = table.map((row) => row[index]?.trim() ?? "").find((text) => text !== "");
    const name =
      cell === undefined
        ? ""
        : cell.length > HEADER_LABEL_LENGTH
          ? `${cell.slice(0, HEADER_LABEL_LENGTH)}…`
          : cell;
    return {
      value: String(index),
      label: name ? `${index + 1} 列目: ${name}` : `${index + 1} 列目`,
    };
  });
}

/**
 * The column mapping of 汎用 (12-imports §1.2): 日付・摘要 and either 金額（符号付き） or 出金・入金,
 * with 残高・相手, ヘッダ行の数, the sign and the order. `errorOf` takes the path inside the
 * mapping (`columns.date`, `headerRows`).
 */
export function MappingFields({
  idPrefix,
  draft,
  onChange,
  columns,
  errorOf,
}: {
  idPrefix: string;
  draft: MappingDraft;
  onChange: (draft: MappingDraft) => void;
  columns: readonly ColumnOption[];
  errorOf: (path: string) => string | undefined;
}) {
  // A saved column beyond the file's columns stays choosable (and visible) instead of vanishing.
  const known = new Set(columns.map((column) => column.value));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {MAPPING_COLUMNS.map((column) => {
          const id = `${idPrefix}-${column}`;
          const error = errorOf(`columns.${column}`);
          const value = draft.columns[column];
          const required = REQUIRED_MAPPING_COLUMNS.has(column);
          return (
            <FormField
              key={column}
              label={MAPPING_COLUMN_LABELS[column]}
              htmlFor={id}
              required={required}
              error={error}
            >
              <Select
                id={id}
                value={value}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    columns: { ...draft.columns, [column]: event.currentTarget.value },
                  })
                }
                {...describedBy(id, { error })}
              >
                <option value="">{required ? "選んでください" : "なし"}</option>
                {value !== "" && !known.has(value) ? (
                  <option value={value}>{`${Number(value) + 1} 列目`}</option>
                ) : null}
                {columns.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
          );
        })}
      </div>
      <p className="text-[12px] text-muted">
        金額は「金額（符号付き）」か「出金・入金」のどちらかで選びます。
      </p>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FormField
          label="ヘッダ行の数"
          htmlFor={`${idPrefix}-header-rows`}
          help="先頭から読み飛ばす行の数"
          error={errorOf("headerRows")}
        >
          <Input
            id={`${idPrefix}-header-rows`}
            type="number"
            inputMode="numeric"
            min={0}
            max={50}
            value={draft.headerRows}
            onChange={(event) => onChange({ ...draft, headerRows: event.currentTarget.value })}
            {...describedBy(`${idPrefix}-header-rows`, {
              help: true,
              error: errorOf("headerRows"),
            })}
          />
        </FormField>
        <FormField label="並び" htmlFor={`${idPrefix}-order`} error={errorOf("order")}>
          <Select
            id={`${idPrefix}-order`}
            value={draft.order}
            onChange={(event) =>
              onChange({ ...draft, order: event.currentTarget.value as MappingOrder })
            }
          >
            {(Object.keys(MAPPING_ORDER_LABELS) as MappingOrder[]).map((order) => (
              <option key={order} value={order}>
                {MAPPING_ORDER_LABELS[order]}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="sm:col-span-2">
          <Checkbox
            id={`${idPrefix}-invert`}
            label="金額の正を出金として扱う（カードの利用金額など）"
            checked={draft.invertSign}
            onChange={(event) => onChange({ ...draft, invertSign: event.currentTarget.checked })}
          />
          {errorOf("invertSign") ? (
            <p className="text-[12px] font-bold text-danger">{errorOf("invertSign")}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
