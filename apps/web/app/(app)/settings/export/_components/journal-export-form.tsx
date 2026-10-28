"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";

export interface ExportYearOption {
  no: number;
  label: string;
  startDate: string;
  endDate: string;
}

type JournalFormat = "freee" | "yayoi";
type Encoding = "utf8" | "sjis";

/** freee reads UTF-8, 弥生 reads Shift_JIS (14-reports §10): the encoding follows the format. */
const DEFAULT_ENCODING: Readonly<Record<JournalFormat, Encoding>> = {
  freee: "utf8",
  yayoi: "sjis",
};

/**
 * 仕訳の書き出し (14-reports §10): 形式, 期間 (第 n 期 or 任意), 文字コード. A GET form: 「書き出す」
 * downloads the file. Without JavaScript the defaults (freee, UTF-8, the current year) apply.
 */
export function JournalExportForm({
  years,
  defaultYear,
}: {
  years: readonly ExportYearOption[];
  defaultYear: number | null;
}) {
  const [format, setFormat] = useState<JournalFormat>("freee");
  const [encoding, setEncoding] = useState<Encoding>("utf8");
  const [range, setRange] = useState(defaultYear === null ? "custom" : String(defaultYear));
  const current = years.find((year) => String(year.no) === range) ?? years[years.length - 1];

  return (
    <form
      method="get"
      action="/settings/export/download"
      className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <FormField label="形式" htmlFor="journal-kind">
        <Select
          id="journal-kind"
          name="kind"
          value={format}
          onChange={(event) => {
            const next = event.target.value === "yayoi" ? "yayoi" : "freee";
            setFormat(next);
            setEncoding(DEFAULT_ENCODING[next]);
          }}
        >
          <option value="freee">freee 形式</option>
          <option value="yayoi">弥生形式</option>
        </Select>
      </FormField>
      <FormField label="期間" htmlFor="journal-fy">
        <Select
          id="journal-fy"
          name="fy"
          value={range}
          onChange={(event) => setRange(event.target.value)}
        >
          {years.map((year) => (
            <option key={year.no} value={year.no}>
              {year.label}
            </option>
          ))}
          <option value="custom">任意の期間</option>
        </Select>
      </FormField>
      {range === "custom" ? (
        <>
          <FormField label="開始日" htmlFor="journal-from">
            <Input
              id="journal-from"
              type="date"
              name="from"
              required
              defaultValue={current?.startDate}
            />
          </FormField>
          <FormField label="終了日" htmlFor="journal-to">
            <Input id="journal-to" type="date" name="to" required defaultValue={current?.endDate} />
          </FormField>
        </>
      ) : null}
      <FormField
        label="文字コード"
        htmlFor="journal-encoding"
        help="freee は UTF-8、弥生は Shift_JIS が既定です。Shift_JIS で表せない文字（絵文字や一部の漢字）は「?」になるので、そのときは UTF-8 で書き出します。"
      >
        <Select
          id="journal-encoding"
          name="encoding"
          value={encoding}
          onChange={(event) => setEncoding(event.target.value === "sjis" ? "sjis" : "utf8")}
        >
          <option value="utf8">UTF-8</option>
          <option value="sjis">Shift_JIS</option>
        </Select>
      </FormField>
      <div className="flex items-start sm:col-span-2 lg:col-span-4">
        <Button type="submit" variant="primary">
          書き出す
        </Button>
      </div>
    </form>
  );
}
