import {
  calendarItemStatus,
  loadDepreciableAssetsReturn,
  todayInJapan,
  type DepreciableAssetsReturnData,
} from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import {
  propertyTaxAssetTypeText,
  warekiDate,
  warekiYear,
  type DepreciableAssetsReturnExcludedRow,
  type DepreciableAssetsReturnRow,
  type DepreciableAssetsReturnTotal,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusText } from "@/app/(app)/calendar/_components/status-text";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button, buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatPeriod, formatYenDisplay } from "@/lib/format";
import { Facts, Note } from "../../_components/parts";
import { methodLabel } from "../_components/asset-kit";
import { MunicipalityForm } from "./_components/municipality-form";
import { returnExportHref, returnYearOf } from "./_lib/year";

export const metadata: Metadata = { title: "償却資産申告" };

/** The return year select of the header (GET, sent on change; 表示 without JS). */
function YearSelect({ years, current }: { years: readonly number[]; current: number }) {
  return (
    <form method="get" action="/closing/assets/return" className="flex items-center gap-2">
      <AutoSubmitSelect
        name="year"
        aria-label="申告年"
        defaultValue={String(current)}
        className="min-h-8 w-auto py-1 text-[13px]"
      >
        {years.map((year) => (
          <option key={year} value={year}>
            {year} 年（{warekiYear(year)}）の申告
          </option>
        ))}
      </AutoSubmitSelect>
      <noscript>
        <Button type="submit" size="sm">
          表示
        </Button>
      </noscript>
    </form>
  );
}

function totalText(total: DepreciableAssetsReturnTotal): string {
  return `${total.count} 件 · ${formatYenDisplay(total.cost)} 円`;
}

function typeText(row: DepreciableAssetsReturnRow): string {
  return row.assetType === null ? "未選択" : propertyTaxAssetTypeText(row.assetType);
}

