import { listRecentExports, loadReportSource, todayInJapan } from "@niho-finance/db";
import { fiscalYearOn } from "@niho-finance/reports";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatPeriod } from "@/lib/format";
import { formatDateTime, segmentName } from "../../reports/_lib/format";
import { JournalExportForm } from "./_components/journal-export-form";
import { EXPORT_ERRORS, EXPORT_FORMAT_LABELS, EXPORT_KIND_LABELS } from "./labels";

export const metadata: Metadata = { title: "書き出しとバックアップ" };

const RECENT_COLUMNS = {
  columns: "9.5rem minmax(6.5rem,1fr) 7.5rem minmax(11rem,1.8fr) minmax(5rem,0.8fr)",
  mobileColumns: "auto minmax(0,1fr)",
};

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-t border-border pt-5 pb-7">
      <h2 id={id} className="text-[15px] font-extrabold">
        {title}
      </h2>
      <div className="mt-1 mb-3 text-[13px] text-muted">{description}</div>
      {children}
    </section>
  );
}

/**
 * 設定 › 書き出しとバックアップ (14-reports §10): one GET form per export; 「書き出す」 downloads the
 * file (`/settings/export/download`). Every download is in the audit log and in 最近の書き出し.
 */
export default async function ExportSettingsPage({ searchParams }: PageProps<"/settings/export">) {
  const { error } = await searchParams;
  const prisma = await db();
  const source = await loadReportSource(prisma);
  const recent = await listRecentExports(prisma);
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const current = fiscalYearOn(years, todayInJapan());
  const yearOptions = years.map((year) => ({
    no: year.no,
    label: `第${year.no}期 ${formatPeriod(year.startDate, year.endDate)}`,
    startDate: year.startDate,
    endDate: year.endDate,
  }));
  const errorMessage = typeof error === "string" ? EXPORT_ERRORS[error] : undefined;

  return (
    <>
      <PageHeader title="書き出しとバックアップ" back={{ href: "/settings", label: "設定" }} />
      {errorMessage ? (
        <p role="alert" className="mb-4 rounded-card bg-warn-soft px-4 py-3 text-[14px] text-warn">
          {errorMessage}
        </p>
      ) : null}

      <Section
        id="export-journal"
        title="仕訳の書き出し"
        description="freee 会計・弥生会計の「仕訳データのインポート」で読める形式で書き出します。取消済みの仕訳と反対仕訳も含みます。"
      >
        <JournalExportForm years={yearOptions} defaultYear={current?.no ?? null} />
      </Section>

      <Section
        id="export-beancount"
        title="beancount"
        description={
          <>
            帳簿をテキストの複式簿記（beancount）で書き出します。
            <code className="mx-1">bean-check</code>と Fava で検算できます。
          </>
        }
      >
        <form
          method="get"
          action="/settings/export/download"
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="kind" value="beancount" />
          <FormField label="期" htmlFor="beancount-fy" className="w-full sm:w-80">
            <Select id="beancount-fy" name="fy" defaultValue={current ? String(current.no) : "all"}>
              {yearOptions.map((year) => (
                <option key={year.no} value={year.no}>
                  {year.label}
                </option>
              ))}
              <option value="all">全期間</option>
            </Select>
          </FormField>
          <Button type="submit" variant="primary">
            書き出す
          </Button>
        </form>
      </Section>

      <Section
        id="export-documents"
        title="証憑一式"
        description="索引の CSV（証憑 ID・種類・日付・金額・取引先・登録番号・仕訳 No.・明細・ファイル名・SHA-256）と証憑のファイルを zip で書き出します。"
      >
        <form
          method="get"
          action="/settings/export/download"
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="kind" value="documents" />
          <input type="hidden" name="fy" value="custom" />
          <FormField label="開始日" htmlFor="documents-from" className="w-full sm:w-44">
            <Input
              id="documents-from"
              type="date"
              name="from"
              required
              defaultValue={current?.startDate}
            />
          </FormField>
          <FormField label="終了日" htmlFor="documents-to" className="w-full sm:w-44">
            <Input
              id="documents-to"
              type="date"
              name="to"
              required
              defaultValue={current?.endDate}
            />
          </FormField>
          <Button type="submit" variant="primary">
            書き出す
          </Button>
        </form>
      </Section>

      <Section
        id="export-backup"
        title="バックアップ"
        description="設定・仕訳・明細・証憑の情報・仕訳帳の CSV・beancount を 1 つの zip にします（毎日のバックアップと同じ中身）。"
      >
        <form method="get" action="/settings/export/download">
          <input type="hidden" name="kind" value="backup" />
          <Button type="submit" variant="primary">
            今すぐ書き出す
          </Button>
        </form>
      </Section>

      <Section
        id="export-statements"
        title="決算書と申告用データ"
        description="計算書類の PDF、e-Tax の財務諸表 CSV、勘定科目内訳の元データ、消費税の集計、決算公告の HTML は決算書の画面から書き出します。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href="/closing/statements" variant="primary">
            決算書を開く
          </ButtonLink>
          <ButtonLink href="/closing/statements/consumption-tax">消費税の集計を開く</ButtonLink>
        </div>
      </Section>

      <section aria-labelledby="export-recent" className="border-t border-border pt-5">
        <h2 id="export-recent" className="mb-3 text-[15px] font-extrabold">
          最近の書き出し
        </h2>
        {recent.length === 0 ? (
          <EmptyState
            title="書き出しの記録はまだありません"
            description="報告の「CSV」「PDF」やこのページの「書き出す」で書き出すと、ここに残ります。"
          />
        ) : (
          <Table label="最近の書き出し">
            <TableHead {...RECENT_COLUMNS}>
              <Th>日時</Th>
              <Th>種類</Th>
              <Th sm="hide">形式</Th>
              <Th>期間</Th>
              <Th sm="hide">実行者</Th>
            </TableHead>
            {recent.map((row) => {
              const format = EXPORT_FORMAT_LABELS[row.format] ?? row.format;
              const range =
                row.from && row.to
                  ? `${row.fiscalYearNo ? `第${row.fiscalYearNo}期 ` : ""}${formatPeriod(row.from, row.to)}`
                  : "全期間";
              const segment = row.segment ? ` · ${segmentName(source.segments, row.segment)}` : "";
              return (
                <TableRow key={row.id} {...RECENT_COLUMNS}>
                  <Td className="num text-[13px] text-muted">{formatDateTime(row.at)}</Td>
                  <Td className="font-bold">{EXPORT_KIND_LABELS[row.kind] ?? "書き出し"}</Td>
                  <Td sm="hide" className="text-[13px]">
                    {row.encoding === "sjis" ? `${format}（Shift_JIS）` : format}
                  </Td>
                  <Td sm="full" className="num text-[13px]">
                    {range}
                    {segment}
                  </Td>
                  <Td sm="hide" className="truncate text-[13px] text-muted">
                    {row.actor}
                  </Td>
                </TableRow>
              );
            })}
          </Table>
        )}
      </section>
    </>
  );
}
