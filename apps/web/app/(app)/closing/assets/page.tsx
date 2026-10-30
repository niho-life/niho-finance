import {
  FIXED_ASSET_STATUS_LABELS,
  listFixedAssets,
  type FixedAssetListRow,
} from "@niho-finance/db";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatAmountDisplay, formatDate, formatYenDisplay } from "@/lib/format";
import { methodLabel } from "./_components/asset-kit";

export const metadata: Metadata = { title: "固定資産台帳" };

const COLUMNS = {
  columns: "minmax(0,1.4fr) minmax(0,1fr) 92px 112px minmax(0,1.2fr) 120px minmax(64px,0.6fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function methodText(row: FixedAssetListRow): string {
  const label = methodLabel(row.method, row.cost);
  return row.usefulLifeYears !== null ? `${label}（${row.usefulLifeYears} 年）` : label;
}

function AssetRow({ row }: { row: FixedAssetListRow }) {
  const voided = row.status === "voided";
  const status = FIXED_ASSET_STATUS_LABELS[row.status];
  return (
    <TableRow {...COLUMNS} muted={voided} className="relative hover:bg-black/[0.02]">
      <Td>
        <Link
          href={`/closing/assets/${row.id}`}
          className="font-semibold break-words after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
        >
          {row.name}
        </Link>
      </Td>
      <Td sm="hide" className="truncate text-[13px]">
        {row.accountName}
      </Td>
      <Td sm="hide" className="num text-[13px]">
        {formatDate(row.acquisitionDate)}
      </Td>
      <Td sm="hide" align="right">
        {formatYenDisplay(row.cost)}
      </Td>
      <Td sm="hide" className="text-[13px]">
        {methodText(row)}
      </Td>
      <Td align="right" className="font-bold">
        {formatAmountDisplay(row.bookValue)}
      </Td>
      <Td sm="hide" className="text-[12px] text-muted">
        {status}
      </Td>
      <span role="cell" className="col-span-full min-w-0 text-[12px] text-muted md:hidden">
        {row.accountName} · <span className="num">{formatDate(row.acquisitionDate)}</span>
        {row.status !== "active" ? ` · ${status}` : ""}
      </span>
    </TableRow>
  );
}

/** 固定資産台帳 (16 §5): newest acquisition first; voided registrations folded. */
export default async function FixedAssetsPage({ searchParams }: PageProps<"/closing/assets">) {
  const query = await searchParams;
  const showVoided = query.voided === "1";
  const list = await listFixedAssets(await db(), { includeVoided: showVoided });
  const register = (
    <ButtonLink href="/closing/assets/new" variant="primary" size="sm">
      固定資産を登録
    </ButtonLink>
  );
  // 償却資産申告 (§14.4): a January task, entered from the ledger rather than the checklist.
  const returnLink = (
    <ButtonLink href="/closing/assets/return" variant="secondary" size="sm">
      償却資産申告を開く
    </ButtonLink>
  );
  const bookValueHeader = list.fiscalYear
    ? `帳簿価額（第 ${list.fiscalYear.no} 期末・円）`
    : "帳簿価額（円）";

  return (
    <>
      <PageHeader
        title="固定資産台帳"
        back={{ href: "/closing", label: "決算" }}
        actions={
          list.rows.length > 0 || list.voidedCount > 0 ? (
            <>
              {returnLink}
              {register}
            </>
          ) : undefined
        }
      />
      {list.rows.length === 0 && list.voidedCount === 0 ? (
        <EmptyState
          title="固定資産がありません"
          description="10 万円以上の備品やソフトウェアを買ったら登録します"
          action={register}
        />
      ) : (
        <>
          {list.rows.length === 0 ? (
            <EmptyState
              title="使用中の固定資産がありません"
              description="取り消した登録だけがあります"
              action={register}
            />
          ) : (
            <Table label="固定資産台帳">
              <TableHead {...COLUMNS}>
                <Th>名称</Th>
                <Th sm="hide">科目</Th>
                <Th sm="hide">取得日</Th>
                <Th align="right" sm="hide">
                  取得価額（円）
                </Th>
                <Th sm="hide">償却方法（耐用年数）</Th>
                <Th align="right">{bookValueHeader}</Th>
                <Th sm="hide">状態</Th>
              </TableHead>
              {list.rows.map((row) => (
                <AssetRow key={row.id} row={row} />
              ))}
            </Table>
          )}
          {list.voidedCount > 0 ? (
            <p className="mt-3 text-[13px]">
              <Link
                href={showVoided ? "/closing/assets" : "/closing/assets?voided=1"}
                className="font-bold text-muted underline underline-offset-4 hover:text-text"
              >
                {showVoided ? "取消を隠す" : `取消 ${list.voidedCount} 件を表示`}
              </Link>
            </p>
          ) : null}
          <p className="mt-2 text-[12px] text-muted">
            帳簿価額は今日を含む期の期末の額です（計上していない償却は予定の額で数えます）。
          </p>
        </>
      )}
    </>
  );
}