function AssetName({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/closing/assets/${id}`}
      className="font-semibold break-words underline-offset-4 hover:underline"
    >
      {name}
    </Link>
  );
}

/** 資産の種類 · 名称 · 数量 · 取得年月 · 取得価額 · 耐用年数 · 事由 · 摘要; phones: 名称・取得価額 / 種類・取得年月. */
const ROW_COLUMNS = {
  columns: "minmax(0,1.1fr) minmax(0,1.4fr) 44px 128px 112px 64px minmax(0,0.8fr) minmax(0,1.2fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function ReturnRows({
  label,
  rows,
  reasonHeader,
  reasonOf,
}: {
  label: string;
  rows: readonly DepreciableAssetsReturnRow[];
  reasonHeader: string;
  reasonOf: (row: DepreciableAssetsReturnRow) => string | null;
}) {
  return (
    <Table label={label}>
      <TableHead {...ROW_COLUMNS}>
        <Th sm="hide">資産の種類</Th>
        <Th>資産の名称等</Th>
        <Th align="right" sm="hide">
          数量
        </Th>
        <Th sm="hide">取得年月</Th>
        <Th align="right">取得価額（円）</Th>
        <Th align="right" sm="hide">
          耐用年数
        </Th>
        <Th sm="hide">{reasonHeader}</Th>
        <Th sm="hide">摘要</Th>
      </TableHead>
      {rows.map((row) => {
        const reason = reasonOf(row);
        return (
          <TableRow key={row.assetId} {...ROW_COLUMNS}>
            <Td sm="hide" className={`text-[13px] ${row.assetType === null ? "text-warn" : ""}`}>
              {typeText(row)}
            </Td>
            <Td>
              <AssetName id={row.assetId} name={row.name} />
            </Td>
            <Td sm="hide" align="right">
              {row.quantity}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {row.acquisitionWareki}
              <span className="num block text-[11px] text-muted">{row.acquisitionYearMonth}</span>
            </Td>
            <Td align="right" className="font-bold">
              {formatYenDisplay(row.cost)}
            </Td>
            <Td sm="hide" align="right" className={row.usefulLifeYears === null ? "text-warn" : ""}>
              {row.usefulLifeYears === null ? "未入力" : `${row.usefulLifeYears} 年`}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {reason ?? "—"}
            </Td>
            <Td sm="hide" className="text-[12px] break-words text-muted">
              {row.note ?? ""}
            </Td>
            <span role="cell" className="col-span-full min-w-0 text-[12px] text-muted md:hidden">
              <span className={row.assetType === null ? "text-warn" : ""}>{typeText(row)}</span> ·{" "}
              {row.acquisitionWareki}
              {reason ? ` · ${reason}` : ""}
            </span>
          </TableRow>
        );
      })}
    </Table>
  );
}

/** 名称 · 科目 · 取得日 · 取得価額 · 償却方法 · 理由; phones: 名称・取得価額 / 理由. */
const EXCLUDED_COLUMNS = {
  columns: "minmax(0,1.4fr) minmax(0,1fr) 92px 112px minmax(0,1fr) minmax(0,1.4fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function ExcludedRows({ rows }: { rows: readonly DepreciableAssetsReturnExcludedRow[] }) {
  return (
    <Table label="対象外の資産">
      <TableHead {...EXCLUDED_COLUMNS}>
        <Th>名称</Th>
        <Th sm="hide">科目</Th>
        <Th sm="hide">取得日</Th>
        <Th align="right">取得価額（円）</Th>
        <Th sm="hide">償却方法</Th>
        <Th sm="hide">対象外の理由</Th>
      </TableHead>
      {rows.map((row) => (
        <TableRow key={row.assetId} {...EXCLUDED_COLUMNS}>
          <Td>
            <AssetName id={row.assetId} name={row.name} />
          </Td>
          <Td sm="hide" className="truncate text-[13px]">
            {row.accountName}
          </Td>
          <Td sm="hide" className="num text-[13px]">
            {formatDate(row.acquisitionDate)}
          </Td>
          <Td align="right">{formatYenDisplay(row.cost)}</Td>
          <Td sm="hide" className="text-[13px]">
            {methodLabel(row.method, row.cost)}
          </Td>
          <Td sm="hide" className="text-[13px] break-words">
            {row.reason}
          </Td>
          <span role="cell" className="col-span-full min-w-0 text-[12px] text-muted md:hidden">
            {row.reason}
          </span>
        </TableRow>
      ))}
    </Table>
  );
}

function Section({
  id,
  title,
  total,
  description,
  children,
}: {
  id: string;
  title: string;
  total: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-7">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={id} className="text-[15px] font-extrabold">
          {title}
        </h2>
        <span className="num text-[13px] text-muted">{total}</span>
      </div>
      {description ? <div className="mb-2">{description}</div> : null}
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted">{children}</p>;
}

/** 期限 (§14.4): the calendar's 1/31 item and its state; completed on /calendar. */
function deadlineValue(data: DepreciableAssetsReturnData, today: CalendarDate): ReactNode {
  if (!data.deadline) return <span className="num">{formatDate(`${data.year}-01-31`)}</span>;
  return (
    <>
      <span className="num">{formatDate(data.deadline.dueDate)}</span>
      <span className="ml-1.5 text-[13px]">
        <StatusText status={calendarItemStatus(data.deadline, today)} />
      </span>
    </>
  );
}

/** 申告の前に直す資産 (§14.4): a reported asset without a kind or a useful life. */
function Warnings({ data }: { data: DepreciableAssetsReturnData }) {
  if (data.warnings.length === 0) return null;
  return (
    <div role="status" className="mt-5 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
      <p className="font-bold">申告の前に入れる項目があります</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {data.warnings.map((warning) => (
          <li key={`${warning.assetId}-${warning.kind}`} className="break-words">
            <Link
              href={`/closing/assets/${warning.assetId}`}
              className="font-bold underline underline-offset-4"
            >
              {warning.name}
            </Link>
            : {warning.message}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[12px]">固定資産の詳細の「編集」で入れます。</p>
    </div>
  );
}

/** 償却資産申告の元データ (16 §14.4): the return of year Y from the fixed asset register. */
export default async function DepreciableAssetsReturnPage({
  searchParams,
}: PageProps<"/closing/assets/return">) {
  const query = await searchParams;
  const today = todayInJapan();
  const year = returnYearOf(query.year, today);
  const data = await loadDepreciableAssetsReturn(await db(), { year, today });
  const period = formatPeriod(data.window.from, data.window.to);

  return (
    <>
      <PageHeader
        title="償却資産申告"
        meta={`${warekiDate(data.assessmentDate)}現在`}
        back={{ href: "/closing/assets", label: "固定資産台帳" }}
        actions={<YearSelect years={data.years} current={year} />}
      />
      <p className="mb-4 text-[13px] break-words text-muted">
        1 月 1 日に持っている償却資産を、1 月 31
        日までに市町村へ申告します。ここで種類別明細書の元データを書き出し、申告書は eLTAX
        か紙で作って出します。
      </p>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <MunicipalityForm municipality={data.municipality ?? ""} />
        <div className="flex flex-col gap-2">
          <Facts
            label="申告の概要"
            items={[
              {
                label: "判定の日",
                value: formatDate(data.assessmentDate),
              },
              { label: "増加・減少の期間", value: period },
              { label: "期限", value: deadlineValue(data, today) },
              { label: "全資産", value: totalText(data.totals.all), strong: true },
            ]}
          />
          <Note>
            {data.deadline
              ? "完了は"
              : "期限の画面にこの年の行がまだありません（1 月 31 日を含む会計期間を作ると出ます）。完了は"}
            <Link href="/calendar" className="mx-1 font-bold underline underline-offset-4">
              期限
            </Link>
            の画面で記録します。
          </Note>
        </div>
      </div>
      <Warnings data={data} />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <a href={returnExportHref(year, "csv")} className={buttonClass({ size: "sm" })}>
          CSV を書き出す
        </a>
        <a href={returnExportHref(year, "pdf")} className={buttonClass({ size: "sm" })}>
          PDF を書き出す
        </a>
        <span className="text-[12px] text-muted">
          CSV は全資産・増加資産・減少資産を区分の列つきで 1 つに、PDF は種類別明細書の 2 表です。
        </span>
      </div>

      <Section id="return-all" title="全資産" total={totalText(data.totals.all)}>
        {data.all.length === 0 ? (
          <Empty>1 月 1 日に持っている対象の資産はありません。</Empty>
        ) : (
          <ReturnRows
            label="全資産"
            rows={data.all}
            reasonHeader="増加事由"
            reasonOf={(row) => row.increaseReason}
          />
        )}
      </Section>
      <Section
        id="return-increased"
        title="増加資産"
        total={totalText(data.totals.increased)}
        description={
          <Note>
            {period} に取得した資産です。
            {data.firstReturn && data.all.length > 0
              ? "前年の 1 月 1 日に対象の資産がないため、全資産が増加資産です。"
              : ""}
          </Note>
        }
      >
        {data.increased.length === 0 ? (
          <Empty>増加資産はありません。</Empty>
        ) : (
          <ReturnRows
            label="増加資産"
            rows={data.increased}
            reasonHeader="増加事由"
            reasonOf={(row) => row.increaseReason}
          />
        )}
      </Section>
      <Section
        id="return-decreased"
        title="減少資産"
        total={totalText(data.totals.decreased)}
        description={
          <Note>
            {period} に除却・売却した、前年の申告の対象の資産です。除却は「滅失」としています。
          </Note>
        }
      >
        {data.decreased.length === 0 ? (
          <Empty>減少資産はありません。</Empty>
        ) : (
          <ReturnRows
            label="減少資産"
            rows={data.decreased}
            reasonHeader="減少の事由・区分"
            reasonOf={(row) =>
              row.decrease ? `${row.decrease.reason}・${row.decrease.scope}` : null
            }
          />
        )}
      </Section>
      <Section
        id="return-excluded"
        title="対象外"
        total={totalText(data.totals.excluded)}
        description={
          <Note>
            1 月 1 日に持っている資産のうち申告しないもの。少額（10
            万円未満）・一括償却・ソフトウェアは規則で外れます。車両などは資産の詳細で「申告の対象外」に理由を入れて外します。
          </Note>
        }
      >
        {data.excluded.length === 0 ? (
          <Empty>対象外の資産はありません。</Empty>
        ) : (
          <ExcludedRows rows={data.excluded} />
        )}
      </Section>
      <p className="mt-4 text-[12px] break-words text-muted">
        減価残存率・価額・課税標準額は市町村が計算します（一般方式）。免税点（課税標準額の合計 150
        万円未満）も市町村が判定するため、未満でも申告するものとして出しています。
      </p>
    </>
  );
}
